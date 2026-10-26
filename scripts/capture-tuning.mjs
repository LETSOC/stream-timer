// Pure helpers for scripts/capture-stream.mjs (unit-tested in lib/capture-tuning.test.ts).
import { spawnSync } from "node:child_process"

/** Screencast JPEG quality: CAPTURE_JPEG_QUALITY (30-95), default 65 (was 85: big frames for little visible gain). */
export function jpegQuality(raw) {
  const n = Math.round(Number(raw))
  return Number.isFinite(n) && n > 0 ? Math.min(95, Math.max(30, n)) : 65
}

/** Input args for the screencast JPEG pipe; `hw` = decode the MJPEG with VideoToolbox. */
export function mjpegInputArgs(fps, hw) {
  return [...(hw ? ["-hwaccel", "videotoolbox"] : []), "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-thread_queue_size", "1024", "-i", "pipe:0"]
}

/**
 * Does this ffmpeg decode MJPEG with VideoToolbox? Off unless macOS; CAPTURE_MJPEG_HWACCEL=0 turns it off.
 * Encodes one tiny JPEG, then decodes it with -hwaccel videotoolbox; any error output = no.
 */
export function mjpegHwaccelUsable(ffmpegBin, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "darwin" || env.CAPTURE_MJPEG_HWACCEL === "0") return false
  const jpg = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180", "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { timeout: 8000 })
  if (jpg.status !== 0 || !jpg.stdout?.length) return false
  const dec = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", ...mjpegInputArgs(30, true), "-f", "null", "-"], { input: jpg.stdout, timeout: 8000 })
  return dec.status === 0 && !String(dec.stderr ?? "").trim()
}
