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
  assert.ok(r.avGapMs !== null && r.avGapMs < 40, String(r.avGapMs))
  assert.ok(r.kbps !== null && r.kbps > 2400 && r.kbps < 2700, String(r.kbps))
  assert.equal(probeLine(r).level, "·")
})

test("probe: A/V gap over 80ms is flagged", () => {
  const r = parseProbePackets(pkts({ fps: 25, secs: 4, avOffset: 0.15 }))
  assert.ok(r.avGapMs !== null && r.avGapMs >= 140, String(r.avGapMs))
  const line = probeLine(r)
  assert.equal(line.level, "!")
  assert.match(line.text, /over 80ms/)
})

test("probe: junk, empty and missing audio", () => {
  assert.deepEqual(parseProbePackets(""), { fps: null, avGapMs: null, keyframeS: null, kbps: null, video: 0, audio: 0 })
  assert.equal(parseProbePackets("garbage\ncodec_type=data|pts_time=1|size=5").video, 0)
  const noAudio = parseProbePackets(pkts({ fps: 30, secs: 4 }).split("\n").filter((l) => l.includes("video")).join("\n"))
  assert.equal(noAudio.avGapMs, null)
  assert.equal(probeLine(noAudio).level, "!")
})

test("probe args: short bounded read, URL last (never logged)", () => {
  const a = probeArgs("rtmp://127.0.0.1:1935/capture?user=u&pass=SECRET")
  assert.ok(a.includes("-read_intervals") && a.includes("-rw_timeout"))
  assert.equal(a[a.length - 1].includes("SECRET"), true)
  assert.ok(!probeLine(parseProbePackets(pkts({ fps: 30, secs: 4 }))).text.includes("SECRET"))
})
