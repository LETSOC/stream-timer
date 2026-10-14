#!/usr/bin/env node
// Browser capture: renders the real /stream page in headless Chromium and publishes it to RTMP.
//
// Frames come from the Chrome DevTools screencast (Page.startScreencast), which pushes a JPEG
// whenever the page repaints. A fixed-rate timer writes the latest frame into ffmpeg's
// image2pipe at CAPTURE_FPS, so the output is constant frame rate even when the page is still.
// Audio: AUDIO_ARGS_FILE (lib/audio-bed.ts: silence, tone or a looped bed); silence if missing.
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

const childEnv = { ...process.env }
delete childEnv.ENCODER_TOKEN
delete childEnv.RTMP_URL
delete childEnv.CAPTURE_URL

let browser = null
let ffmpeg = null
let ticker = null
let stopping = false

async function shutdown(code) {
  if (stopping) return
  stopping = true
  if (ticker) clearInterval(ticker)
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
const page = await context.newPage()
page.on("crash", () => { log("page crashed"); void shutdown(6) })
const response = await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 20000 }).catch(() => null)
if (!response || !response.ok()) {
  log(`could not load /stream (status ${response?.status() ?? "none"})`)
  await shutdown(7)
}
if (await page.getByText("View key required").count()) {
  log("/stream says the view key is wrong")
  await shutdown(8)
}
// Transparent edition renders over black in the stream (no alpha in H.264).
const cdp = await context.newCDPSession(page)
await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 1 } })

let latest = null
let frames = 0
let lastFrameAt = Date.now()
// Health counters, reset every stats window.
const win = { at: Date.now(), screencast: 0, written: 0, repeats: 0, skipped: 0, maxLag: 0 }
let freshFrame = false
cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
  latest = Buffer.from(data, "base64")
  frames += 1
  win.screencast += 1
  freshFrame = true
  lastFrameAt = Date.now()
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined)
})
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: width, maxHeight: height, everyNthFrame: 1 })
// The first frame can take a moment; take one screenshot so we never start on nothing.
latest = await page.screenshot({ type: "jpeg", quality: 85 })

ffmpeg = spawn(ffmpegBin, [
  "-hide_banner", "-loglevel", "info", "-stats_period", "2",
  "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "pipe:0",
  ...audioIn,
  "-map", "0:v", "-map", "1:a",
  "-vf", `scale=${width}:${height}:flags=bicubic,format=yuv420p`,
  ...videoArgs, "-r", String(fps),
  "-af", audioAf, "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
  "-f", "flv", "-flvflags", "no_duration_filesize", rtmpUrl,
], { stdio: ["pipe", "inherit", "pipe"], env: childEnv })
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

// Health: the countdown repaints every second, so a long silence means the page is stuck.
setInterval(() => {
  const quiet = Date.now() - lastFrameAt
  if (quiet > 15000) {
    log(`no repaint for ${Math.round(quiet / 1000)}s; reloading /stream`)
    lastFrameAt = Date.now()
    page.reload({ waitUntil: "networkidle", timeout: 20000 }).catch(() => { log("reload failed"); void shutdown(9) })
  }
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
      writtenFps: +(win.written / secs).toFixed(2),
      repeatPct: win.written ? +((win.repeats / win.written) * 100).toFixed(1) : 0,
      backpressurePct: total ? +((win.skipped / total) * 100).toFixed(1) : 0,
      maxLagMs: Math.round(win.maxLag),
      fps, encoder, bitrateK: bitrate, size: `${width}x${height}`,
      statsLine: lastStatsLine,
    }
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
