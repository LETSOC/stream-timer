#!/usr/bin/env node
// Browser capture: renders the real /stream page in headless Chromium and publishes it to RTMP.
//
// Frames come from the Chrome DevTools screencast (Page.startScreencast), which pushes a JPEG
// whenever the page repaints. A fixed-rate timer writes the latest frame into ffmpeg's
// image2pipe at CAPTURE_FPS, so the output is constant frame rate even when the page is still.
// A silent stereo track (anullsrc) is added because Castr/Restream expect audio.
//
// Env: CAPTURE_URL (http://127.0.0.1:PORT/stream?k=VIEWKEY), RTMP_URL, CAPTURE_SIZE (1280x720 |
// 1920x1080), CAPTURE_FPS (default 30), FFMPEG_BIN. Never prints either URL (they hold keys).
// Exits non-zero on any failure so rtmp-supervisor.sh restarts it.
import { spawn } from "node:child_process"
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
const bitrate = width >= 1920 ? 4500 : 2500

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

log(`starting ${width}x${height} @ ${fps}fps, ${bitrate}k`)
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
cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
  latest = Buffer.from(data, "base64")
  frames += 1
  lastFrameAt = Date.now()
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined)
})
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: width, maxHeight: height, everyNthFrame: 1 })
// The first frame can take a moment; take one screenshot so we never start on nothing.
latest = await page.screenshot({ type: "jpeg", quality: 85 })

const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg"
ffmpeg = spawn(ffmpegBin, [
  "-hide_banner", "-loglevel", "info", "-stats_period", "10",
  "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "pipe:0",
  "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
  "-map", "0:v", "-map", "1:a",
  "-vf", `scale=${width}:${height}:flags=bicubic,format=yuv420p`,
  "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "high",
  "-b:v", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`,
  "-g", String(fps * 2), "-keyint_min", String(fps * 2), "-sc_threshold", "0", "-r", String(fps),
  "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
  "-f", "flv", "-flvflags", "no_duration_filesize", rtmpUrl,
], { stdio: ["pipe", "inherit", "pipe"], env: childEnv })
ffmpeg.stdin.on("error", () => undefined)
// ffmpeg prints the output URL ("Output #0, flv, to 'rtmp://…/KEY'"): redact before it reaches the log.
const hideKey = (text) => text.split(rtmpUrl).join("rtmp://[destination]").replace(/(rtmps?:\/\/[^\s/'"]+)\/[^\s'"]*/gi, "$1/••••").replace(/(password=)[^\s&'"]+/gi, "$1••••")
ffmpeg.stderr.on("data", (chunk) => process.stderr.write(hideKey(chunk.toString("utf8"))))
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
  if (ffmpeg.stdin.writableNeedDrain) { written += due; return } // encoder behind: drop, don't queue
  for (let i = 0; i < Math.min(due, 3); i++) ffmpeg.stdin.write(latest)
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
setInterval(() => log(`screencast frames: ${frames} in last 60s`), 60000).unref()
setInterval(() => { frames = 0 }, 60000).unref()
