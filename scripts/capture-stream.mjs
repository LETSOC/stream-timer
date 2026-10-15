#!/usr/bin/env node
// Browser capture: renders the real /stream page in headless Chromium and publishes it to RTMP.
//
// Frames come from the Chrome DevTools screencast (Page.startScreencast), which pushes a JPEG
// whenever the page repaints. A fixed-rate timer writes the latest frame into ffmpeg's
// image2pipe at CAPTURE_FPS, so the output is constant frame rate even when the page is still.
// Audio: scripts/audio-feeder.mjs (AUDIO_LIVE_FILE: silence, tone or a bed/playlist), switchable live.
// Program audio: headless Chromium's sound is not part of the screencast, so while /stream shows
// the OBS program (<html data-screen="program">) this script reads /program's audio straight from
// the relay (URL in PROGRAM_READ_FILE, 0600) and feeds it to ffmpeg as raw PCM on fd 3, delayed by
// CAPTURE_PROGRAM_AUDIO_DELAY_MS (default 1170, measured: LL-HLS ~1.2s + screencast) to line up with the LL-HLS picture. The same PCM
// stream carries a gain channel that fades the audio bed out under the program (200ms) and back.
//
// Env: CAPTURE_URL (http://127.0.0.1:PORT/stream?k=VIEWKEY), RTMP_URL, CAPTURE_SIZE (1280x720 |
// 1920x1080), CAPTURE_FPS (default 30), CAPTURE_BITRATE (kbps; default 2500 at 720p, 4500 at 1080p),
// CAPTURE_ENCODER (auto | libx264 | videotoolbox; auto = h264_videotoolbox on a Mac when it works,
// else libx264), CAPTURE_STATS_FILE (JSON health every 2s), FFMPEG_BIN. Never prints either URL.
// Exits non-zero on any failure so rtmp-supervisor.sh restarts it.
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { chromium } from "playwright"
import { createAudioFeeder, createDelayLine } from "./audio-feeder.mjs"
import { captureCodeVersion } from "./code-version.mjs"
import { createJitterMeter, deadBandMs, splice, spliceFrames } from "./program-jitter.mjs"

const log = (msg) => process.stderr.write(`[capture ${new Date().toTimeString().slice(0, 8)}] ${msg}\n`)
const pageUrl = process.env.CAPTURE_URL
const rtmpUrl = process.env.RTMP_URL
if (!pageUrl || !rtmpUrl) {
  log("CAPTURE_URL and RTMP_URL are required")
  process.exit(2)
}
const [width, height] = (process.env.CAPTURE_SIZE === "1920x1080" ? "1920x1080" : "1280x720").split("x").map(Number)
const fps = Math.min(60, Math.max(10, Number(process.env.CAPTURE_FPS) || 30))
const bitrate = Math.min(12000, Math.max(500, Math.round(Number(process.env.CAPTURE_BITRATE)) || (width >= 1920 ? 4500 : 2500)))
const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg"
const statsFile = process.env.CAPTURE_STATS_FILE || ""

// Hardware H.264 on macOS (VideoToolbox) takes most of the encode off the CPU. "auto" uses it only
// if a 1-frame test encode succeeds, so a Mac without it (or Linux) falls back to libx264.
function pickEncoder() {
  const want = (process.env.CAPTURE_ENCODER || "auto").toLowerCase()
  if (want === "libx264") return "libx264"
  if (want !== "videotoolbox" && !(want === "auto" && process.platform === "darwin")) return "libx264"
  if (!vtProbe([])) return "libx264"
  // auto: only use VideoToolbox when it can hold a constant bitrate; its average-bitrate mode
  // undershoots badly on static pages. An explicit "videotoolbox" still gets it (with a warning).
  if (want === "auto" && !vtProbe(["-constant_bit_rate", "1"])) return "libx264"
  return "h264_videotoolbox"
}
function vtProbe(extra) {
  const probe = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30", "-frames:v", "2", "-c:v", "h264_videotoolbox", "-b:v", "1000k", ...extra, "-f", "null", "-"], { timeout: 8000 })
  return probe.status === 0
}
const encoder = pickEncoder()
// VideoToolbox's default rate control is average-bitrate VBR and ignores -maxrate as a floor, so a
// mostly static page encodes at a fraction of the set bitrate (e.g. 636k of 2500k), which YouTube
// can treat as an unhealthy/idle stream. True CBR (-constant_bit_rate 1) needs FFmpeg 6.1+ and
// macOS 13+ on Apple Silicon; probe it and fall back to ABR with a data-rate cap.
const vtCbr = encoder === "h264_videotoolbox" && vtProbe(["-constant_bit_rate", "1"])

