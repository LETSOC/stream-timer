import { test } from "node:test"
import assert from "node:assert/strict"
import { encoderBehind, jpegQuality, mjpegHwaccelUsable, mjpegInputArgs } from "../scripts/capture-tuning.mjs"
import { captureEncoderNote } from "./dropout-monitor"

test("screencast JPEG quality: default 65, env override clamped to 30-95", () => {
  assert.equal(jpegQuality(undefined), 65)
  assert.equal(jpegQuality(""), 65)
  assert.equal(jpegQuality("abc"), 65)
  assert.equal(jpegQuality("80"), 80)
  assert.equal(jpegQuality("5"), 30)
  assert.equal(jpegQuality("100"), 95)
})

test("MJPEG input: hwaccel flag only when hardware decode is on, before -i", () => {
  assert.deepEqual(mjpegInputArgs(25, false), ["-f", "image2pipe", "-framerate", "25", "-c:v", "mjpeg", "-thread_queue_size", "1024", "-i", "pipe:0"])
  const hw = mjpegInputArgs(30, true)
  assert.deepEqual(hw.slice(0, 2), ["-hwaccel", "videotoolbox"])
  assert.ok(hw.indexOf("-hwaccel") < hw.indexOf("-i"))
})

test("VideoToolbox MJPEG decode is never tried off macOS or when disabled", () => {
  assert.equal(mjpegHwaccelUsable("ffmpeg", { platform: "linux", env: {} }), false)
  assert.equal(mjpegHwaccelUsable("ffmpeg", { platform: "darwin", env: { CAPTURE_MJPEG_HWACCEL: "0" } }), false)
  assert.equal(mjpegHwaccelUsable("/nonexistent/ffmpeg", { platform: "darwin", env: {} }), false)
})

test("[encoder] capture lines reach the dropout log", () => {
  assert.equal(captureEncoderNote("[capture 10:00:00] [encoder] screencast JPEG quality 65, 1920x1080; MJPEG decode: software")?.level, "·")
  assert.equal(captureEncoderNote("[capture 10:00:00] [encoder] ffmpeg exited (code 1) with VideoToolbox MJPEG decode; restarting with software decode")?.level, "!")
})

test("capture ffmpeg: video pipe has a 1024 thread queue, output waits for both streams", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../scripts/capture-stream.mjs", import.meta.url), "utf8")
  assert.match(src, /"-max_interleave_delta", "0", "-f", "flv"/)
  assert.ok(mjpegInputArgs(30, false).join(" ").includes("-thread_queue_size 1024 -i pipe:0"))
})

test("encoder-behind: counts frames in flight, not multiples of the latest JPEG size", () => {
  // A dark frame (8KB) after bright ones: 3 frames / 300KB queued is fine (old rule: 300KB > 8KB*6 = skip).
  assert.equal(encoderBehind({ framesInFlight: 3, bytesInFlight: 300_000 }), false)
  assert.equal(encoderBehind({ framesInFlight: 6, bytesInFlight: 1_000_000 }), false)
  assert.equal(encoderBehind({ framesInFlight: 7, bytesInFlight: 100_000 }), true)
  assert.equal(encoderBehind({ framesInFlight: 2, bytesInFlight: 9 * 1024 * 1024 }), true)
  assert.equal(encoderBehind({ framesInFlight: 0, bytesInFlight: 0 }), false)
})
