#!/usr/bin/env node
// Browser capture: renders the real /stream page in headless Chromium and publishes it to RTMP.
//
// Frames come from the Chrome DevTools screencast (Page.startScreencast), which pushes a JPEG
// whenever the page repaints. A fixed-rate timer writes the latest frame into ffmpeg's
// image2pipe at CAPTURE_FPS, so the output is constant frame rate even when the page is still.
// Audio: AUDIO_ARGS_FILE (lib/audio-bed.ts: silence, tone or a looped bed); silence if missing.
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
import { chromium } from "playwright"

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

// Stream audio: one ffmpeg arg per line plus "@requires <file>" / "@filter <af>" lines.
let audioIn = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
let audioAf = "aresample=48000:async=1000:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
if (process.env.AUDIO_ARGS_FILE) {
  try {
    const lines = fs.readFileSync(process.env.AUDIO_ARGS_FILE, "utf8").split("\n").filter(Boolean)
    const missing = lines.filter((l) => l.startsWith("@requires ") && !fs.existsSync(l.slice(10)))
    const args = lines.filter((l) => !l.startsWith("@"))
    const af = lines.find((l) => l.startsWith("@filter "))?.slice(8)
    if (missing.length === 0 && args.length) { audioIn = args; if (af) audioAf = af }
    else log("[audio] audio bed file missing; streaming silence")
  } catch { log("[audio] audio settings unreadable; streaming silence") }
}
// Keyframe every 2s (YouTube/Castr want ≤ 2s), CBR-ish: maxrate = bitrate, 2s buffer.
const gop = String(fps * 2)
const videoArgs = encoder === "h264_videotoolbox"
  ? ["-c:v", "h264_videotoolbox", "-realtime", "1", "-profile:v", "high", "-b:v", `${bitrate}k`,
     ...(vtCbr ? ["-constant_bit_rate", "1"] : ["-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`]),
     "-g", gop, "-keyint_min", gop, "-force_key_frames", `expr:gte(t,n_forced*2)`]
  : ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "high", "-b:v", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`, "-nal-hrd", "cbr", "-g", gop, "-keyint_min", gop, "-sc_threshold", "0", "-x264-params", "force-cfr=1"]

// ---------- program audio (fd 3: s16le, 48k, 3 channels = program L, program R, bed gain) ----------
const RATE = 48000
const programFile = process.env.PROGRAM_READ_FILE || ""
const progDelayMs = Math.min(5000, Math.max(0, Number(process.env.CAPTURE_PROGRAM_AUDIO_DELAY_MS ?? 1170) || 0))
const prog = { wanted: false, reader: null, chunks: [], bytes: 0, primed: false, underruns: 0, gain: 1, lastWantedAt: 0, restartAt: 0, peak: 0, mixedAt: 0 }
const delayBytes = Math.round((progDelayMs / 1000) * RATE) * 4
function startProgramReader() {
  if (prog.reader || !programFile || Date.now() < prog.restartAt) return
  let url = ""
  try { url = fs.readFileSync(programFile, "utf8").trim() } catch { return }
  if (!url) return
  const reader = spawn(ffmpegBin, ["-nostdin", "-hide_banner", "-loglevel", "error", "-rw_timeout", "5000000", "-i", url, "-vn", "-ac", "2", "-ar", String(RATE), "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"], env: childEnv })
  prog.reader = reader
  reader.stdout.on("data", (chunk) => {
    prog.chunks.push(chunk)
    prog.bytes += chunk.length
    // Never let the buffer grow past delay + 0.15s (clock drift / bursts): drop the oldest audio.
    const max = delayBytes + RATE * 4 * 0.15
    while (prog.bytes > max && prog.chunks.length) {
      const extra = prog.bytes - delayBytes
      const head = prog.chunks[0]
      if (head.length <= extra) { prog.chunks.shift(); prog.bytes -= head.length }
      else { const cut = extra - (extra % 4); prog.chunks[0] = head.subarray(cut); prog.bytes -= cut }
    }
  })
  reader.on("exit", () => {
    if (prog.reader === reader) prog.reader = null
    prog.chunks = []; prog.bytes = 0; prog.primed = false
    prog.restartAt = Date.now() + 2000
  })
  log("[audio] program audio: reading the OBS feed")
}
function stopProgramReader() {
  if (!prog.reader) return
  prog.reader.kill("SIGTERM")
  prog.reader = null
  prog.chunks = []; prog.bytes = 0; prog.primed = false
  log("[audio] program audio: off")
}
/** Take `n` stereo frames from the program buffer (or null while it (re)fills to the delay). */
function takeProgram(n) {
  if (!prog.primed) {
    if (prog.bytes < delayBytes || prog.bytes === 0) return null
    prog.primed = true
  }
  const want = n * 4
  if (prog.bytes < want) { prog.primed = false; prog.underruns += 1; return null }
  const out = Buffer.allocUnsafe(want)
  let at = 0
  while (at < want) {
    const head = prog.chunks[0]
    const take = Math.min(head.length, want - at)
    head.copy(out, at, 0, take)
    at += take
    if (take === head.length) prog.chunks.shift()
    else prog.chunks[0] = head.subarray(take)
  }
  prog.bytes -= want
  return out
}
const GAIN_STEP = 1 / (0.2 * RATE)
function pcmBlock(n) {
  const programPcm = prog.wanted ? takeProgram(n) : null
  const out = Buffer.alloc(n * 6)
  // Fade the bed out only once program audio is actually flowing (no hole while the reader starts).
  const target = programPcm ? 0 : 1
  if (programPcm) prog.mixedAt = Date.now()
  for (let i = 0; i < n; i++) {
    if (prog.gain < target) prog.gain = Math.min(target, prog.gain + GAIN_STEP)
    else if (prog.gain > target) prog.gain = Math.max(target, prog.gain - GAIN_STEP)
    if (programPcm) {
      const l = programPcm.readInt16LE(i * 4)
      const r = programPcm.readInt16LE(i * 4 + 2)
      out.writeInt16LE(l, i * 6)
      out.writeInt16LE(r, i * 6 + 2)
      const m = Math.max(Math.abs(l), Math.abs(r))
      if (m > prog.peak) prog.peak = m
    }
    out.writeInt16LE(Math.round(prog.gain * 32767), i * 6 + 4)
  }
  return out
}

const childEnv = { ...process.env }
delete childEnv.ENCODER_TOKEN
delete childEnv.RTMP_URL
delete childEnv.CAPTURE_URL
delete childEnv.CAPTURE_KEY_FILE
delete childEnv.PROGRAM_READ_FILE

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
  try { prog.reader?.kill("SIGTERM") } catch { /* gone */ }
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
cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
  latest = Buffer.from(data, "base64")
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
  ...audioIn,
  "-f", "s16le", "-ar", String(RATE), "-ac", "3", "-i", "pipe:3",
  "-filter_complex", [
    `[1:a]${audioAf}[bed]`,
    "[2:a]asplit[pa][pb]",
    "[pa]pan=stereo|c0=c0|c1=c1,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[prog]",
    "[pb]pan=stereo|c0=c2|c1=c2,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[gain]",
    "[bed][gain]amultiply[bedg]",
    "[bedg][prog]amix=inputs=2:normalize=0:duration=longest,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]",
  ].join(";"),
  "-map", "0:v", "-map", "[aout]",
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
// Audio pipe paced by the same wall clock as the frames, so audio and video stay locked.
let pcmWritten = 0
audioTicker = setInterval(() => {
  if (!pcmOut.writable) return
  const due = Math.floor(((Date.now() - startedAt) * RATE) / 1000) - pcmWritten
  if (due <= 0) return
  const n = Math.min(due, RATE) // after a long stall don't write more than 1s at once
  pcmOut.write(pcmBlock(n))
  pcmWritten += due
}, 20)
// Which screen is /stream on? (set by the page; polled cheaply)
setInterval(async () => {
  if (stopping || reloading) return
  const screen = await page.evaluate(() => document.documentElement.dataset.screen ?? "").catch(() => "")
  const wanted = screen === "program"
  if (wanted) { prog.lastWantedAt = Date.now(); if (!prog.wanted) log("[audio] /stream shows the program: audio follows OBS") }
  else if (prog.wanted) log("[audio] /stream left the program: audio bed back")
  prog.wanted = wanted
  if (wanted) startProgramReader()
  else if (prog.reader && Date.now() - prog.lastWantedAt > 10000) stopProgramReader() // keep warm 10s for quick back-and-forth
}, 250)
ticker = setInterval(() => {
  if (!latest || !ffmpeg?.stdin.writable) return
  const due = Math.floor(((Date.now() - startedAt) * fps) / 1000) - written
  if (due <= 0) return
  if (due > 1) win.maxLag = Math.max(win.maxLag, ((due - 1) * 1000) / fps)
  if (ffmpeg.stdin.writableNeedDrain) { written += due; win.skipped += due; return } // encoder behind: drop, don't queue
  const n = Math.min(due, 3)
  for (let i = 0; i < n; i++) ffmpeg.stdin.write(latest)
  win.written += n
  win.skipped += due - n
  win.repeats += freshFrame ? n - 1 : n
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
      screencastFps: +(win.screencast / secs).toFixed(2),
      heartbeatAgeMs: Date.now() - lastHbAt,
      writtenFps: +(win.written / secs).toFixed(2),
      repeatPct: win.written ? +((win.repeats / win.written) * 100).toFixed(1) : 0,
      backpressurePct: total ? +((win.skipped / total) * 100).toFixed(1) : 0,
      maxLagMs: Math.round(win.maxLag),
      fps, encoder, bitrateK: bitrate, size: `${width}x${height}`,
      programAudio: { on: prog.wanted, reading: prog.reader !== null, mixing: prog.wanted && now - prog.mixedAt < 1500, peakDb: prog.peak > 0 ? +(20 * Math.log10(prog.peak / 32768)).toFixed(1) : null, bufferedMs: Math.round((prog.bytes / 4 / RATE) * 1000), underruns: prog.underruns, delayMs: progDelayMs },
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
