import assert from "node:assert/strict"
import { test } from "node:test"
import { correlate, dropoutLine, londonParts, parseDropoutLog, redact } from "@/lib/dropout-log"
import { avLine, captureChromeNote, captureEncoderNote, captureHealthLine, verticalHealthLine, captureTrouble, mediamtxNote, parseProgress, pushTrouble } from "@/lib/dropout-monitor"

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

test("operator markers: HD capture / Vertical stopped + back on label /capture and /vertical lines expected", async () => {
  const { annotateExpected, formatMarkers, isRealProblem, eventSource } = await import("@/lib/dropout-log")
  const { markMessage, parseMarkMessage } = await import("@/lib/marks")
  for (const t of ["capture-stopped", "capture-back", "vertical-stopped", "vertical-back"] as const) assert.equal(parseMarkMessage(markMessage(t, "phone", "Main", "program"))?.type, t)
  const base = Date.UTC(2026, 10, 4, 10, 0, 0)
  const line = (dt: number, lvl: "!" | "+" | "·", cat: Parameters<typeof dropoutLine>[2], msg: string) => dropoutLine(base + dt, lvl, cat, msg)
  const ev = parseDropoutLog([
    line(-3000, "!", "ingest", "Browser capture /capture: no data for 2.0s while the publisher is still connected"),
    line(-2000, "!", "relay", "Browser capture /capture publisher GONE (RTMP publisher of /capture (127.0.0.1:1) closed: EOF)"),
    line(-2000, "!", "relay", "Vertical /vertical publisher GONE (RTMP publisher of /vertical (127.0.0.1:2) closed: EOF)"),
    line(-2000, "!", "push", "live.restream.io vertical (from /capture): exited (code 0 after 282s); restarting in 2s"),
    line(-2000, "!", "push", "OneStream (from /vertical): exited (code 0 after 276s); restarting in 2s"),
    line(-1000, "!", "relay", "Main /program publisher GONE (closed: EOF)"), // Main isn't covered by an HD capture stop
    line(0, "·", "operator", markMessage("capture-stopped", "desk", "Main", "program")),
    line(6000, "+", "relay", "Browser capture /capture publisher READY (rtmpConn)"),
    line(8000, "·", "operator", markMessage("capture-back", "phone", "Main", "program")),
    line(120_000, "!", "relay", "Browser capture /capture publisher GONE (closed: EOF)"), // after back on + 20s: real
    line(200_000, "·", "operator", markMessage("vertical-stopped", "deck", "Main", "program")),
    line(201_000, "!", "push", "UPSTREAM TEST (from /vertical): exited (code 0 after 10s)"),
    line(201_000, "!", "push", "C_HD_TEST LIVE (from /capture): exited (code 0 after 10s)"), // a Vertical stop doesn't explain HD
    line(205_000, "·", "operator", markMessage("vertical-back", "deck", "Main", "program")),
  ].join("\n"))
  assert.equal(eventSource(ev.find((e) => e.msg.startsWith("live.restream.io vertical"))!), "capture")
  const a = annotateExpected(ev)
  const exp = (s: string) => a.find((e) => e.msg.startsWith(s))?.expected
  assert.equal(exp("Browser capture /capture: no data"), "operator stopped HD capture")
  assert.equal(exp("Vertical /vertical publisher GONE"), "operator stopped HD capture")
  assert.equal(exp("OneStream"), "operator stopped HD capture")
  assert.equal(exp("live.restream.io"), "operator stopped HD capture")
  assert.equal(exp("Browser capture /capture publisher READY"), "operator stopped HD capture")
  assert.equal(exp("UPSTREAM TEST"), "operator stopped Vertical")
  assert.deepEqual(a.filter(isRealProblem).map((e) => e.msg.slice(0, 20)), ["Main /program publis", "Browser capture /cap", "C_HD_TEST LIVE (from"])
  const markers = formatMarkers(ev)
  assert.equal(markers.length, 4)
  assert.match(markers[0], /^10:00:00 · HD capture stopped on purpose · on desk .* 5 problem line\(s\) labelled expected/)
  assert.match(markers[1], /HD capture back on · on phone/)
  assert.match(markers[2], /Vertical stopped on purpose · on deck .* 1 problem line/)
})

