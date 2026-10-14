import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { buildMediamtxConfig, credentials, deriveForwardState, forwardConflict, isRelayUrl, parseRelayLoops, readSettings, relayDir, relayPublishUrl } from "./relay.ts"
import { parseOwnSupervisorList } from "./encoder.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-relay-"))
process.env.STREAM_DATA_DIR = dir

test("relay is off by default with no forwards", () => {
  assert.deepEqual(readSettings(), { enabled: false, forwards: { slate: [], capture: [] }, programArmed: false })
})

test("credentials are random, stable, and stored 0600", () => {
  const first = credentials()
  assert.ok(first.publishPass.length >= 20 && first.readPass !== first.publishPass)
  assert.deepEqual(credentials(), first)
  assert.equal(fs.statSync(path.join(relayDir(), "credentials.json")).mode & 0o777, 0o600)
  assert.ok(isRelayUrl(relayPublishUrl("slate")))
  assert.ok(!isRelayUrl("rtmp://live.castr.io/static/KEY"))
})

test("config binds every listener to the given host and restricts users to localhost", () => {
  const yml = buildMediamtxConfig({ host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds: { publishUser: "p", publishPass: "pp", readUser: "r", readPass: "rr" } })
  for (const line of yml.split("\n").filter((l) => /Address:/.test(l))) assert.match(line, /127\.0\.0\.1:\d+$/)
  assert.match(yml, /webrtc: no/)
  assert.match(yml, /moq: no/)
  assert.match(yml, /authMethod: internal/)
  assert.equal((yml.match(/ips: \['127\.0\.0\.1\/32', '::1\/128'\]/g) ?? []).length, 2)
  assert.match(yml, /  slate: \{\}\n  capture: \{\}\n  program: \{\}/)
  // Internal publisher limited to slate/capture; no OBS login while disarmed.
  assert.match(yml, /permissions: \[\{ action: publish, path: slate \}, \{ action: publish, path: capture \}\]/)
  assert.doesNotMatch(yml, /path: program/)
})

test("armed: OBS gets its own login, publish on /program only, loopback only", () => {
  const creds = { publishUser: "p", publishPass: "pp", readUser: "r", readPass: "rr", programUser: "obs_x", programPass: "secretobs" }
  const yml = buildMediamtxConfig({ host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds, programArmed: true })
  const block = yml.split("  - user: ").find((b) => b.startsWith('"obs_x"')) ?? ""
  assert.match(block, /pass: "secretobs"/)
  assert.match(block, /ips: \['127\.0\.0\.1\/32', '::1\/128'\]/)
  assert.match(block, /permissions: \[\{ action: publish, path: program \}\]$/m)
  assert.doesNotMatch(block, /read|api/)
  const fresh = credentials()
  assert.ok(fresh.programUser?.startsWith("obs_") && (fresh.programPass?.length ?? 0) >= 20 && fresh.programPass !== fresh.publishPass)
})

test("relay loops are found by this checkout's script path and tagged", () => {
  const loop = "/app/scripts/relay-loop.sh"
  const ps = [`  10  10 bash ${loop} mediamtx -- /bin/mediamtx /data/relay/mediamtx.yml`, `  20  20 bash ${loop} forward:slate:abc:dest=0123456789abcdef -- ffmpeg`, `  21  20 ffmpeg -i rtmp://x`, `  30  30 bash /other/relay-loop.sh mediamtx`].join("\n")
  assert.deepEqual(parseRelayLoops(ps, loop), [{ pid: 10, tag: "mediamtx" }, { pid: 20, tag: "forward:slate:abc:dest=0123456789abcdef" }])
})

test("same-destination guard across relay paths and direct channels", () => {
  assert.match(forwardConflict({ path: "capture", dest: "aa" }, [{ path: "slate", dest: "aa" }], []) ?? "", /\/slate already forwards/)
  assert.equal(forwardConflict({ path: "slate", dest: "aa" }, [{ path: "slate", dest: "aa" }], []), null)
  assert.match(forwardConflict({ path: "slate", dest: "aa" }, [], [{ channel: "capture", running: true, dest: "aa" }]) ?? "", /Browser capture stream publishes/)
  assert.equal(forwardConflict({ path: "slate", dest: "aa" }, [], [{ channel: "capture", running: false, dest: "aa" }]), null)
  assert.equal(forwardConflict({ path: "slate", dest: "aa" }, [], [{ channel: "slate", running: true, dest: "aa", relay: true }]), null)
})

test("forward state", () => {
  const base = { running: true, loop: { state: "running" as const, restarts: 0, updatedAt: 0, lastExit: null }, sourceReady: true, logAgeMs: 1000, lastLine: "progress=continue", runAgeMs: 5000 }
  assert.equal(deriveForwardState(base), "forwarding")
  assert.equal(deriveForwardState({ ...base, running: false }), "off")
  assert.equal(deriveForwardState({ ...base, sourceReady: false }), "waiting")
  assert.equal(deriveForwardState({ ...base, loop: { ...base.loop, state: "waiting" } }), "retrying")
  assert.equal(deriveForwardState({ ...base, logAgeMs: 30_000 }), "stalled")
  assert.equal(deriveForwardState({ ...base, lastLine: "Output #0, flv" }), "connecting")
  assert.equal(deriveForwardState({ ...base, lastLine: "Output #0, flv", runAgeMs: 30_000 }), "stalled")
})

test("channel supervisors remember they publish via the relay", () => {
  const [one] = parseOwnSupervisorList("  5  5 bash /s/rtmp-supervisor.sh capture dest=0123456789abcdef via=relay", "/s/rtmp-supervisor.sh")
  assert.deepEqual(one, { pid: 5, channel: "capture", dest: "0123456789abcdef", relay: true })
  fs.rmSync(dir, { recursive: true, force: true })
})
