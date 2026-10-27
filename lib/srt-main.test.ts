import test from "node:test"
import assert from "node:assert/strict"
import { buildMediamtxConfig, parseConns, parseIngestLog, kickTargets, srtLatencyMs, srtLatencyUs, srtListenerOn, srtObsUrl } from "@/lib/relay"
import { mainSrtReveal } from "@/lib/srt-urls"
import { srtLatencyNote } from "@/lib/srt-note"
import { rttLabel, srtLevel } from "@/lib/rtt"

const creds = { publishUser: "p", publishPass: "pp", readUser: "r", readPass: "rr", programUser: "obs", programPass: "op", backupUser: "bak", backupPass: "bp", verticalUser: "v", verticalPass: "vp" }
const base = { host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds, programArmed: true }

test("Main SRT off: config byte-identical to before (srt: no, /program has no passphrase)", () => {
  const off = buildMediamtxConfig(base)
  assert.equal(off, buildMediamtxConfig({ ...base, srtMain: undefined }))
  assert.match(off, /^srt: no$/m)
  assert.match(off, /^  program: \{ overridePublisher: yes \}$/m)
})

test("Main SRT on: same listener/port as Backup SRT, bound like RTMP ingest, own passphrase on /program", () => {
  const local = buildMediamtxConfig({ ...base, srtMain: { port: 8890, passphrase: "" } })
  assert.match(local, /^srt: yes\nsrtAddress: 127\.0\.0\.1:8890$/m)
  assert.match(local, /^  program: \{ overridePublisher: yes \}$/m)
  const lan = buildMediamtxConfig({ ...base, ingestHost: "0.0.0.0", srtMain: { port: 8890, passphrase: "main-secret-1" } })
  assert.match(lan, /^srtAddress: 0\.0\.0\.0:8890$/m)
  assert.match(lan, /^  program: \{ overridePublisher: yes, srtPublishPassphrase: "main-secret-1" \}$/m)
  assert.match(lan, /^  program-backup: \{ overridePublisher: yes \}$/m) // Backup's passphrase is separate
  // Both on: one listener, each path its own passphrase.
  const both = buildMediamtxConfig({ ...base, ingestHost: "0.0.0.0", srt: { port: 8890, passphrase: "backup-secret" }, srtMain: { port: 8890, passphrase: "main-secret-1" } })
  assert.equal(both.match(/^srt: yes$/gm)?.length, 1)
  assert.match(both, /program: \{ overridePublisher: yes, srtPublishPassphrase: "main-secret-1" \}/)
  assert.match(both, /program-backup: \{ overridePublisher: yes, srtPublishPassphrase: "backup-secret" \}/)
  // Backup pulled: Backup SRT goes away but Main SRT keeps the listener.
  const pulled = buildMediamtxConfig({ ...base, backupPullUrl: "rtmp://10.0.0.2/live/x", srt: { port: 8890, passphrase: "" }, srtMain: { port: 8890, passphrase: "" } })
  assert.match(pulled, /^srt: yes$/m)
  assert.match(pulled, /program-backup: \{ source: /)
})

test("Main SRT: only the Main/Backup logins may connect from outside; internal logins stay loopback-only", () => {
  const yml = buildMediamtxConfig({ ...base, ingestHost: "0.0.0.0", srtMain: { port: 8890, passphrase: "" } })
  const users = yml.split("\n  - user: ").slice(1).map((block) => ({ user: /^"([^"]+)"/.exec(block)?.[1], ips: /\n    ips: (.*)/.exec(block)?.[1], perms: /\n    permissions: (.*)/.exec(block)?.[1] }))
  const loop = "['127.0.0.1/32', '::1/128']"
  for (const u of users) {
    if (u.user === "obs") { assert.equal(u.ips, "['0.0.0.0/0', '::/0']"); assert.equal(u.perms, "[{ action: publish, path: program }]") }
    else if (u.user === "bak") { assert.equal(u.ips, "['0.0.0.0/0', '::/0']"); assert.equal(u.perms, "[{ action: publish, path: program-backup }]") }
    else assert.equal(u.ips, loop, `${u.user} must be loopback-only`)
  }
  assert.deepEqual(users.map((u) => u.user).sort(), ["bak", "obs", "p", "r", "v"])
  // Not armed: the listener stays (no SRT restart on arm/disarm) but no Main/Backup login exists.
  const disarmed = buildMediamtxConfig({ ...base, programArmed: false, ingestHost: "0.0.0.0", srtMain: { port: 8890, passphrase: "" } })
  assert.match(disarmed, /^srt: yes$/m)
  assert.doesNotMatch(disarmed, /user: "obs"/)
  // Main disarmed only: Main login gone, Backup stays.
  const mainOff = buildMediamtxConfig({ ...base, disarmed: { main: true, backup: false }, srtMain: { port: 8890, passphrase: "" } })
  assert.doesNotMatch(mainOff, /user: "obs"/)
  assert.match(mainOff, /user: "bak"/)
  // Arming/disarming never changes the listener lines (a change there would drop every connection).
  const listener = (y: string) => y.split("\n").filter((l) => /^(srt|srtAddress|rtmpAddress):/.test(l)).join("\n")
  assert.equal(listener(disarmed), listener(buildMediamtxConfig({ ...base, ingestHost: "0.0.0.0", srtMain: { port: 8890, passphrase: "" } })))
})

test("srtListenerOn: Backup SRT (not pulled) or Main SRT", () => {
  assert.equal(srtListenerOn({ srtBackup: false, srtMain: false, backupPullUrl: "" }), false)
  assert.equal(srtListenerOn({ srtBackup: true, srtMain: false, backupPullUrl: "" }), true)
  assert.equal(srtListenerOn({ srtBackup: true, srtMain: false, backupPullUrl: "rtmp://h/x" }), false)
  assert.equal(srtListenerOn({ srtBackup: false, srtMain: true, backupPullUrl: "rtmp://h/x" }), true)
})

test("SRT_LATENCY_MS: default 300 ms, integer 20–8000 only", () => {
  assert.equal(srtLatencyMs({}), 300)
  assert.equal(srtLatencyUs({}), 300_000)
  assert.equal(srtLatencyMs({ SRT_LATENCY_MS: "1000" }), 1000)
  assert.equal(srtLatencyUs({ SRT_LATENCY_MS: " 1000 " }), 1_000_000)
  for (const bad of ["", "abc", "10", "9000", "1e3", "-5", "500.5"]) assert.equal(srtLatencyMs({ SRT_LATENCY_MS: bad }), 300, bad)
  assert.match(srtLatencyNote(1000), /^latency=1000000 is 1000 ms/)
  assert.doesNotMatch(srtLatencyNote(1000), /over the internet/)
  assert.match(srtLatencyNote(undefined), /^latency=300000 is 300 ms.*1000 over the internet/)
})

test("Main SRT URL: streamid publish:program:user:pass, own passphrase, latency from settings", () => {
  assert.equal(srtObsUrl({ host: "2.31.123.37", port: 8890, user: "obs", pass: "op", passphrase: "", path: "program", latencyUs: 1_000_000 }), "srt://2.31.123.37:8890?streamid=publish:program:obs:op&latency=1000000&pkt_size=1316")
  // Backup stays the default path (unchanged behaviour).
  assert.match(srtObsUrl({ host: "h", port: 8890, user: "bak", pass: "bp", passphrase: "", latencyUs: 300_000 }), /streamid=publish:program-backup:bak:bp&latency=300000/)
  const on = { srtMain: true, passphrase: "", lanIngest: true, lanHost: "192.168.0.24", user: "obs", pass: "op", port: 8890, latencyMs: 300 }
  assert.deepEqual(mainSrtReveal(on), { url: "srt://192.168.0.24:8890?streamid=publish:program:obs:op&latency=300000&pkt_size=1316", lan: true, port: 8890, latencyMs: 300, note: "OBS / encoder: Settings › Stream › Custom, paste as Server, leave Stream Key blank." })
  assert.match(mainSrtReveal({ ...on, passphrase: "main-secret-1" }).url ?? "", /&passphrase=main-secret-1$/)
  assert.equal(mainSrtReveal({ ...on, srtMain: false }).url, null)
  assert.equal(mainSrtReveal({ ...on, user: undefined }).url, null)
  const local = mainSrtReveal({ ...on, lanIngest: false, lanHost: null })
  assert.match(local.url ?? "", /^srt:\/\/127\.0\.0\.1:8890\?/)
  assert.equal(local.lan, false)
})

test("SRT Main publisher: listed, kicked, RTT/loss readout and refusals like RTMP Main", () => {
  const pubs = parseConns({ items: [{ id: "s1", path: "program", state: "publish", remoteAddr: "81.2.3.4:40000", msRTT: 31.2, packetsReceived: 1000, packetsReceivedLoss: 0, packetsReceivedRetrans: 2, mbpsReceiveRate: 6 }] }, "srt")
  assert.deepEqual(pubs.map((p) => [p.path, p.protocol, p.host]), [["program", "srt", "81.2.3.4"]])
  assert.deepEqual(kickTargets(pubs, ["program"]), ["srtconns/kick/s1"])
  assert.deepEqual(kickTargets(pubs, ["program-backup"]), [])
  const link = pubs[0].srt!
  assert.equal(srtLevel(link), "ok")
  assert.equal(rttLabel({ host: "81.2.3.4", via: "push", method: "srt", lastMs: 31.2, avgMs: 31.2, maxMs: 31.2, lossPct: 0, samples: 1, level: "ok", protocol: "srt", srt: link }), "SRT · 31ms · 0% loss · 2 retx")
  const log = [
    "2026/11/04 09:20:00 INF [RTMP] listener opened on 0.0.0.0:19350",
    "2026/11/04 09:21:00 INF [SRT] [conn 81.2.3.4:40000] closed: authentication failed",
  ].join("\n")
  const r = parseIngestLog(log)
  assert.equal(r.listen, "0.0.0.0:19350")
  assert.equal(r.lastReject?.from, "81.2.3.4")
  assert.match(r.lastReject?.text ?? "", /\[SRT\].*authentication failed/)
})
