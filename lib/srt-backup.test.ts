import test from "node:test"
import assert from "node:assert/strict"
import { buildMediamtxConfig, kickTargets, parseConns, srtObsUrl, srtPassphraseError } from "@/lib/relay"
import { rttLabel, srtLevel } from "@/lib/rtt"

const creds = { publishUser: "p", publishPass: "pp", readUser: "r", readPass: "rr", programUser: "obs", programPass: "op", backupUser: "bak", backupPass: "bp" }
const base = { host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds, programArmed: true }

test("SRT off: config is byte-identical to before (srt: no)", () => {
  const off = buildMediamtxConfig(base)
  assert.equal(off, buildMediamtxConfig({ ...base, srt: undefined }))
  assert.match(off, /^srt: no$/m)
  assert.doesNotMatch(off, /srtAddress|srtPublishPassphrase/)
})

test("SRT on: srt: yes bound like RTMP ingest (LAN host when LAN ingest), optional passphrase on program-backup", () => {
  const local = buildMediamtxConfig({ ...base, srt: { port: 8890, passphrase: "" } })
  assert.match(local, /^srt: yes\nsrtAddress: 127\.0\.0\.1:8890$/m)
  assert.match(local, /^  program-backup: \{ overridePublisher: yes \}$/m)
  const lan = buildMediamtxConfig({ ...base, ingestHost: "0.0.0.0", srt: { port: 8890, passphrase: "correct-horse-1" } })
  assert.match(lan, /^srtAddress: 0\.0\.0\.0:8890$/m)
  assert.match(lan, /^rtmpAddress: 0\.0\.0\.0:19350$/m) // RTMP unchanged
  assert.match(lan, /program-backup: \{ overridePublisher: yes, srtPublishPassphrase: "correct-horse-1" \}/)
  // Backup pulled or not armed: no SRT listener.
  assert.match(buildMediamtxConfig({ ...base, backupPullUrl: "rtmp://10.0.0.2/live/x", srt: { port: 8890, passphrase: "" } }), /^srt: no$/m)
  assert.match(buildMediamtxConfig({ ...base, programArmed: false, srt: { port: 8890, passphrase: "" } }), /^srt: no$/m)
})

test("SRT URL for OBS 2 and passphrase rules", () => {
  assert.equal(srtObsUrl({ host: "192.168.0.24", port: 8890, user: "bak", pass: "bp", passphrase: "" }), "srt://192.168.0.24:8890?streamid=publish:program-backup:bak:bp&latency=300000&pkt_size=1316")
  assert.match(srtObsUrl({ host: "h", port: 8890, user: "u", pass: "p", passphrase: "abcdefghij" }), /&passphrase=abcdefghij$/)
  assert.equal(srtPassphraseError(""), null)
  assert.ok(srtPassphraseError("short"))
  assert.ok(srtPassphraseError("has&ampersand1"))
  assert.equal(srtPassphraseError("correct-horse-1"), null)
})

test("srtconns/rtmpconns parsing, kick targets and the SRT card label", () => {
  const srt = parseConns({ items: [
    { id: "a1", path: "program-backup", state: "publish", remoteAddr: "192.168.0.31:51234", msRTT: 12.4, packetsReceived: 9900, packetsReceivedLoss: 100, packetsReceivedRetrans: 37, mbpsReceiveRate: 4.6 },
    { id: "r1", path: "program-backup", state: "read", remoteAddr: "127.0.0.1:1" },
  ] }, "srt")
  assert.deepEqual(srt, [{ id: "a1", path: "program-backup", protocol: "srt", host: "192.168.0.31", srt: { rttMs: 12.4, lost: 100, retrans: 37, lossPct: 1, mbps: 4.6 } }])
  const rtmp = parseConns({ items: [{ id: "m1", path: "program", state: "publish", remoteAddr: "[::1]:5000" }] }, "rtmp")
  assert.deepEqual(rtmp, [{ id: "m1", path: "program", protocol: "rtmp", host: "::1", srt: null }])
  assert.deepEqual(parseConns(null, "srt"), [])
  assert.deepEqual(kickTargets([...rtmp, ...srt], ["program", "program-backup"]), ["rtmpconns/kick/m1", "srtconns/kick/a1"])
  assert.deepEqual(kickTargets([...rtmp, ...srt], ["program-backup"]), ["srtconns/kick/a1"])
  const link = srt[0].srt!
  assert.equal(srtLevel(link), "ok")
  assert.equal(srtLevel({ ...link, lossPct: 12 }), "bad")
  assert.equal(rttLabel({ host: "192.168.0.31", via: "push", method: "srt", lastMs: 12.4, avgMs: 12.4, maxMs: 12.4, lossPct: 1, samples: 1, level: "ok", protocol: "srt", srt: link }), "SRT · 12ms · 1% loss · 37 retx")
  assert.equal(rttLabel({ host: "h", via: "push", method: "icmp", lastMs: 7.2, avgMs: 7, maxMs: 8, lossPct: 0, samples: 3, level: "ok", protocol: "rtmp" }), "RTMP · ping 7.2ms")
})
