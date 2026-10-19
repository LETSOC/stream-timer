import assert from "node:assert/strict"
import { test } from "node:test"
import { correlate, dropoutLine, londonParts, parseDropoutLog, redact } from "@/lib/dropout-log"
import { captureTrouble, mediamtxNote, parseProgress, pushTrouble } from "@/lib/dropout-monitor"

test("dropout lines use London time (BST in October, GMT in November)", () => {
  assert.equal(dropoutLine(Date.UTC(2026, 9, 19, 9, 59, 1, 234), "!", "relay", "Main gone"), "2026-10-19 10:59:01.234 ! [relay] Main gone")
  assert.equal(londonParts(Date.UTC(2026, 10, 4, 9, 30, 0, 5)).time, "09:30:00.005")
})

test("redact strips stream keys, passwords and URLs", () => {
  const r = redact("rtmp://a.rtmp.youtube.com/live2/abcd-efgh srt://h:8890?streamid=publish:x:u:p user=me pass=secret")
  assert.ok(!/abcd|secret|publish:x/.test(r), r)
})

test("parse → correlate: problems within 5s form one incident with ±5s context", () => {
  const base = Date.UTC(2026, 10, 4, 10, 0, 0)
  const lines = [
    dropoutLine(base - 8000, "·", "switch", "far before"),
    dropoutLine(base - 3000, "·", "switch", "context before"),
    dropoutLine(base, "!", "ingest", "Backup no data"),
    dropoutLine(base + 4000, "!", "player", "frozen"),
    dropoutLine(base + 6000, "+", "ingest", "flowing"),
    dropoutLine(base + 30000, "!", "push", "speed 0.8x"),
  ].join("\n")
  const ev = parseDropoutLog(lines)
  assert.equal(ev.length, 6)
  assert.equal(ev[2].at, base)
  const inc = correlate(ev, 5000)
  assert.equal(inc.length, 2)
  assert.deepEqual(inc[0].context.map((e) => e.msg), ["context before", "Backup no data", "frozen", "flowing"])
})

test("mediamtx log: publisher close is a problem, reader close context, polling noise dropped", () => {
  const conns = new Map()
  assert.equal(mediamtxNote("2026/10/19 11:00:07 INF [RTMP] [conn 1.2.3.4:5] closed: no stream is available on path 'capture'", conns), null)
  assert.equal(mediamtxNote("2026/10/19 11:00:07 INF [RTMP] [conn 9.9.9.9:1] is publishing to path 'program-backup', 2 tracks", conns)?.level, "·")
  const c = mediamtxNote("2026/10/19 11:00:09 INF [RTMP] [conn 9.9.9.9:1] closed: EOF", conns)
  assert.equal(c?.level, "!")
  assert.equal(c?.path, "program-backup")
  mediamtxNote("2026/10/19 11:00:07 INF [RTMP] [conn 8.8.8.8:1] is reading from path 'program', 2 tracks", conns)
  assert.equal(mediamtxNote("2026/10/19 11:00:10 INF [RTMP] [conn 8.8.8.8:1] closed: EOF", conns)?.level, "·")
  assert.equal(mediamtxNote("2026/10/19 11:00:10 WAR [WebRTC] [session ab12] skipping track 2 (MPEG-4 Audio)", conns), null)
})

test("forward -progress: below-realtime speed and bitrate drops are flagged", () => {
  const p = parseProgress("fps=29.97\nbitrate=2100.5kbits/s\ntotal_size=123\nspeed=0.81x\nprogress=continue\n")
  assert.deepEqual([p.fps, p.kbps, p.speed], [29.97, 2100.5, 0.81])
  assert.match(pushTrouble(p, 4500) ?? "", /speed 0\.81x.*bitrate 2101/)
  assert.equal(pushTrouble({ speed: 1.0, kbps: 4400 }, 4500), null)
  assert.equal(parseProgress("bitrate=N/A\nspeed=N/A\n").kbps, null)
})

test("capture stats: screencast gaps / repeats only count while the program is on air", () => {
  assert.deepEqual(captureTrouble({ maxGapMs: 900, repeatPct: 90, programAudio: { on: false } }), [])
  assert.deepEqual(captureTrouble({ maxGapMs: 450, programAudio: { on: true } }).map((x) => x.key), ["gap"])
  assert.deepEqual(captureTrouble({ heartbeatAgeMs: 5000, backpressurePct: 3, enc: { fps: 30, speed: 0.9, kbps: 4000 } }).map((x) => x.key), ["backpressure", "speed"])
})

test("operator marks: events 15s before → 5s after each mark", async () => {
  const { markIncidents, formatMark } = await import("@/lib/dropout-log")
  const base = Date.UTC(2026, 10, 4, 10, 0, 0)
  const ev = parseDropoutLog([
    dropoutLine(base - 20000, "·", "switch", "too early"),
    dropoutLine(base - 12000, "!", "relay", "Backup GONE"),
    dropoutLine(base, "!", "operator", "blackout marked on desk (on air: Backup, screen: program)"),
    dropoutLine(base + 4000, "+", "player", "picture back"),
    dropoutLine(base + 9000, "·", "switch", "too late"),
  ].join("\n"))
  const m = markIncidents(ev)
  assert.equal(m.length, 1)
  assert.deepEqual(m[0].context.map((e) => e.msg.slice(0, 11)), ["Backup GONE", "blackout ma", "picture bac"])
  assert.match(formatMark(m[0]), /Blackout marked 10:00:00 .*on desk.*−12\.0s ! \[relay\] Backup GONE/s)
})
