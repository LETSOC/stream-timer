import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { buildMediamtxConfig, credentials, validPullUrl, pickLanIp, parseIngestLog, liveConfigMatches, rotateProgramCredentials, deriveForwardState, forwardConflict, isRelayUrl, parseRelayLoops, readSettings, relayDir, relayPublishUrl } from "./relay.ts"
import { parseOwnSupervisorList } from "./encoder.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-relay-"))
process.env.STREAM_DATA_DIR = dir

test("relay is off by default with no forwards", () => {
  assert.deepEqual(readSettings(), { enabled: false, forwards: { slate: [], capture: [] }, programArmed: false, backupPullUrl: "", failover: { auto: false, stallSec: 3, returnSec: 10, autoReturn: true }, lanIngest: false })
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
  assert.match(yml, /  slate: \{\}\n  capture: \{\}\n  program: \{ overridePublisher: yes \}/)
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

test("program audio track: present (tracks2 or names) vs none", async () => {
  const { programAudioTrack } = await import("@/lib/relay")
  assert.deepEqual(programAudioTrack({ tracks: ["H264", "MPEG-4 Audio"], tracks2: [{ codec: "H264", codecProps: { width: 1280, height: 720 } }, { codec: "MPEG-4 Audio", codecProps: { sampleRate: 48000, channelCount: 2 } }] }), { codec: "AAC", channels: 2, sampleRate: 48000 })
  assert.deepEqual(programAudioTrack({ tracks: ["H264", "Opus"] }), { codec: "Opus", channels: null, sampleRate: null })
  assert.equal(programAudioTrack({ tracks: ["H264"], tracks2: [{ codec: "H264", codecProps: { width: 1280, height: 720 } }] }), null)
})

test("program backup: own publish login, or a pull source; pull URLs validated", () => {
  const creds = { publishUser: "p", publishPass: "pp", readUser: "r", readPass: "rr", programUser: "obs", programPass: "op", backupUser: "bak", backupPass: "bp" }
  const ports = { rtmp: 19350, hls: 18888, api: 19997 }
  const pub = buildMediamtxConfig({ host: "127.0.0.1", ports, creds, programArmed: true })
  assert.match(pub, /user: "bak"[\s\S]*permissions: \[\{ action: publish, path: program-backup \}\]/)
  assert.match(pub, /\n  program-backup: \{ overridePublisher: yes \}/)
  const pulled = buildMediamtxConfig({ host: "127.0.0.1", ports, creds, programArmed: true, backupPullUrl: "rtmp://example.com/live/key" })
  assert.doesNotMatch(pulled, /user: "bak"/)
  assert.match(pulled, /program-backup: \{ source: "rtmp:\/\/example.com\/live\/key", sourceOnDemand: no \}/)
  const off = buildMediamtxConfig({ host: "127.0.0.1", ports, creds, programArmed: false, backupPullUrl: "rtmp://example.com/x" })
  assert.doesNotMatch(off, /user: "bak"|source:/)
  assert.ok(validPullUrl("https://cdn.example.com/hls/index.m3u8"))
  assert.ok(!validPullUrl("file:///etc/passwd"))
  assert.ok(!validPullUrl("rtmp://x/y\n  evil: 1"))
  assert.ok(!validPullUrl("rtmp://x/{a}"))
})

test("LAN ingest: RTMP on the ingest host, only OBS logins from anywhere (publish-only), reads/API/internal stay loopback", () => {
  const creds = { publishUser: "p", publishPass: "pp", readUser: "r", readPass: "rr", programUser: "obs", programPass: "op", backupUser: "bak", backupPass: "bp" }
  const ports = { rtmp: 19350, hls: 18888, api: 19997 }
  const lan = buildMediamtxConfig({ host: "127.0.0.1", ports, creds, programArmed: true, ingestHost: "0.0.0.0" })
  assert.match(lan, /rtmpAddress: 0\.0\.0\.0:19350/)
  assert.match(lan, /hlsAddress: 127\.0\.0\.1:18888/)
  assert.match(lan, /apiAddress: 127\.0\.0\.1:19997/)
  assert.match(lan, /user: "obs"\n.*\n    ips: \['0\.0\.0\.0\/0', '::\/0'\]\n    permissions: \[\{ action: publish, path: program \}\]/)
  assert.match(lan, /user: "bak"\n.*\n    ips: \['0\.0\.0\.0\/0', '::\/0'\]\n    permissions: \[\{ action: publish, path: program-backup \}\]/)
  assert.match(lan, /user: "r"\n.*\n    ips: \['127\.0\.0\.1\/32', '::1\/128'\]/)
  assert.match(lan, /user: "p"\n.*\n    ips: \['127\.0\.0\.1\/32', '::1\/128'\]/)
  // Not armed: ingest stays local even with the setting on
  assert.match(buildMediamtxConfig({ host: "127.0.0.1", ports, creds, programArmed: false, ingestHost: "0.0.0.0" }), /rtmpAddress: 127\.0\.0\.1:19350/)
  assert.doesNotMatch(buildMediamtxConfig({ host: "127.0.0.1", ports, creds, programArmed: true }), /0\.0\.0\.0/)
  assert.equal(pickLanIp({ lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }], utun3: [{ family: "IPv4", address: "10.8.0.2", internal: false }], en0: [{ family: "IPv6", address: "fe80::1", internal: false }, { family: "IPv4", address: "192.168.1.23", internal: false }] }), "192.168.1.23")
  assert.equal(pickLanIp({ lo: [{ family: 4, address: "127.0.0.1", internal: true }] }), null)
})

