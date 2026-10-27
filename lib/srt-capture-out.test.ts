import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { buildMediamtxConfig, captureReadLogin, parseIngestLog, readerKickTargets, readSettings, relayDir, rotateCaptureReadLogin, setSrtCaptureOut, srtListenerOn } from "@/lib/relay"
import { captureSrtReveal, captureSrtUrl } from "@/lib/srt-urls"

process.env.STREAM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "st-capture-out-"))

const creds = { publishUser: "p", publishPass: "pp", readUser: "r", readPass: "rr", programUser: "obs", programPass: "op", backupUser: "bak", backupPass: "bp", verticalUser: "v", verticalPass: "vp" }
const base = { host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds, programArmed: true }
const webrtc = { httpPort: 18889, iceHost: "127.0.0.1", icePort: 18189, additionalHosts: ["192.168.0.24"] }
const out = { port: 8890, passphrase: "", user: "out_u", pass: "out_p" }
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex")

// sha256 of buildMediamtxConfig output on feat/desk-responsive (5e28fff), before /capture read-out existed.
const BEFORE: [string, Parameters<typeof buildMediamtxConfig>[0], string][] = [
  ["default", base, "ad9e9b4f9af2415751eddc75ed2c2f1d1a7601ab3a3e22e56382da7918f75314"],
  ["disarmed", { ...base, programArmed: false }, "5ab516876cd00d4171ae12a9118d63562b5b6042b5ac5afe46fbedf047d5e497"],
  ["lan + Main/Backup SRT + WebRTC", { ...base, ingestHost: "0.0.0.0", srt: { port: 8890, passphrase: "backup-secret" }, srtMain: { port: 8890, passphrase: "main-secret-1" }, webrtc }, "0e7902991d2eebb62f113b71e3d24565cb49d5f84a5a48fec88ea1ff885845f5"],
  ["backup pulled + Main SRT", { ...base, backupPullUrl: "rtmp://10.0.0.2/live/x", srtMain: { port: 8890, passphrase: "" } }, "efff77090083f70aac9c73b01bd6b1e6ad8c1c63f130e558de1e9831d12769d2"],
  ["lan, Main disarmed", { ...base, ingestHost: "0.0.0.0", disarmed: { main: true, backup: false }, webrtc }, "8fa9159753db6c88483a7627a504578a1a4e179972e5349b624d02675f03427c"],
]

test("read-out off: mediamtx.yml byte-identical to before", () => {
  for (const [name, input, want] of BEFORE) {
    assert.equal(sha(buildMediamtxConfig(input)), want, name)
    assert.equal(buildMediamtxConfig({ ...input, captureOut: undefined }), buildMediamtxConfig(input), name)
  }
})

test("read-out on: one read-only login for /capture from any IP; internal logins stay loopback", () => {
  const yml = buildMediamtxConfig({ ...base, captureOut: out })
  assert.match(yml, /^srt: yes\nsrtAddress: 127\.0\.0\.1:8890$/m)
  assert.match(yml, /^  - user: "out_u"\n    pass: "out_p"\n    ips: \['0\.0\.0\.0\/0', '::\/0'\]\n    permissions: \[\{ action: read, path: capture \}\]$/m)
  assert.match(yml, /^  capture: \{\}$/m) // no passphrase
  for (const user of ["p", "v", "r"]) assert.match(yml, new RegExp(`user: "${user}"\\n    pass: "[^"]+"\\n    ips: \\['127\\.0\\.0\\.1/32', '::1/128'\\]`))
  // Only additions: removing the new lines (and the listener) gives the old config back.
  const off = buildMediamtxConfig(base)
  const stripped = yml.replace(/^  - user: "out_u"\n(?:    .*\n){3}/m, "").replace("srt: yes\nsrtAddress: 127.0.0.1:8890", "srt: no")
  assert.equal(stripped, off)
})

test("read-out on: passphrase → srtReadPassphrase on /capture only; shares the Main/Backup listener", () => {
  const yml = buildMediamtxConfig({ ...base, ingestHost: "0.0.0.0", srtMain: { port: 8890, passphrase: "main-secret-1" }, captureOut: { ...out, passphrase: "read-secret-1" } })
  assert.equal(yml.match(/^srt: yes$/gm)?.length, 1)
  assert.match(yml, /^srtAddress: 0\.0\.0\.0:8890$/m)
  assert.match(yml, /^  capture: \{ srtReadPassphrase: "read-secret-1" \}$/m)
  assert.match(yml, /^  slate: \{\}$/m)
  assert.match(yml, /^  vertical: \{\}$/m)
  assert.match(yml, /^  program: \{ overridePublisher: yes, srtPublishPassphrase: "main-secret-1" \}$/m)
  // Disarmed: the reader login stays (it never publishes), the listener does not move.
  const disarmed = buildMediamtxConfig({ ...base, programArmed: false, ingestHost: "0.0.0.0", captureOut: out })
  assert.match(disarmed, /user: "out_u"/)
  assert.doesNotMatch(disarmed, /user: "obs"/)
  // A login without user/pass never reaches the config.
  assert.equal(buildMediamtxConfig({ ...base, captureOut: { ...out, pass: "" } }), buildMediamtxConfig(base))
})