test("avLine: 30s program audio line with counts since the last line (and after a capture restart)", () => {
  const a = avLine({ delayMs: 1234.4, queuedMs: 1250, playerLatencyMs: 1180, corrections: 40, jumps: 2, resyncs: 1 }, null)
  assert.equal(a.text, "program audio target delay 1234ms, queue 1250ms, player latency 1180ms; last 30s: 0 corrections, 0 drops/holds, 0 resyncs")
  const b = avLine({ delayMs: 8000, queuedMs: null, playerLatencyMs: 7900, corrections: 52, jumps: 5, resyncs: 3 }, a.counters)
  assert.match(b.text, /queue unprimed, player latency 7900ms; last 30s: 12 corrections, 3 drops\/holds, 2 resyncs$/)
  const c = avLine({ delayMs: 1200, queuedMs: 1200, playerLatencyMs: 1100, corrections: 4, jumps: 0, resyncs: 0 }, b.counters)
  assert.match(c.text, /4 corrections, 0 drops\/holds, 0 resyncs$/)
})

test("captureChromeNote: planned refresh is info, relaunch is trouble, ready is recovery", () => {
  assert.deepEqual(captureChromeNote("[capture 03:00:01] [chrome] planned Chrome refresh (uptime 3.0h)"), { level: "·", text: "planned Chrome refresh (uptime 3.0h)" })
  assert.equal(captureChromeNote("[capture 07:29:10] [chrome] relaunching the capture browser: reload failed (holding the last good frame)")?.level, "!")
  assert.equal(captureChromeNote("[capture 07:29:14] [chrome] /stream ready in the new browser after 3.9s: live frames again")?.level, "+")
  assert.equal(captureChromeNote("[capture 07:29:14] page heartbeat stalled 15s"), null)
  assert.equal(captureChromeNote("[capture 10:35:41] [chrome] relaunching the capture browser: planned refresh (holding the last good frame)")?.level, "·")
})

test("capture start line → encoder note", () => {
  assert.deepEqual(captureEncoderNote("[capture 14:00:01] starting 1920x1080 @ 30fps, 4500k, h264_videotoolbox (constant bitrate), keyframe every 2s"), { level: "·", text: "encoder (HD capture): h264_videotoolbox (constant bitrate), 1920x1080@30, 4500k" })
  assert.equal(captureEncoderNote("[capture 14:00:01] starting 1280x720 @ 30fps, 3000k, libx264, keyframe every 2s")?.text, "encoder (HD capture): libx264, 1280x720@30, 3000k")
  assert.equal(captureEncoderNote("[capture 14:00:01] VideoToolbox here can't do constant bitrate (needs FFmpeg 6.1+)")?.level, "!")
  assert.equal(captureEncoderNote("[capture 14:00:01] something else"), null)
})

test("30s capture health line: real fields, ? when missing, Mac load", () => {
  const load = { one: 3.21, five: 2.5, cores: 10 }
  const line = captureHealthLine({ size: "1920x1080", encoder: "h264_videotoolbox", bitrateK: 4500, screencastFps: 29.5, writtenFps: 30, repeatPct: 12.5, enc: { fps: 30, speed: 1, kbps: 4480 }, backpressurePct: 0, maxLagMs: 18, maxGapMs: 120, sync: { skippedMs: 0 } }, load)
  assert.equal(line, "health: 1920x1080 h264_videotoolbox 4500k · screencast 29.5fps · written 30fps (12.5% repeats) · enc 1.00x 4480kbps · pipe backpressure 0% · maxLag 18ms · maxGap 120ms · skipped 0ms · Mac load 3.21/2.50 (cores 10)")
  assert.match(captureHealthLine({}, load), /^health: \? \? \? · screencast \? · written \? \(\? repeats\) · enc \? \? ·/)
  assert.equal(verticalHealthLine({ encoder: "libx264", fps: 30, speed: 1.01, drop: 0, dup: 2 }, load), "health (vertical): 1080x1920 libx264 4500k · enc 1.01x 30fps · drop 0 · dup 2 · Mac load 3.21/2.50 (cores 10)")
})

test("[av] line says unprimed when the queue has no level; speed line carries load", () => {
  assert.match(avLine({ delayMs: 2000, queuedMs: null, playerLatencyMs: 2100 }, null).text, /queue unprimed,/)
  assert.match(captureTrouble({ enc: { fps: 28, speed: 0.8, kbps: 4000 } }, { one: 9, five: 7, cores: 8 })[0].text, /0\.8x.*Mac load 9\.00\/7\.00 \(cores 8\)/)
})

test("tagged player lines still parse", () => {
  for (const tag of ["[phone] ", "[desk] ", "[obs] ", "[capture] "]) {
    const line = dropoutLine(Date.now(), "!", "player", `${tag}Main (on air): hls.js bufferStalledError (buffer ran dry: picture holds)`)
    const ev = parseDropoutLog(line)
    assert.equal(ev.length, 1)
    assert.equal(ev[0].cat, "player")
    assert.equal(ev[0].msg.startsWith(tag), true)
  }
})