test("New key rotates one input only; program paths let a reconnecting OBS take over", async () => {
  const before = credentials()
  await rotateProgramCredentials("main")
  const a = credentials()
  assert.notEqual(a.programPass, before.programPass)
  assert.equal(a.backupPass, before.backupPass)
  await rotateProgramCredentials("backup")
  const b = credentials()
  assert.equal(b.programPass, a.programPass)
  assert.notEqual(b.backupPass, a.backupPass)
  const yml = buildMediamtxConfig({ host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds: b, programArmed: true })
  assert.match(yml, /\n  program: \{ overridePublisher: yes \}/)
  assert.match(yml, /\n  program-backup: \{ overridePublisher: yes \}/)
})

test("parseIngestLog: listener address and last refused publish (redacted)", () => {
  const log = [
    "2026/10/15 00:14:20 INF [RTMP] listener opened on 127.0.0.1:19350",
    "2026/10/15 00:14:40 INF [RTMP] started with listener on 0.0.0.0:19350 (TCP/RTMP)",
    "2026/10/15 00:14:58 WAR [RTMP] [conn 192.168.1.40:57022] failed to authenticate: authentication failed",
    "2026/10/15 00:15:00 INF [RTMP] [conn 192.168.1.40:57022] closed: failed to authenticate: authentication failed",
    "2026/10/15 00:15:30 INF [RTMP] [conn 192.168.1.40:57030] closed: terminated",
    "2026/10/15 00:16:10 INF [RTMP] [conn 127.0.0.1:61022] closed: read tcp 127.0.0.1:19350->127.0.0.1:61022: read: connection reset by peer",
    "2026/10/15 00:16:12 INF [RTMP] [conn 127.0.0.1:61030] closed: EOF",
  ].join("\n")
  const r = parseIngestLog(log)
  assert.equal(r.listen, "0.0.0.0:19350")
  assert.equal(r.lastReject?.at, "2026/10/15 00:15:00")
  assert.match(r.lastReject?.text ?? "", /192\.168\.1\.40.*authentication failed/)
  assert.deepEqual(parseIngestLog(""), { listen: null, lastReject: null })
})

test("liveConfigMatches: catches a missed MediaMTX reload (old bind or old key)", () => {
  const creds = { publishUser: "p", publishPass: "pp", readUser: "r", readPass: "rr", programUser: "obs", programPass: "op", backupUser: "bak", backupPass: "bp" }
  const yml = buildMediamtxConfig({ host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds, programArmed: true, ingestHost: "0.0.0.0" })
  const users = ["p", "obs", "bak", "r"].map((user) => ({ user }))
  assert.ok(liveConfigMatches(yml, { rtmpAddress: "0.0.0.0:19350", authInternalUsers: users }))
  assert.ok(!liveConfigMatches(yml, { rtmpAddress: "127.0.0.1:19350", authInternalUsers: users }))
  assert.ok(!liveConfigMatches(yml, { rtmpAddress: "0.0.0.0:19350", authInternalUsers: ["p", "obs_old", "bak", "r"].map((user) => ({ user })) }))
})
