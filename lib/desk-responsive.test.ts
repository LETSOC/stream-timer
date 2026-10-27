import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { deadlineSignal, fetchT, keepIfSame } from "./fetch-timeout.ts"
import { pollDelay, startPoll, type PollDoc } from "./poll.ts"
import { cmdlineToCommand, listProcesses, parseProcStat, procCommand, procList } from "./proc-list.ts"
import { parseRelayLoops } from "./relay.ts"
import { pidRunsScript } from "./encoder.ts"

/** Fake timers + document: drive the poll loop by hand. */
function harness(initial: DocumentVisibilityState = "visible") {
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  const listeners = new Set<() => void>()
  const doc: PollDoc & { visibilityState: DocumentVisibilityState } = {
    visibilityState: initial,
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
  }
  return {
    doc,
    timers,
    listeners,
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { fn, ms }); return id },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    fire() { const [id, t] = [...timers.entries()][0]; timers.delete(id); t.fn() },
    setVisible(v: DocumentVisibilityState) { doc.visibilityState = v; for (const l of [...listeners]) l() },
  }
}
const flush = () => new Promise((r) => setImmediate(r))

test("pollDelay: normal interval, doubles after failures, capped", () => {
  assert.equal(pollDelay(2000, 0), 2000)
  assert.equal(pollDelay(2000, 1), 4000)
  assert.equal(pollDelay(2000, 2), 8000)
  assert.equal(pollDelay(2000, 3), 15000)
  assert.equal(pollDelay(2000, 9), 15000)
  assert.equal(pollDelay(1000, 3), 8000)
  assert.equal(pollDelay(30000, 2), 30000) // never shorter than the interval
})

test("startPoll: never overlaps; the next tick is scheduled only after the previous settles", async () => {
  const h = harness()
  let running = 0
  let maxRunning = 0
  let release: (() => void) | null = null
  const tick = () => new Promise<void>((resolve) => { running++; maxRunning = Math.max(maxRunning, running); release = () => { running--; resolve() } })
  const stop = startPoll(tick, 1000, { doc: h.doc, setTimer: h.setTimer, clearTimer: h.clearTimer })
  await flush()
  assert.equal(running, 1)
  assert.equal(h.timers.size, 0, "no timer while a tick is in flight")
  h.setVisible("visible") // a visibility event mid-tick must not start a second one
  assert.equal(running, 1)
  release!()
  await flush()
  assert.equal(h.timers.size, 1)
  assert.equal([...h.timers.values()][0].ms, 1000)
  h.fire()
  await flush()
  assert.equal(maxRunning, 1)
  stop()
  release!()
  await flush()
  assert.equal(h.timers.size, 0, "stopped: nothing scheduled")
})

test("startPoll: backs off after failures, resets on success", async () => {
  const h = harness()
  const results: unknown[] = [false, "throw", false, true]
  const tick = async () => { const r = results.shift(); if (r === "throw") throw new Error("x"); return r }
  startPoll(tick, 1000, { doc: h.doc, setTimer: h.setTimer, clearTimer: h.clearTimer })
  const delays: number[] = []
  for (let i = 0; i < 4; i++) {
    await flush()
    delays.push([...h.timers.values()][0].ms)
    h.fire()
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 1000])
})

test("startPoll: paused while hidden, runs at once when visible again", async () => {
  const h = harness("hidden")
  let ticks = 0
  const stop = startPoll(async () => { ticks++ }, 1000, { doc: h.doc, setTimer: h.setTimer, clearTimer: h.clearTimer })
  await flush()
  assert.equal(ticks, 0)
  assert.equal(h.timers.size, 0)
  h.setVisible("visible")
  await flush()
  assert.equal(ticks, 1)
  h.doc.visibilityState = "hidden"
  h.fire() // the timer fires while hidden: no request, no new timer
  await flush()
  assert.equal(ticks, 1)
  assert.equal(h.timers.size, 0)
  stop()
  assert.equal(h.listeners.size, 0)
})

test("keepIfSame keeps the old object when the content is equal", () => {
  const a = { x: 1, y: [1, 2] }
  assert.equal(keepIfSame(a, { x: 1, y: [1, 2] }), a)
  const b = { x: 2, y: [1, 2] }
  assert.equal(keepIfSame(a, b), b)
  assert.equal(keepIfSame(null, null), null)
})