test("SRT listener on for the read-out alone", () => {
  assert.equal(srtListenerOn({ srtBackup: false, srtMain: false, backupPullUrl: "" }), false)
  assert.equal(srtListenerOn({ srtBackup: false, srtMain: false, backupPullUrl: "", srtCaptureOut: true }), true)
})

test("reader URL formats: full URL and bare server + streamid", () => {
  assert.equal(captureSrtUrl({ host: "2.31.123.37", port: 8890, user: "u", pass: "p", passphrase: "", latencyUs: 1_000_000 }), "srt://2.31.123.37:8890?streamid=read:capture:u:p&latency=1000000")
  const on = { on: true, passphrase: "read-secret-1", lanIngest: true, lanHost: "2.31.123.37", user: "u", pass: "p", port: 8890, latencyMs: 300 }
  const r = captureSrtReveal(on)
  assert.equal(r.url, "srt://2.31.123.37:8890?streamid=read:capture:u:p&latency=300000&passphrase=read-secret-1")
  assert.equal(r.server, "srt://2.31.123.37:8890")
  assert.equal(r.streamid, "read:capture:u:p")
  assert.equal(r.passphrase, "read-secret-1")
  assert.equal(r.lan, true)
  assert.equal(captureSrtReveal({ ...on, on: false }).url, null)
  assert.equal(captureSrtReveal({ ...on, user: undefined }).url, null)
  const local = captureSrtReveal({ ...on, lanIngest: false, lanHost: null })
  assert.equal(local.lan, false)
  assert.match(local.url ?? "", /^srt:\/\/127\.0\.0\.1:8890\?/)
})

test("read login: random, stable, own 0600 file; regenerate makes a new one", async () => {
  const first = captureReadLogin()
  assert.match(first.user, /^out_[\w-]+$/)
  assert.ok(first.pass.length >= 20)
  assert.deepEqual(captureReadLogin(), first)
  const f = path.join(relayDir(), "capture-read.json")
  assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  assert.equal((await rotateCaptureReadLogin()).ok, true)
  const next = captureReadLogin()
  assert.notEqual(next.pass, first.pass)
  assert.notEqual(next.user, first.user)
})

test("setting: off by default, passphrase validated, toggle stored", async () => {
  assert.equal(readSettings().srtCaptureOut, false)
  assert.equal(readSettings().srtCaptureOutPassphrase, "")
  const bad = await setSrtCaptureOut({ on: true, passphrase: "short" })
  assert.equal(bad.ok, false)
  assert.equal(readSettings().srtCaptureOut, false)
  assert.equal((await setSrtCaptureOut({ on: true, passphrase: "read-secret-1" })).ok, true)
  assert.equal(readSettings().srtCaptureOut, true)
  assert.equal(readSettings().srtCaptureOutPassphrase, "read-secret-1")
  assert.equal((await setSrtCaptureOut({ on: false })).ok, true)
  assert.equal(readSettings().srtCaptureOut, false)
  assert.equal(readSettings().srtCaptureOutPassphrase, "read-secret-1") // kept for next time
})

test("regenerate kicks only SRT readers of /capture", () => {
  const body = { items: [
    { id: "a", state: "read", path: "capture" },
    { id: "b", state: "publish", path: "program" },
    { id: "c", state: "read", path: "program" },
    { id: "d", state: "read", path: "capture" },
  ] }
  assert.deepEqual(readerKickTargets(body, "capture"), ["srtconns/kick/a", "srtconns/kick/d"])
  assert.deepEqual(readerKickTargets(null, "capture"), [])
})

test("SRT streamid logins never reach the desk's last-reject line", () => {
  const log = "2026/11/04 09:00:00 INF [SRT] [conn 1.2.3.4:5000] closed: authentication failed for streamid read:capture:out_u:secretpass\n"
  const text = parseIngestLog(log).lastReject?.text ?? ""
  assert.match(text, /read:capture:…/)
  assert.doesNotMatch(text, /secretpass|out_u/)
})
