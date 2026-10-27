import { test } from "node:test"
import assert from "node:assert/strict"
import { parseProbePackets, probeArgs, probeLine } from "./output-probe"

const pkts = (opts: { fps: number; secs: number; avOffset?: number; gop?: number; vSize?: number }) => {
  const lines: string[] = []
  const gop = opts.gop ?? 2
  for (let i = 0; i < opts.fps * opts.secs; i++) lines.push(`codec_type=video|pts_time=${(i / opts.fps).toFixed(6)}|size=${opts.vSize ?? 10000}|flags=${i % (opts.fps * gop) === 0 ? "K__" : "___"}`)
  for (let t = 0; t < opts.secs; t += 1024 / 48000) lines.push(`codec_type=audio|pts_time=${(t + (opts.avOffset ?? 0)).toFixed(6)}|size=300|flags=K__`)
  return lines.join("\n")
}

test("probe: fps, keyframe interval and bitrate from packets", () => {
  const r = parseProbePackets(pkts({ fps: 30, secs: 4 }))
  assert.equal(r.fps, 30)
  assert.equal(r.keyframeS, 2)
  assert.ok(r.gapMs !== null && r.gapMs < 40, String(r.gapMs))
  assert.ok(r.kbps !== null && r.kbps > 2400 && r.kbps < 2700, String(r.kbps))
  assert.equal(probeLine(r).level, "·")
})

test("probe: interleave gap over 80ms is flagged", () => {
  const r = parseProbePackets(pkts({ fps: 25, secs: 4, avOffset: 0.15 }))
  assert.ok(r.gapMs !== null && r.gapMs >= 140, String(r.gapMs))
  const line = probeLine(r)
  assert.equal(line.level, "!")
  assert.match(line.text, /interleave gap \d+ms \(over 80ms\)/)
})

test("probe: audio before the first keyframe is ignored (the old 0–2s sawtooth)", () => {
  // Reader joined 1.5s before a keyframe: audio from 0s, video only from the keyframe at 1.5s.
  const lines: string[] = []
  for (let i = 0; i < 25 * 4; i++) lines.push(`codec_type=video|pts_time=${(1.5 + i / 25).toFixed(6)}|size=12500|flags=${i % 50 === 0 ? "K__" : "___"}`)
  for (let t = 0; t < 5.5; t += 1024 / 48000) lines.push(`codec_type=audio|pts_time=${t.toFixed(6)}|size=300|flags=K__`)
  const r = parseProbePackets(lines.join("\n"))
  assert.ok(r.gapMs !== null && r.gapMs < 40, String(r.gapMs))
  assert.ok(r.kbps !== null && r.kbps > 2500 && r.kbps < 2800, String(r.kbps))
  assert.equal(r.keyframeS, 2)
})

test("probe: non-keyframe video before the first keyframe is dropped too", () => {
  const lines = [`codec_type=video|pts_time=0.000000|size=9000|flags=___`, `codec_type=video|pts_time=0.040000|size=9000|flags=___`]
  for (let i = 0; i < 75; i++) lines.push(`codec_type=video|pts_time=${(1 + i / 25).toFixed(6)}|size=9000|flags=${i % 50 === 0 ? "K__" : "___"}`)
  for (let t = 1; t < 4; t += 1024 / 48000) lines.push(`codec_type=audio|pts_time=${t.toFixed(6)}|size=300|flags=K__`)
  const r = parseProbePackets(lines.join("\n"))
  assert.equal(r.video, 75)
  assert.equal(r.fps, 25)
})

test("probe: junk, empty and missing audio", () => {
  assert.deepEqual(parseProbePackets(""), { fps: null, gapMs: null, keyframeS: null, kbps: null, video: 0, audio: 0 })
  assert.equal(parseProbePackets("garbage\ncodec_type=data|pts_time=1|size=5").video, 0)
  const noAudio = parseProbePackets(pkts({ fps: 30, secs: 4 }).split("\n").filter((l) => l.includes("video")).join("\n"))
  assert.equal(noAudio.gapMs, null)
  assert.equal(probeLine(noAudio).level, "!")
})

test("probe args: short bounded read, URL last (never logged)", () => {
  const a = probeArgs("rtmp://127.0.0.1:1935/capture?user=u&pass=SECRET")
  assert.ok(a.includes("-read_intervals") && a.includes("-rw_timeout"))
  assert.equal(a[a.length - 1].includes("SECRET"), true)
  assert.ok(!probeLine(parseProbePackets(pkts({ fps: 30, secs: 4 }))).text.includes("SECRET"))
})