test("deadlineSignal aborts after the deadline, and forwards the caller's abort", async () => {
  const s = deadlineSignal(20)
  assert.equal(s.aborted, false)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(s.aborted, true)
  const own = new AbortController()
  const both = deadlineSignal(10_000, own.signal)
  own.abort()
  assert.equal(both.aborted, true)
})

test("fetchT rejects instead of hanging on a server that never answers", async () => {
  const http = await import("node:http")
  const server = http.createServer(() => { /* never responds */ })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as { port: number }
  const started = Date.now()
  await assert.rejects(fetchT(`http://127.0.0.1:${port}/`, {}, 150))
  assert.ok(Date.now() - started < 3000)
  server.closeAllConnections()
  server.close()
})

test("proc-list: parses /proc stat and cmdline like ps", () => {
  assert.equal(cmdlineToCommand("bash\0/x/scripts/relay-loop.sh\0mediamtx\0--\0mediamtx\0"), "bash /x/scripts/relay-loop.sh mediamtx -- mediamtx")
  assert.equal(cmdlineToCommand(""), "")
  assert.deepEqual(parseProcStat("42 (bash) S 1 42 42 0 -1"), { pgid: 42, comm: "bash" })
  // comm with spaces and parens
  assert.deepEqual(parseProcStat("7 (my (odd) proc) R 1 3 3 0"), { pgid: 3, comm: "my (odd) proc" })
  assert.equal(parseProcStat("garbage"), null)
})

test("proc-list: a fake /proc lists processes in ps format, relay loops parse the same", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "st-proc-"))
  const add = (pid: number, pgid: number, comm: string, argv: string[]) => {
    fs.mkdirSync(path.join(root, String(pid)))
    fs.writeFileSync(path.join(root, String(pid), "stat"), `${pid} (${comm}) S 1 ${pgid} ${pgid} 0 -1`)
    fs.writeFileSync(path.join(root, String(pid), "cmdline"), argv.length ? `${argv.join("\0")}\0` : "")
  }
  fs.mkdirSync(path.join(root, "self"))
  fs.writeFileSync(path.join(root, "self", "cmdline"), "node\0")
  const loop = "/x/scripts/relay-loop.sh"
  add(10, 10, "bash", ["bash", loop, "mediamtx", "--", "mediamtx"])
  add(11, 10, "mediamtx", ["mediamtx"])
  add(20, 20, "bash", ["/bin/bash", loop, "forward:slate:abc:dest=0123456789abcdef", "--", "ffmpeg"])
  add(30, 30, "kworker/0:1", [])
  fs.mkdirSync(path.join(root, "not-a-pid"))
  const list = procList(root)!
  assert.match(list, /^30 30 \[kworker\/0:1\]$/m)
  assert.deepEqual(parseRelayLoops(list, loop), [{ pid: 10, tag: "mediamtx" }, { pid: 20, tag: "forward:slate:abc:dest=0123456789abcdef" }])
  assert.equal(procCommand(10, root), `bash ${loop} mediamtx -- mediamtx`)
  assert.equal(procCommand(30, root), "")
  assert.equal(procCommand(99, root), null)
  assert.equal(procList(path.join(root, "nope")), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test("pidRunsScript and listProcesses see a real child process", async () => {
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "st-pid-")), "fake-loop.sh")
  fs.writeFileSync(script, "sleep 5\n")
  const child = spawn("bash", [script], { stdio: "ignore" })
  await new Promise((r) => setTimeout(r, 150))
  try {
    assert.equal(pidRunsScript(child.pid!, script), true)
    assert.equal(pidRunsScript(child.pid!, "/elsewhere/other-script.sh"), false)
    assert.equal(pidRunsScript(process.pid, script), false)
    const list = listProcesses()
    assert.ok(list && new RegExp(`^${child.pid} \\d+ bash ${script.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m").test(list))
  } finally {
    child.kill("SIGKILL")
  }
  await new Promise((r) => child.once("exit", r))
  assert.equal(pidRunsScript(child.pid!, script), false)
})
