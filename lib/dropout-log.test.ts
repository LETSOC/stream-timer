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

test("operator markers: types round-trip; problem marks are incidents, on-purpose ones label relay lines expected", async () => {
  const { markIncidents, formatMark, formatMarkers, annotateExpected, correlate, isMark, isRealProblem } = await import("@/lib/dropout-log")
  const { markMessage, parseMarkMessage, cleanNote } = await import("@/lib/marks")
  assert.equal(parseMarkMessage(markMessage("frozen", "phone", "Backup", "program", "lower third"))?.type, "frozen")
  assert.equal(parseMarkMessage(markMessage("main-stopped", "deck", "Main", "countdown (x)"))?.screen, "countdown (x)")
  assert.equal(parseMarkMessage("blackout marked on desk (on air: Main, screen: program)")?.type, "blackout") // 289670b lines
  assert.equal(parseMarkMessage("something else"), null)
  assert.equal(cleanNote("a\nb\u0007  c".padEnd(300, "x")).length, 120)
  const base = Date.UTC(2026, 10, 4, 10, 0, 0)
  const ev = parseDropoutLog([
    dropoutLine(base - 10_000, "!", "relay", "Main /program publisher GONE (RTMP publisher of /program (1.2.3.4:5) closed: EOF)"),
    dropoutLine(base - 9000, "!", "switch", "auto-failover Main → Backup: Main stalled 3s"),
    dropoutLine(base, "·", "operator", markMessage("main-stopped", "desk", "Main", "program")),
    dropoutLine(base + 5000, "!", "relay", "Backup /program-backup publisher GONE (closed: EOF)"), // not stopped: real
    dropoutLine(base + 6000, "!", "operator", markMessage("audio", "phone", "Backup", "program", "out of sync")),
    dropoutLine(base + 60_000, "·", "operator", markMessage("main-back", "deck", "Backup", "program")),
    dropoutLine(base + 65_000, "+", "ingest", "Main READY again"),
    dropoutLine(base + 200_000, "!", "relay", "Main /program publisher GONE (closed: EOF)"), // after back on + 20s: real
    dropoutLine(base + 300_000, "·", "operator", markMessage("test-start", "desk", "Main", "program")),
    dropoutLine(base + 310_000, "!", "capture", "screencast gap 2.0s"),
    dropoutLine(base + 320_000, "·", "operator", markMessage("test-end", "desk", "Main", "program")),
  ].join("\n"))
  const a = annotateExpected(ev)
  const exp = (s: string) => a.find((e) => e.msg.startsWith(s))?.expected
  assert.equal(exp("Main /program publisher GONE (RTMP"), "operator stopped Main")
  assert.equal(exp("auto-failover"), "operator stopped Main")
  assert.equal(exp("Backup /program-backup"), undefined)
  assert.equal(exp("Main READY"), "operator stopped Main")
  assert.equal(a.filter((e) => e.msg === "Main /program publisher GONE (closed: EOF)")[0].expected, undefined)
  assert.equal(exp("screencast gap"), "operator test")
  assert.deepEqual(a.filter(isRealProblem).map((e) => e.msg.slice(0, 14)), ["Backup /progra", "Main /program "])
  // Only the audio mark is an incident; stop / back / test are markers.
  const m = markIncidents(ev)
  assert.equal(m.length, 1)
  assert.match(formatMark(m[0]), /^Audio problem \(drop\/out of sync\) marked 10:00:06 \(London\) · on phone .*note: out of sync/)
  assert.match(formatMark(m[0]), /Main stalled 3s {2}← expected \(operator stopped Main\)/)
  const markers = formatMarkers(ev)
  assert.equal(markers.length, 4)
  assert.match(markers[0], /^10:00:00 · Main stopped on purpose · on desk .* 2 problem line\(s\) labelled expected/)
  assert.match(markers[2], /Test start .* 1 problem line/)
  // Incidents skip expected lines.
  const inc = correlate(a.filter((e) => !isMark(e)))
  assert.deepEqual(inc.map((i) => i.problems.length), [1, 1])
})