// Keyframe every 2s (YouTube/Castr want ≤ 2s), CBR-ish: maxrate = bitrate, 2s buffer.
const gop = String(fps * 2)
const videoArgs = encoder === "h264_videotoolbox"
  ? ["-c:v", "h264_videotoolbox", "-realtime", "1", "-profile:v", "high", "-b:v", `${bitrate}k`,
     ...(vtCbr ? ["-constant_bit_rate", "1"] : ["-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`]),
     "-g", gop, "-keyint_min", gop, "-force_key_frames", `expr:gte(t,n_forced*2)`]
  : ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "high", "-b:v", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`, "-nal-hrd", "cbr", "-g", gop, "-keyint_min", gop, "-sc_threshold", "0", "-x264-params", "force-cfr=1"]

// ---------- audio (fd 3: s16le, 48k stereo = stream audio from the live feeder, faded under program audio) ----------
//
// A/V sync. Video and audio are both stamped by one timeline: frame k stands for timeline time
// k/fps, sample i for i/48000, and both writers emit exactly what wall time says is due (a stall
// skips the SAME span in both, see `skippedMs`), so they cannot drift apart.
// Constant offsets are compensated:
//  - screencast lag: a frame reaches us `lag` ms after Chrome painted it (CDP frame timestamp vs
//    arrival, smoothed), so the stream audio is delayed by that much to match the picture;
//  - program audio: /stream's hidden player reports how far behind the relay's live edge it is
//    (hls.js playingDate → data-latency-ms); program audio read straight from the relay is delayed
//    by that latency + screencast lag - reader lag, tracked continuously (smoothed, clamped) with
//    ±2% sample drop/repeat so it follows the player without clicks;
//  - the desk's A/V offset trim (+ = audio later, - = audio earlier: delays the video instead).
const RATE = 48000
const CODE_VERSION = captureCodeVersion(path.dirname(new URL(import.meta.url).pathname))
const programFile = process.env.PROGRAM_READ_FILE || ""
/** Fallback program delay while /stream hasn't reported its player latency yet. */
const progFallbackMs = Math.min(5000, Math.max(0, Number(process.env.CAPTURE_PROGRAM_AUDIO_DELAY_MS ?? 1170) || 0))
/** ffmpeg RTMP read + AAC decode latency of the program reader (measured on the box). */
const readerLagMs = Number(process.env.CAPTURE_PROGRAM_READER_LAG_MS ?? 25) || 0
const prog = { source: "main", wanted: false, wantedSince: 0, flowed: false, reader: null, chunks: [], bytes: 0, primed: false, underruns: 0, gain: 1, lastWantedAt: 0, restartAt: 0, peak: 0, mixedAt: 0, latencyMs: null, targetMs: progFallbackMs, levelMs: null, corrections: 0, jumps: 0, holding: false, ramp: 1 }
const sync = { lagMs: null, trimMs: 0, test: false }
/** Screencast lag used for compensation (smoothed; 0 until measured). */
const screencastLag = () => Math.max(0, Math.min(400, sync.lagMs ?? 0))
// Per input (Main / Backup): its own player latency, jitter meter and audio format, so a switch never
// reuses the other input's state (a local Main and a remote Backup behave very differently).
const inputs = { main: { latencyMs: null, jitter: createJitterMeter(), format: null }, backup: { latencyMs: null, jitter: createJitterMeter(), format: null } }
let lastSpliceAt = 0
function programTargetMs() {
  const base = prog.latencyMs === null ? progFallbackMs : prog.latencyMs + screencastLag() - readerLagMs
  return Math.max(100, Math.min(5000, base + sync.trimMs + videoDelayMs()))
}
function readUrlFor(source) {
  // Main = program-read.url, Backup = program-backup-read.url next to it (both 0600, written by lib/relay).
  const file = source === "backup" ? path.join(path.dirname(programFile), "program-backup-read.url") : programFile
  try { return fs.readFileSync(file, "utf8").trim() } catch { return "" }
}
/** One ffmpeg reading an input's audio as PCM into `reader.sink` (prog when on air, spare when warm). */
function spawnReader(source, sink) {
  const url = readUrlFor(source)
  if (!url) return null
  // Always 48k stereo; aresample async=1 = hard compensation only (pad silence / trim for real timestamp
  // gaps > 100ms), never soft stretching, so a remote publisher's jittery timestamps can't bend pitch.
  const reader = spawn(ffmpegBin, ["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-fflags", "nobuffer", "-rw_timeout", "5000000", "-i", url, "-vn", "-af", `aresample=${RATE}:async=1:min_hard_comp=0.100:first_pts=0`, "-ac", "2", "-ar", String(RATE), "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"], env: childEnv })
  reader.sink = sink
  let errText = ""
  reader.stderr.on("data", (d) => {
    if (errText.length > 8000) return
    errText += d.toString()
    const m = /Stream #\d+:\d+[^:]*: Audio: ([^,\s]+)[^,]*, (\d+) Hz, ([^,]+)/.exec(errText)
    if (m && !inputs[source].format) {
      inputs[source].format = { codec: m[1], sampleRate: Number(m[2]), channels: m[3].trim() }
      log(`[audio] ${source === "backup" ? "Backup" : "Main"} input audio: ${m[1]} ${m[2]} Hz ${m[3].trim()}${Number(m[2]) !== RATE ? ` (not ${RATE}: resampled)` : ""}`)
    }
  })
  reader.stdout.on("data", (chunk) => {
    const into = reader.sink
    if (!into) return // stopped/replaced: late data must not leak into the on-air queue
    into.chunks.push(chunk)
    into.bytes += chunk.length
    // Hard ceiling: never more than target + 1s queued.
    const max = (Math.round(((prog.targetMs + 1000) / 1000) * RATE)) * 4
    if (into.bytes > max) dropFrom(into, into.bytes - max)
  })
  reader.on("exit", () => {
    inputs[source].format = null
    if (prog.reader === reader) {
      prog.reader = null
      prog.chunks = []; prog.bytes = 0; prog.primed = false; prog.levelMs = null
      prog.restartAt = Date.now() + 2000
    }
    if (spare.reader === reader) Object.assign(spare, { reader: null, chunks: [], bytes: 0, restartAt: Date.now() + 5000 })
  })
  return reader
}
function startProgramReader() {
  if (prog.reader || !programFile || Date.now() < prog.restartAt) return
  const reader = spawnReader(prog.source, prog)
  if (!reader) return
  prog.reader = reader
  log(`[audio] program audio: reading the ${prog.source === "backup" ? "Backup" : "Main"} feed`)
}
function stopProgramReader() {
  if (!prog.reader) return
  const r = prog.reader
  prog.reader = null
  r.sink = null
  r.kill("SIGTERM")
  prog.chunks = []; prog.bytes = 0; prog.primed = false; prog.levelMs = null
  log("[audio] program audio: off")
}
/**
 * The other input, read warm while the program is on air (already queued at the delay), so a
 * Main↔Backup switch hands over its audio at once instead of a ~3s refill gap. Retries every 5s
 * when that input isn't publishing.
 */
const spare = { source: null, reader: null, chunks: [], bytes: 0, restartAt: 0 }
function startSpare() {
  const other = prog.source === "backup" ? "main" : "backup"
  if (spare.reader && spare.source === other) return
  stopSpare()
  if (!programFile || Date.now() < spare.restartAt) return
  spare.source = other
  spare.reader = spawnReader(other, spare)
}
function stopSpare() {
  if (spare.reader) { const r = spare.reader; spare.reader = null; r.sink = null; r.kill("SIGTERM") }
  Object.assign(spare, { chunks: [], bytes: 0 })
}
/** Switch the on-air program audio to `source`: promote the warm reader if it has audio queued. */
function switchProgramSource(source) {
  const old = prog.reader
  inputs[prog.source].latencyMs = prog.latencyMs
  prog.source = source
  prog.latencyMs = inputs[source].latencyMs // last known for this input (not the other one's), else fallback
  inputs[source].jitter.reset()
  prog.ramp = 0 // ~30ms fade-in on the new input: no click at the splice
  if (spare.reader && spare.source === source && spare.bytes > 0) {
    const r = spare.reader
    spare.reader = null
    r.sink = prog
    prog.reader = r
    prog.chunks = spare.chunks; prog.bytes = spare.bytes; prog.primed = false; prog.levelMs = null; prog.holding = false
    Object.assign(spare, { chunks: [], bytes: 0, restartAt: 0 })
    if (old) { old.sink = null; old.kill("SIGTERM") }
    log(`[audio] program source → ${source === "backup" ? "Backup" : "Main"} (warm reader, no refill)`)
  } else {
    if (old) { stopProgramReader(); prog.restartAt = 0 }
    log(`[audio] program source → ${source === "backup" ? "Backup" : "Main"}`)
  }
}
function dropFrom(q, bytes) {
  let left = bytes - (bytes % 4)
  while (left > 0 && q.chunks.length) {
    const head = q.chunks[0]
    if (head.length <= left) { q.chunks.shift(); q.bytes -= head.length; left -= head.length }
    else { q.chunks[0] = head.subarray(left); q.bytes -= left; left = 0 }
  }
}
function dropProgram(bytes) {
  dropFrom(prog, bytes)
}
function readProgramFrames(frames) {
  const want = frames * 4
  const buf = Buffer.allocUnsafe(want)
  let at = 0
  while (at < want) {
    const head = prog.chunks[0]
    const take = Math.min(head.length, want - at)
    head.copy(buf, at, 0, take)
    at += take
    if (take === head.length) prog.chunks.shift()
    else prog.chunks[0] = head.subarray(take)
  }
  prog.bytes -= want
  return buf
}
/**
 * `n` stereo frames of program audio delayed by programTargetMs(), or null while it (re)fills.
 * Keeps the queue at the target with a jitter-aware dead band and short crossfaded splices
 * (scripts/program-jitter.mjs): no rate changes, so no pitch wobble from a bursty remote input. Big jumps
 * (the player stalled or re-synced): > 300ms too much → drop once; > 300ms too little → hold
 * (silence, the picture is frozen then too) until the queue is back.
 */
function takeProgram(n) {
  const target = (prog.targetMs = programTargetMs())
  const targetBytes = Math.round((target / 1000) * RATE) * 4
  if (!prog.primed) {
    if (prog.bytes < targetBytes || prog.bytes === 0) return null
    prog.primed = true
    prog.levelMs = (prog.bytes / 4 / RATE) * 1000
  }
  const now = Date.now()
  const queuedMs = (prog.bytes / 4 / RATE) * 1000
  const input = inputs[prog.source]
  input.jitter.add(queuedMs, now)
  const spread = input.jitter.spreadMs()
  // ~2s average: arrival bursts from a remote publisher average out instead of steering the output.
  const alpha = Math.min(1, n / (2 * RATE))
  prog.levelMs = prog.levelMs === null ? queuedMs : prog.levelMs * (1 - alpha) + queuedMs * alpha
  prog.jitterMs = spread
  let err = prog.levelMs - target
  const jump = Math.max(300, spread * 1.5)
  if (err > jump) { dropProgram(prog.bytes - targetBytes); prog.levelMs = target; prog.jumps += 1; err = 0 }
  if (err < -jump || prog.holding) {
    // Hold: silence until the queue is back at the target.
    if (!prog.holding) { prog.holding = true; prog.jumps += 1 }
    if (queuedMs >= target) { prog.holding = false; prog.levelMs = queuedMs }
    return Buffer.alloc(n * 4)
  }
  // Outside the dead band: one short crossfaded splice (≤5ms, ≥100ms apart). Pitch never changes.
  const fade = 240
  const maxD = Math.floor((n - fade) / 3)
  const d = maxD > 0 && now - lastSpliceAt >= 100 ? spliceFrames(err, deadBandMs(spread), RATE, Math.min(240, maxD)) : 0
  if (d) { lastSpliceAt = now; prog.corrections += 1; prog.levelMs -= (d / RATE) * 1000 }
  const consume = n + d
  if (prog.bytes < consume * 4) { prog.primed = false; prog.underruns += 1; return null }
  return splice(readProgramFrames(consume), n, d, fade)
}
const GAIN_STEP = 1 / (0.2 * RATE)
let bedLine = null // delay line (screencast lag + positive trim), created with the feeder
/** `wallMs` = timeline time of the first frame (beeps of the sync test line up with the flashes). */
function pcmBlock(n, wallMs) {
  const programPcm = prog.wanted ? takeProgram(n) : null
  const wantBed = Math.max(0, screencastLag() + Math.max(0, sync.trimMs))
  const curBed = bedLine.delayMs()
  bedLine.setDelayMs(Math.abs(wantBed - curBed) < 15 ? wantBed : curBed + Math.sign(wantBed - curBed) * Math.min(15, Math.abs(wantBed - curBed)))
  const bed = bedLine.process(feeder ? feeder.readFloat(n, wallMs) : new Float32Array(n * 2))
  const out = Buffer.alloc(n * 4)
  // While the program (Main or Backup) is on air the bed/tone is suppressed: program audio only.
  // On entering the program the bed fades out once program audio first flows (no hole while the reader
  // starts, 3s cap); after that it stays out through Main↔Backup switches, reader restarts, priming and
  // underruns, and only comes back when /stream leaves the program for a card/countdown.
  if (programPcm) { prog.mixedAt = Date.now(); prog.flowed = true }
  const suppress = prog.wanted && (prog.flowed || Date.now() - prog.wantedSince > 3000)
  const target = suppress ? 0 : 1
  for (let i = 0; i < n; i++) {
    if (prog.gain < target) prog.gain = Math.min(target, prog.gain + GAIN_STEP)
    else if (prog.gain > target) prog.gain = Math.max(target, prog.gain - GAIN_STEP)
    let l = bed[i * 2] * prog.gain * 32767
    let r = bed[i * 2 + 1] * prog.gain * 32767
    if (programPcm) {
      if (prog.ramp < 1) prog.ramp = Math.min(1, prog.ramp + 1 / 1440)
      const pl = Math.round(programPcm.readInt16LE(i * 4) * prog.ramp)
      const pr = Math.round(programPcm.readInt16LE(i * 4 + 2) * prog.ramp)
      l += pl
      r += pr
      const m = Math.max(Math.abs(pl), Math.abs(pr))
      if (m > prog.peak) prog.peak = m
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l))), i * 4)
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r))), i * 4 + 2)
  }
  return out
}

const childEnv = { ...process.env }
delete childEnv.ENCODER_TOKEN
delete childEnv.RTMP_URL
delete childEnv.CAPTURE_URL
delete childEnv.CAPTURE_KEY_FILE
delete childEnv.PROGRAM_READ_FILE

// Stream audio, hot-swappable while live (scripts/audio-feeder.mjs; silence if no settings file).
const feeder = createAudioFeeder({ liveFile: process.env.AUDIO_LIVE_FILE || "", appliedFile: process.env.AUDIO_APPLIED_FILE || "", ffmpegBin, env: childEnv, log })
bedLine = createDelayLine()

let browser = null
let ffmpeg = null
let ticker = null
let audioTicker = null
let stopping = false

async function shutdown(code) {
  if (stopping) return
  stopping = true
  if (ticker) clearInterval(ticker)
  if (audioTicker) clearInterval(audioTicker)
  try { prog.reader?.kill("SIGTERM"); spare.reader?.kill("SIGTERM") } catch { /* gone */ }
  try { feeder.stop() } catch { /* gone */ }
  try { ffmpeg?.stdin.end() } catch { /* closed */ }
  try { await browser?.close() } catch { /* gone */ }
  if (ffmpeg && ffmpeg.exitCode === null) {
    ffmpeg.kill("SIGTERM")
    await new Promise((resolve) => { const t = setTimeout(() => { ffmpeg.kill("SIGKILL"); resolve() }, 3000); ffmpeg.once("exit", () => { clearTimeout(t); resolve() }) })
  }
  process.exit(code)
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { log(`${sig}: stopping`); void shutdown(0) })

log(`starting ${width}x${height} @ ${fps}fps, ${bitrate}k, ${encoder}${encoder === "h264_videotoolbox" ? (vtCbr ? " (constant bitrate)" : " (average bitrate)") : ""}, keyframe every 2s`)
if (encoder === "h264_videotoolbox" && !vtCbr) log("VideoToolbox here can't do constant bitrate (needs FFmpeg 6.1+ and macOS 13+ on Apple Silicon); a static page may send well under the set bitrate. Pick libx264 for a padded constant bitrate.")
browser = await chromium.launch({
  headless: true,
  handleSIGTERM: false,
  handleSIGINT: false,
  handleSIGHUP: false,
  env: childEnv,
  args: ["--autoplay-policy=no-user-gesture-required", "--hide-scrollbars", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
}).catch((error) => {
  log(`browser launch failed: ${error.message.split("\n")[0]} (run: npx playwright install chromium)`)
  process.exit(4)
})
browser.on("disconnected", () => { if (!stopping) { log("browser crashed"); void shutdown(5) } })

const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
// Internal capture credential (data/capture-key, 0600), not the OBS view key, so rotating the
// view key doesn't blank this capture. Sent as a header, and only to this server's own origin
// (never to third-party images/fonts on the page). Re-read per request so a fresh file is picked up.
const pageOrigin = new URL(pageUrl).origin
const captureKeyFile = process.env.CAPTURE_KEY_FILE
const readCaptureKey = () => { try { return fs.readFileSync(captureKeyFile, "utf8").trim() } catch { return "" } }
if (captureKeyFile) {
  if (!readCaptureKey()) log("capture key file missing; /stream will need the view key")
  await context.route("**/*", (route) => {
    const req = route.request()
    let sameOrigin = false
    try { sameOrigin = new URL(req.url()).origin === pageOrigin } catch { /* data: etc */ }
    const key = sameOrigin ? readCaptureKey() : ""
    return key ? route.continue({ headers: { ...req.headers(), "x-stream-capture-key": key } }) : route.continue()
  })
}
const page = await context.newPage()
page.on("crash", () => { log("page crashed"); void shutdown(6) })
// DOM-ready + the page's own ready marker (not "networkidle": /stream polls forever, and slow
// speaker images would otherwise hold the start for 20s).
const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null)
if (!response || !response.ok()) {
  log(`could not load /stream (status ${response?.status() ?? "none"})`)
  await shutdown(7)
}
await page.waitForSelector("html[data-stream-ready]", { timeout: 15000 }).catch(() => log("/stream ready marker not seen in 15s; capturing anyway"))
if (await page.getByText("View key required").count()) {
  log("/stream says the view key is wrong")
  await shutdown(8)
}
// Transparent edition renders over black in the stream (no alpha in H.264).
const cdp = await context.newCDPSession(page)
await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 1 } })

let latest = null
let frames = 0
// Health counters, reset every stats window.
const win = { at: Date.now(), screencast: 0, written: 0, repeats: 0, skipped: 0, maxLag: 0 }
let freshFrame = false
// Recent frames with arrival time, so a negative A/V trim can show the picture a little later.
const frameRing = []
cdp.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
  latest = Buffer.from(data, "base64")
  const arrived = Date.now()
  frameRing.push({ buf: latest, at: arrived })
  while (frameRing.length > 2 && arrived - frameRing[1].at > 1200) frameRing.shift()
  // Screencast lag: paint time (CDP, seconds) → arrival here. Smoothed; ignores outliers (GC pauses).
  const painted = Number(metadata?.timestamp) * 1000
  if (painted > 0) {
    const lag = arrived - painted
    // Typical screencast lag is a few ms; ignore GC/load spikes so the bed delay doesn't leap.
    if (lag >= 0 && lag < 200) {
      if (sync.lagMs === null) sync.lagMs = Math.min(60, lag)
      else if (Math.abs(lag - sync.lagMs) < 80) sync.lagMs = sync.lagMs * 0.95 + lag * 0.05
    }
  }
  frames += 1
  win.screencast += 1
  freshFrame = true
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined)
})
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: width, maxHeight: height, everyNthFrame: 1 })
// The first frame can take a moment; take one screenshot so we never start on nothing.
latest = await page.screenshot({ type: "jpeg", quality: 85 })

ffmpeg = spawn(ffmpegBin, [
  "-hide_banner", "-loglevel", "info", "-stats_period", "2",
  "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "pipe:0",
  "-thread_queue_size", "4096", "-f", "s16le", "-ar", String(RATE), "-ac", "2", "-i", "pipe:3",
  "-map", "0:v", "-map", "1:a",
  "-af", "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
  "-vf", `scale=${width}:${height}:flags=bicubic,format=yuv420p`,
  ...videoArgs, "-r", String(fps),
  "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
  "-f", "flv", "-flvflags", "no_duration_filesize", rtmpUrl,
], { stdio: ["pipe", "inherit", "pipe", "pipe"], env: childEnv })
const pcmOut = ffmpeg.stdio[3]
pcmOut.on("error", () => undefined)
ffmpeg.stdin.on("error", () => undefined)
// ffmpeg prints the output URL ("Output #0, flv, to 'rtmp://…/KEY'"): redact before it reaches the log.
const hideKey = (text) => text.split(rtmpUrl).join("rtmp://[destination]").replace(/(rtmps?:\/\/[^\s/'"]+)\/[^\s'"]*/gi, "$1/••••").replace(/(password=)[^\s&'"]+/gi, "$1••••")
// Keep the last stats line ("frame= … fps= … bitrate= … speed=…") for the health file; it is
// written to the log only every 10s so the log stays small.
let lastStatsLine = ""
let lastLoggedStats = 0
ffmpeg.stderr.on("data", (chunk) => {
  const text = hideKey(chunk.toString("utf8"))
  const parts = text.split(/(\r|\n)/)
  let rest = ""
  for (const part of parts) {
    if (/frame=\s*\d+.*speed=/.test(part)) {
      lastStatsLine = part.trim()
      if (Date.now() - lastLoggedStats >= 10000) { lastLoggedStats = Date.now(); rest += `${lastStatsLine}\n` }
    } else rest += part
  }
  if (rest.trim()) process.stderr.write(rest.replace(/\r/g, "\n"))
})
ffmpeg.on("exit", (code) => { if (!stopping) { log(`ffmpeg exited (code ${code})`); void shutdown(code || 1) } })

// Constant-rate writer: repeat the latest frame; skip a tick if ffmpeg is backed up.
// Drift-corrected: writes exactly as many frames as wall time says are due, so the stream runs at
// real-time speed (1.0x) instead of drifting with timer jitter.
const startedAt = Date.now()
let written = 0
// One timeline for both streams (see the A/V sync note at the top). skippedMs grows only when the
// encoder fell > 0.5s behind and video frames had to be dropped: audio skips the same span.
let skippedMs = 0
const timelineMs = () => Date.now() - startedAt - skippedMs
/** Negative trim beyond the screencast-lag compensation is applied by showing the picture later. */
const videoDelayMs = () => Math.max(0, -(screencastLag() + sync.trimMs))
// Audio pipe on the same timeline as the frames, so audio and video stay locked.
let pcmWritten = 0
audioTicker = setInterval(() => {
  if (!pcmOut.writable) return
  let due = Math.floor((timelineMs() * RATE) / 1000) - pcmWritten
  while (due > 0) {
    const n = Math.min(due, RATE)
    pcmOut.write(pcmBlock(n, startedAt + skippedMs + (pcmWritten * 1000) / RATE))
    pcmWritten += n
    due -= n
  }
}, 20)
/** Runs in the page: the sync test's full-frame white flash for the first 100ms of every wall-clock second. */
function syncTestOverlay(on) {
  const id = "__av_sync_test"
  let el = document.getElementById(id)
  if (!on) { el?.remove(); return }
  if (el) return
  el = document.createElement("div")
  el.id = id
  el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#fff;display:none;pointer-events:none"
  document.body.appendChild(el)
  const tick = () => {
    if (!el.isConnected) return
    el.style.display = Date.now() % 1000 < 100 ? "block" : "none"
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
// Which screen is /stream on? (set by the page; polled cheaply)
setInterval(async () => {
  if (stopping || reloading) return
  // Desk settings (live): A/V trim and the sync test.
  const live = feeder.sync()
  sync.trimMs = live.avOffsetMs
  if (live.syncTest !== sync.test) {
    sync.test = live.syncTest
    log(`[sync] A/V sync test ${sync.test ? "on: white flash + 1 kHz beep at every second" : "off"}`)
    await page.evaluate(syncTestOverlay, sync.test).catch(() => undefined)
  }
  const info = await page.evaluate(() => {
    const feed = document.querySelector("[data-testid=program-feed]")
    const lat = Number(feed?.getAttribute("data-latency-ms") || NaN)
    return { source: feed?.getAttribute("data-source") === "backup" ? "backup" : "main", screen: document.documentElement.dataset.screen ?? "", lat: Number.isFinite(lat) && feed?.getAttribute("data-playing") === "1" ? lat : null }
  }).catch(() => ({ source: prog.source, screen: "", lat: null }))
  const screen = info.screen
  // Main ↔ Backup (manual or failover): /stream has switched its on-air player; follow with the audio.
  // The adaptive delay re-locks on the new player's latency (same sync logic, fresh measurement).
  if (info.source !== prog.source) switchProgramSource(info.source)
  // Program player latency (relay live edge → picture), smoothed (~0.7s).
  if (info.lat !== null && info.lat > 0 && info.lat < 10000) prog.latencyMs = prog.latencyMs === null ? info.lat : prog.latencyMs * 0.92 + info.lat * 0.08 // ~3s: remote players jitter
  // A failed/empty page read (reload, busy page) is not "left the program": keep the last state.
  const wanted = screen === "" ? prog.wanted : screen === "program"
  if (wanted) { prog.lastWantedAt = Date.now(); if (!prog.wanted) { prog.wantedSince = Date.now(); prog.flowed = false; log("[audio] /stream shows the program: audio follows OBS") } }
  else if (prog.wanted) log("[audio] /stream left the program: audio bed back")
  prog.wanted = wanted
  if (wanted) { startProgramReader(); startSpare() }
  else if (prog.reader && Date.now() - prog.lastWantedAt > 10000) { stopProgramReader(); stopSpare() } // keep warm 10s for quick back-and-forth
}, 250)
ticker = setInterval(() => {
  if (!latest || !ffmpeg?.stdin.writable) return
  let due = Math.floor((timelineMs() * fps) / 1000) - written
  if (due <= 0) return
  if (due > 1) win.maxLag = Math.max(win.maxLag, ((due - 1) * 1000) / fps)
  // Encoder behind (more than ~6 frames queued in the pipe). Frames are stamped by count, so waiting
  // keeps sync; only past 0.5s drop frames, and move the shared timeline so audio drops the same span.
  if (ffmpeg.stdin.writableLength > latest.length * 6) {
    // (Not while ffmpeg is still opening its inputs: it needs the audio pipe to keep flowing.)
    if (due > fps / 2 && lastStatsLine) { skippedMs += ((due - 1) * 1000) / fps; win.skipped += due - 1 }
    return
  }
  // Frame to show: the latest, or (negative trim) the latest that arrived videoDelay ago.
  const hold = videoDelayMs()
  let frame = latest
  if (hold > 0) {
    const cutoff = Date.now() - hold
    for (let i = frameRing.length - 1; i >= 0; i--) if (frameRing[i].at <= cutoff) { frame = frameRing[i].buf; break }
  }
  for (let i = 0; i < due; i++) ffmpeg.stdin.write(frame)
  win.written += due
  win.repeats += freshFrame ? due - 1 : due
  freshFrame = false
  written += due
}, Math.max(5, Math.floor(1000 / fps / 2)))

// Stuck detection by page heartbeat (window.__hb, +1/s), not by repaints: a static LIVE/end/hold
// screen legitimately sends no screencast frames (the writer keeps repeating the last one).
// Reload only when the page's JS stops ticking; if reloads don't help, exit so the supervisor
// restarts the whole capture.
let lastHb = -1
let lastHbAt = Date.now()
let reloading = false
const reloads = []
setInterval(async () => {
  if (reloading || stopping) return
  const hb = await Promise.race([
    page.evaluate(() => window.__hb ?? -1),
    new Promise((resolve) => setTimeout(() => resolve(-2), 3000)),
  ]).catch(() => -2)
  if (typeof hb === "number" && hb >= 0 && hb !== lastHb) { lastHb = hb; lastHbAt = Date.now(); return }
  const quiet = Date.now() - lastHbAt
  if (quiet < 15000) return
  const now = Date.now()
  while (reloads.length && now - reloads[0] > 120000) reloads.shift()
  if (reloads.length >= 3) { log(`page heartbeat still stalled after ${reloads.length} reloads in 2 min; restarting capture`); void shutdown(9); return }
  reloads.push(now)
  log(`page heartbeat stalled ${Math.round(quiet / 1000)}s (${hb === -2 ? "page not responding" : "no tick"}); reloading /stream`)
  reloading = true
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 })
    sync.test = false // the overlay went with the old page; the poll re-adds it
    await page.waitForSelector("html[data-stream-ready]", { timeout: 15000 })
  } catch { log("reload failed"); void shutdown(9) }
  lastHb = -1
  lastHbAt = Date.now()
  reloading = false
}, 5000)
const encHist = []
if (statsFile) {
  setInterval(() => {
    const now = Date.now()
    const secs = Math.max(0.5, (now - win.at) / 1000)
    const total = win.written + win.skipped
    const stats = {
      at: now,
      codeVersion: CODE_VERSION,
      screencastFps: +(win.screencast / secs).toFixed(2),
      heartbeatAgeMs: Date.now() - lastHbAt,
      writtenFps: +(win.written / secs).toFixed(2),
      repeatPct: win.written ? +((win.repeats / win.written) * 100).toFixed(1) : 0,
      backpressurePct: total ? +((win.skipped / total) * 100).toFixed(1) : 0,
      maxLagMs: Math.round(win.maxLag),
      fps, encoder, bitrateK: bitrate, size: `${width}x${height}`,
      programAudio: { on: prog.wanted, reading: prog.reader !== null, mixing: prog.wanted && now - prog.mixedAt < 1500, peakDb: prog.peak > 0 ? +(20 * Math.log10(prog.peak / 32768)).toFixed(1) : null, bufferedMs: Math.round((prog.bytes / 4 / RATE) * 1000), underruns: prog.underruns, delayMs: Math.round(prog.targetMs), queuedMs: prog.levelMs === null ? null : Math.round(prog.levelMs), playerLatencyMs: prog.latencyMs === null ? null : Math.round(prog.latencyMs), corrections: prog.corrections, jumps: prog.jumps, jitterMs: prog.jitterMs == null ? null : Math.round(prog.jitterMs), source: prog.source, formats: { main: inputs.main.format, backup: inputs.backup.format } },
      sync: { screencastLagMs: sync.lagMs === null ? null : Math.round(sync.lagMs), trimMs: sync.trimMs, videoDelayMs: Math.round(videoDelayMs()), bedDelayMs: Math.round(bedLine.delayMs()), skippedMs: Math.round(skippedMs), test: sync.test },
      statsLine: lastStatsLine,
    }
    prog.peak = 0
    // Encoder rates over this window from ffmpeg's cumulative counters (its own fps/speed are averages since start).
    const m = /frame=\s*(\d+).*?size=\s*(\d+(?:\.\d+)?)\s*(KiB|kB|MiB|MB|B).*?time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(lastStatsLine)
    if (m) {
      const cur = { frame: +m[1], bytes: +m[2] * ({ B: 1, kB: 1000, KiB: 1024, MB: 1e6, MiB: 1048576 }[m[3]] ?? 1), out: (+m[4] * 60 + +m[5]) * 60 + +m[6], dup: +(/dup=\s*(\d+)/.exec(lastStatsLine)?.[1] ?? 0), drop: +(/drop=\s*(\d+)/.exec(lastStatsLine)?.[1] ?? 0) }
      if (encHist.length && cur.frame < encHist[encHist.length - 1].frame) encHist.length = 0 // ffmpeg restarted
      encHist.push({ ...cur, at: now })
      if (encHist.length > 4) encHist.shift()
      const prevEnc = encHist.length >= 3 ? encHist[0] : null
      if (prevEnc) {
        const dt = (now - prevEnc.at) / 1000
        stats.enc = { fps: +((cur.frame - prevEnc.frame) / dt).toFixed(1), kbps: Math.round(((cur.bytes - prevEnc.bytes) * 8) / dt / 1000), speed: +((cur.out - prevEnc.out) / dt).toFixed(2), dup: cur.dup, drop: cur.drop, bytes: cur.bytes }
      }
    }
    Object.assign(win, { at: now, screencast: 0, written: 0, repeats: 0, skipped: 0, maxLag: 0 })
    try {
      fs.writeFileSync(`${statsFile}.tmp`, JSON.stringify(stats), { mode: 0o600 })
      fs.renameSync(`${statsFile}.tmp`, statsFile)
    } catch { /* data dir gone */ }
  }, 2000).unref()
}
setInterval(() => log(`screencast frames: ${frames} in last 60s`), 60000).unref()
setInterval(() => { frames = 0 }, 60000).unref()
