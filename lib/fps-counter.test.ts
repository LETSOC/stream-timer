import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { FPS_SAMPLE_MS, fpsReading, newFpsCounter, onFramecrcLine, onStatsLine } from "@/lib/fps-counter"
import { probeArgs } from "@/lib/input-probe"

// Header as FFmpeg 6.1.1 prints it for the relay's /program read (video = stream 0).
const HEADER = ["#extradata 0:       44, 0x0ae40c0b", "#software: Lavf60.16.100", "#tb 0: 1/1000", "#media_type 0: video", "#codec_id 0: h264", "#dimensions 0: 1280x720", "#tb 1: 1/1000", "#media_type 1: audio", "#codec_id 1: aac"]
const vLine = (pts: number) => `0,     ${pts},     ${pts},       33,      905, 0xdbb7bec0, F=0x0`
const aLine = (pts: number) => `1,     ${pts},     ${pts},       21,      371, 0x1234abcd`

/** Feed `seconds` of a steady stream at `fps` (plus ~47 audio packets/s), one packet per tick. */
function feed(c: ReturnType<typeof newFpsCounter>, start: number, seconds: number, fps: number) {
  const n = Math.round(seconds * fps)
  for (let i = 0; i < n; i++) {
    const t = start + (i * 1000) / fps
    onFramecrcLine(c, vLine(Math.round(t)), t)
    if (i % 2 === 0) onFramecrcLine(c, aLine(Math.round(t)), t)
  }
  return start + seconds * 1000
}

test("framecrc: counts only video packets, 30 fps steady → fps 30 and fpsMin after 3 samples", () => {
  const c = newFpsCounter()
  for (const line of HEADER) onFramecrcLine(c, line, 0)
  assert.equal(c.videoIndex, 0)
  feed(c, 0, 8, 30)
  assert.equal(c.source, "packets")
  assert.ok(c.fps !== null && Math.abs(c.fps - 30) <= 0.6, String(c.fps))
  assert.ok(c.fpsMin !== null && Math.abs(c.fpsMin - 30) <= 0.6, String(c.fpsMin))
  assert.deepEqual(fpsReading(c, 8000), { fps: c.fps, fpsMin: c.fpsMin })
})

test("framecrc: video on stream 1 (audio first), 25 fps", () => {
  const c = newFpsCounter()
  for (const line of ["#tb 0: 1/44100", "#media_type 0: audio", "#tb 1: 1/30", "#media_type 1: video"]) onFramecrcLine(c, line, 0)
  assert.equal(c.videoIndex, 1)
  for (let i = 0; i < 200; i++) {
    const t = i * 40
    onFramecrcLine(c, `1,  ${i},  ${i},  1,  5000, 0xdeadbeef`, t) // video
    onFramecrcLine(c, `0,  ${i * 1764},  ${i * 1764},  1764,  3528, 0x0`, t) // audio, ignored
  }
  assert.ok(c.fps !== null && Math.abs(c.fps - 25) <= 0.6, String(c.fps))
})

test("framecrc: packet lines before the header, junk and empty lines are ignored", () => {
  const c = newFpsCounter()
  onFramecrcLine(c, vLine(9), 0)
  assert.equal(c.source, null)
  for (const line of HEADER) onFramecrcLine(c, line, 0)
  for (const junk of ["", "garbage", "#media_type 2: data", "x, 1, 2, 3"]) onFramecrcLine(c, junk, 1)
  assert.equal(c.frames, 0)
})

test("a frame drop shows in fps and fpsMin; a stall reads 0 after 2s", () => {
  const c = newFpsCounter()
  for (const line of HEADER) onFramecrcLine(c, line, 0)
  let t = feed(c, 0, 6, 30)
  t = feed(c, t, 4, 15)
  assert.ok(c.fps !== null && c.fps < 20, String(c.fps))
  assert.ok(c.fpsMin !== null && c.fpsMin < 20)
  assert.deepEqual(fpsReading(c, t + 2500), { fps: 0, fpsMin: 0 })
})

test("stats fallback: frame= lines (FFmpeg 7/8) work until packets arrive; 6.1 lines without frame= are ignored", () => {
  const c = newFpsCounter()
  onStatsLine(c, "size=N/A time=00:00:04.22 bitrate=N/A speed=1.65x", 0) // FFmpeg 6.1 stream copy
  assert.equal(c.source, null)
  for (let i = 0; i <= 16; i++) onStatsLine(c, `frame= ${i * 15} fps= 30 q=-1.0 size=N/A time=00:00:0${Math.floor(i / 2)}.00 bitrate=N/A speed=1x`, i * 500)
  assert.equal(c.source, "stats")
  assert.ok(c.fps !== null && Math.abs(c.fps - 30) <= 0.6, String(c.fps))
  assert.ok(c.fpsMin !== null)
  // framecrc packets take over and the stats lines stop counting
  for (const line of HEADER) onFramecrcLine(c, line, 8000)
  onFramecrcLine(c, vLine(8000), 8000)
  assert.equal(c.source, "packets")
  assert.equal(c.frames, 1)
  onStatsLine(c, "frame= 9999 fps= 30", 8100)
  assert.equal(c.frames, 1)
})

test("no sample before the first window closes", () => {
  const c = newFpsCounter()
  for (const line of HEADER) onFramecrcLine(c, line, 0)
  feed(c, 0, (FPS_SAMPLE_MS - 100) / 1000, 30)
  assert.equal(c.fps, null)
  assert.equal(c.fpsMin, null)
})

test("probeArgs: stream copy, framecrc on stdout, no decode", () => {
  const args = probeArgs("rtmp://127.0.0.1:19350/program?user=u&pass=p")
  assert.deepEqual(args.slice(args.indexOf("-map")), ["-map", "0", "-c", "copy", "-f", "framecrc", "pipe:1"])
  assert.ok(args.includes("-stats_period"))
})

test("real ffmpeg: framecrc of a 30 fps clip yields one video line per frame", { skip: spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-version"]).status !== 0 }, () => {
  const bin = process.env.FFMPEG_BIN || "ffmpeg"
  const r = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=160x90:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2", "-map", "1", "-map", "0", "-c:v", "mpeg4", "-c:a", "pcm_s16le", "-f", "nut", "pipe:1"], { maxBuffer: 1 << 26 })
  assert.equal(r.status, 0, String(r.stderr))
  const probe = spawnSync(bin, probeArgs("pipe:0").map((a) => (a === "-rw_timeout" || a === "5000000" ? "" : a)).filter(Boolean), { input: r.stdout, encoding: "utf8", maxBuffer: 1 << 26 })
  assert.equal(probe.status, 0, probe.stderr)
  const c = newFpsCounter()
  probe.stdout.split("\n").forEach((line, i) => onFramecrcLine(c, line, i))
  assert.equal(c.videoIndex, 1)
  assert.equal(c.frames, 60)
})
