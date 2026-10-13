/**
 * Lifecycle regression tests for the HLS encoder, driven by a fake
 * stream-countdown.sh and a fake ffmpeg so they run anywhere bash runs.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, beforeEach, test } from "node:test"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stream-timer-test-"))
const bin = path.join(tmp, "bin")
const launches = path.join(tmp, "launches.log")
fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, "ffmpeg"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 })
const script = path.join(tmp, "stream-countdown.sh")
fs.writeFileSync(
  script,
  `#!/usr/bin/env bash
echo "$$" >> "${launches}"
case "\${FAKE_MODE:-normal}" in
  ignore) trap '' TERM; while true; do sleep 0.1; done ;;
  orphan) sleep 1000 & sleep 0.6; exit 0 ;;
  *) trap 'exit 0' TERM; sleep 1000 & wait ;;
esac
`,
  { mode: 0o755 },
)

process.env.STREAM_DATA_DIR = path.join(tmp, "data")
process.env.STREAM_SCRIPT = script
process.env.STREAM_SUPERVISOR = path.join(tmp, "rtmp-supervisor.sh")
process.env.STREAM_STOP_GRACE_MS = "400"
process.env.STREAM_STARTUP_WAIT_MS = "200"
const originalPath = process.env.PATH ?? ""
process.env.PATH = `${bin}:${originalPath}`

type Encoder = typeof import("./encoder.ts")
let enc: Encoder
const input = { eventName: "Hyphen", dateLine: "4 Nov", targetUnix: 1793784600, refreshSeconds: 0 }

const launchCount = () => (fs.existsSync(launches) ? fs.readFileSync(launches, "utf8").trim().split("\n").filter(Boolean).length : 0)
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}
const scriptPids = () => {
  try {
    return execFileSync("pgrep", ["-f", script], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number)
  } catch {
    return []
  }
}
const meta = () => JSON.parse(fs.readFileSync(path.join(tmp, "data", "encoder.json"), "utf8")) as { pid: number }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

before(async () => {
  enc = await import("./encoder.ts")
})
beforeEach(async () => {
  process.env.FAKE_MODE = "normal"
  await enc.stopEncoder()
  fs.rmSync(launches, { force: true })
})
after(async () => {
  await enc.stopEncoder()
  fs.rmSync(tmp, { recursive: true, force: true })
})

test("two simultaneous starts launch exactly one encoder", async () => {
  const [a, b] = await Promise.all([enc.startEncoder(input), enc.startEncoder(input)])
  assert.deepEqual([a.ok, b.ok].sort(), [false, true])
  const rejected = (a.ok ? b : a) as { status: number }
  assert.equal(rejected.status, 409)
  assert.equal(launchCount(), 1)
  assert.equal(scriptPids().length, 1)
})

test("restart issued while a stop is in progress waits for it, leaving one encoder", async () => {
  await enc.startEncoder(input)
  const oldPid = meta().pid
  await Promise.all([enc.stopEncoder(), enc.restartEncoder(input)])
  assert.equal(groupAlive(oldPid), false)
  assert.equal(scriptPids().length, 1)
  assert.notEqual(meta().pid, oldPid)
})

test("stop when already stopped is idempotent", async () => {
  const first = await enc.stopEncoder()
  const second = await enc.stopEncoder()
  assert.deepEqual(first, { forced: false, survived: false })
  assert.deepEqual(second, { forced: false, survived: false })
  assert.equal(enc.readStatus().running, false)
})

test("a process that ignores SIGTERM is SIGKILLed and the desk is told", async () => {
  process.env.FAKE_MODE = "ignore"
  const started = await enc.startEncoder(input)
  assert.equal(started.ok, true)
  const pid = meta().pid
  const result = await enc.stopEncoder()
  assert.deepEqual(result, { forced: true, survived: false })
  assert.equal(groupAlive(pid), false)
  assert.match(enc.readStatus().stopNote ?? "", /SIGKILL/)
})

test("an orphaned child is cleaned up through its process group", async () => {
  process.env.FAKE_MODE = "orphan"
  const started = await enc.startEncoder(input)
  assert.equal(started.ok, true)
  const pid = meta().pid
  await sleep(900) // leader exits after 0.6s, its `sleep 1000` child lives on
  assert.equal(groupAlive(pid), true, "orphan should still exist before cleanup")
  assert.equal(enc.readStatus().running, false) // status notices and reaps the group
  await sleep(700)
  assert.equal(groupAlive(pid), false)
})

test("auto-refresh during a manual restart results in one restart", async () => {
  await enc.startEncoder({ ...input, refreshSeconds: 1 })
  await sleep(1100) // slate is now stale
  await Promise.all([
    enc.restartEncoder({ ...input, refreshSeconds: 1 }),
    enc.maybeRefreshStaleSlate(),
    enc.maybeRefreshStaleSlate(),
  ])
  assert.equal(launchCount(), 2) // initial start + the manual restart only
  assert.equal(scriptPids().length, 1)
})

test("ffmpegAvailable caches a miss briefly and a fresh check bypasses it", () => {
  process.env.PATH = path.join(tmp, "empty")
  assert.equal(enc.ffmpegAvailable({ fresh: true }), false)
  process.env.PATH = `${bin}:${originalPath}`
  assert.equal(enc.ffmpegAvailable(), false, "negative result is cached")
  assert.equal(enc.ffmpegAvailable({ fresh: true }), true, "explicit start re-checks")
})

test("validateRtmpUrl accepts real ingests and rejects bad ones without echoing them", () => {
  for (const ok of [
    "rtmp://uk.castr.io/static/live_x?password=abc",
    "rtmps://live.example.com:443/app/key",
    "rtmp://127.0.0.1:1935/live/key",
  ]) assert.equal(enc.validateRtmpUrl(ok).ok, true, ok)
  const bad = [
    "",
    "http://uk.castr.io/static/x",
    "rtmp://user:SECRETPW@uk.castr.io/static/x",
    "rtmp://uk.castr.io/",
    "rtmp://bad_host!/live/x",
    "rtmp://uk.castr.io:99999/live/x",
    "rtmp://uk.castr.io/live/x SECRETPW",
    "javascript:alert(1)",
  ]
  for (const url of bad) {
    const result = enc.validateRtmpUrl(url)
    assert.equal(result.ok, false, url)
    if (!result.ok) assert.ok(!result.error.includes("SECRETPW"), "error must not leak credentials")
  }
})

test("deriveRtmpState maps supervisor + log to a state", () => {
  const started = "[supervisor 10:00:00] supervisor started (pid 1)\n"
  assert.equal(enc.deriveRtmpState(false, null, "", null), "stopped")
  assert.equal(enc.deriveRtmpState(false, null, "", "refused"), "failed")
  assert.equal(enc.deriveRtmpState(true, "waiting", started, null), "reconnecting")
  assert.equal(enc.deriveRtmpState(true, "running", started + "Input #0\n", null), "starting")
  assert.equal(enc.deriveRtmpState(true, "running", started + "Output #0, flv\nframe=  300 fps=30\n", null), "connected")
  const afterExit = started + "Output #0\nframe= 10\n[supervisor 10:01:00] ffmpeg exited (code 1) after 5s; restart #1 in 2s\n"
  assert.equal(enc.deriveRtmpState(true, "running", afterExit, null), "starting")
})

test("deriveRtmpState: long streams, stale logs and connect timeout", () => {
  // Long run: "Output #0" has scrolled out of the tail, only progress lines remain.
  assert.equal(enc.deriveRtmpState(true, null, "frame= 90000 fps=30 size= 1000kB\n", null, { logAgeMs: 5000 }), "connected")
  assert.equal(enc.deriveRtmpState(true, "running", "frame= 9 fps=30\n", null, { logAgeMs: 60_000 }), "stalled")
  const started = "[supervisor 10:00:00] supervisor started (pid 1)\nInput #0\n"
  assert.equal(enc.deriveRtmpState(true, "running", started, null, { logAgeMs: 1000, runAgeMs: 10_000 }), "starting")
  assert.equal(enc.deriveRtmpState(true, "running", started, null, { logAgeMs: 1000, runAgeMs: 60_000 }), "stalled")
})

test("parseOwnSupervisors only matches this project's group leaders", () => {
  const sup = "/Users/c/stream-timer/scripts/rtmp-supervisor.sh"
  const ps = [
    `  100   100 bash ${sup}`,
    `  101   100 /opt/homebrew/bin/ffmpeg -re -i x -f flv rtmp://a/b`,
    `  200   200 bash /Users/c/other-checkout/scripts/rtmp-supervisor.sh`,
    `  300   250 bash ${sup}`,
    `  400   400 /bin/bash ${sup}`,
    `  500   500 vim ${sup}`,
  ].join("\n")
  assert.deepEqual(enc.parseOwnSupervisors(ps, sup), [100, 400])
})
