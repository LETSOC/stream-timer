import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const LOOP = path.join(process.cwd(), "scripts", "relay-loop.sh")

function runLoop(env: Record<string, string>, script: string, ms: number): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-loop-"))
  const log = path.join(dir, "loop.log")
  const out = fs.openSync(log, "a")
  const child = spawn("bash", [LOOP, "test", "--", "bash", "-c", script], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, ...env, ...(env.LOOP_WATCH_LOG === "self" ? { LOOP_WATCH_LOG: log } : {}) } })
  fs.closeSync(out)
  return new Promise((resolve) => setTimeout(() => {
    try { process.kill(-child.pid!, "SIGTERM") } catch { /* gone */ }
    setTimeout(() => { const text = fs.readFileSync(log, "utf8"); fs.rmSync(dir, { recursive: true, force: true }); resolve(text) }, 300)
  }, ms))
}

test("redacting loop reports the child's own exit code and hides keys", async () => {
  const text = await runLoop({ LOOP_REDACT: "1", LOOP_MAX_DELAY: "1" }, "echo 'to rtmp://ingest.example/live/SECRETKEY'; exit 7", 1500)
  assert.match(text, /exited \(code 7 /)
  assert.match(text, /rtmp:\/\/ingest\.example\/\[redacted\]/)
  assert.doesNotMatch(text, /SECRETKEY/)
})

test("max delay caps the retry wait", async () => {
  const text = await runLoop({ LOOP_MAX_DELAY: "1" }, "exit 1", 4000)
  assert.match(text, /max retry wait 1s/)
  assert.ok((text.match(/exited \(code 1/g) ?? []).length >= 3, text)
  assert.doesNotMatch(text, /restarting in 2s/)
})

test("stall watchdog kills a child whose total_size stops growing", async () => {
  const text = await runLoop({ LOOP_REDACT: "1", LOOP_WATCH_LOG: "self", LOOP_STALL_GRACE: "1", LOOP_STALL_SECS: "3", LOOP_MAX_DELAY: "30" },
    "for i in 1 2; do echo total_size=$i; sleep 1; done; while :; do echo total_size=2; sleep 1; done", 13000)
  assert.match(text, /no data sent for \d+s \(stalled\); killing to reconnect/)
  assert.match(text, /exited \(code 143 /)
})

test("watchdog leaves a child alone while bytes keep growing", async () => {
  const text = await runLoop({ LOOP_WATCH_LOG: "self", LOOP_STALL_GRACE: "1", LOOP_STALL_SECS: "3" }, "i=0; while :; do i=$((i+1)); echo total_size=$i; sleep 1; done", 9000)
  assert.doesNotMatch(text, /stalled/)
})
