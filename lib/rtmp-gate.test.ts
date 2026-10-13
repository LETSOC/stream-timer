import assert from "node:assert/strict"
import { test } from "node:test"
import { decideRtmpCommand, parseConnectError, RTMP_COOLDOWN_MS } from "@/lib/encoder"

const now = 1_800_000_000_000
const base = { inFlight: null, running: false, last: null, now } as const

test("same command twice: no relaunch, no double stop", () => {
  assert.equal(decideRtmpCommand({ ...base, kind: "start", inFlight: "start" }).action, "reject")
  assert.equal(decideRtmpCommand({ ...base, kind: "stop", inFlight: "stop" }).action, "reject")
  assert.equal(decideRtmpCommand({ ...base, kind: "start", running: true }).action, "noop")
  assert.equal(decideRtmpCommand({ ...base, kind: "stop", running: false }).action, "noop")
})

test("opposite command while one is in flight is refused (409)", () => {
  const gate = decideRtmpCommand({ ...base, kind: "stop", running: true, inFlight: "start" })
  assert.equal(gate.action, "reject")
  assert.equal(gate.action === "reject" && gate.status, 409)
})

test("cooldown between opposing commands (429), then allowed", () => {
  const soon = decideRtmpCommand({ ...base, kind: "stop", running: true, last: { kind: "start", at: now - 500 } })
  assert.equal(soon.action === "reject" && soon.status, 429)
  const later = decideRtmpCommand({ ...base, kind: "stop", running: true, last: { kind: "start", at: now - RTMP_COOLDOWN_MS - 1 } })
  assert.equal(later.action, "run")
  assert.equal(decideRtmpCommand({ ...base, kind: "start", last: { kind: "start", at: now - 10 } }).action, "run")
})

test("parseConnectError: fast fail before connecting names the host", () => {
  const log = `[supervisor 12:00:00] supervisor started (pid 1)
[flv @ 0x1] Failed to update header with correct duration.
rtmp://live.restream.io/live/…: End of file
Error opening output rtmp://…: End of file
[supervisor 12:00:01] ffmpeg exited (code 187) after 1s; restart #1 in 2s
`
  assert.match(parseConnectError(log, "live.restream.io") ?? "", /Can't connect to ingest \(live\.restream\.io\): (Error opening output|End of file)/)
})

test("parseConnectError: null once a later run is sending frames, or with no exits", () => {
  assert.equal(parseConnectError("[supervisor 1] supervisor started\nOutput #0\nframe=  10", "h"), null)
  const recovered = `[supervisor 1] supervisor started\nEnd of file\n[supervisor 2] ffmpeg exited (code 1) after 1s; restart #1 in 2s\nOutput #0, flv\nframe=   30 size= 100kB\n`
  assert.equal(parseConnectError(recovered, "h"), null)
})

test("supervisor gives up after RTMP_MAX_FAST_FAILS quick failures and writes the failure file", async () => {
  const { execFileSync } = await import("node:child_process")
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-test-"))
  fs.copyFileSync(path.join(process.cwd(), "scripts", "rtmp-supervisor.sh"), path.join(dir, "rtmp-supervisor.sh"))
  fs.writeFileSync(path.join(dir, "stream-countdown.sh"), "#!/usr/bin/env bash\necho 'Error opening output rtmp://x: End of file'\nexit 187\n")
  const failFile = path.join(dir, "fail.json")
  let code = 0
  try {
    execFileSync("bash", [path.join(dir, "rtmp-supervisor.sh")], {
      env: { ...process.env, RTMP_MAX_FAST_FAILS: "3", RTMP_MIN_DELAY: "0", RTMP_FAIL_FILE: failFile, RTMP_STATE_FILE: path.join(dir, "state.json") },
      timeout: 10_000,
      stdio: "pipe",
    })
  } catch (error) {
    code = (error as { status?: number }).status ?? -1
  }
  assert.equal(code, 3)
  const failure = JSON.parse(fs.readFileSync(failFile, "utf8")) as { error: string }
  assert.match(failure.error, /Gave up after 3 quick connection failures \(last ffmpeg exit code 187\)/)
})
