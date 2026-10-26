import { test } from "node:test"
import assert from "node:assert/strict"
import { jpegQuality, mjpegHwaccelUsable, mjpegInputArgs } from "../scripts/capture-tuning.mjs"
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
  assert.deepEqual(mjpegInputArgs(25, false), ["-f", "image2pipe", "-framerate", "25", "-c:v", "mjpeg", "-i", "pipe:0"])
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
