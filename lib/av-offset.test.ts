import { test } from "node:test"
import assert from "node:assert/strict"
import { avDecodeArgs, avOffset, avOffsetLine, onsets, parseAvMetadata, type Sample } from "./av-offset"

// Synthetic capture: 25fps luma (flash = first 200ms of each second), 5ms audio RMS (beep = 100ms from offset).
const synth = (offsetS: number, opts: { flash?: boolean; beep?: boolean; secs?: number } = {}) => {
  const secs = opts.secs ?? 4
  const luma: Sample[] = []
  const rms: Sample[] = []
  for (let i = 0; i < secs * 25; i++) { const t = i / 25 + 0.28; luma.push({ t, v: opts.flash !== false && t % 1 < 0.2 ? 230 : 40 }) }
  for (let i = 0; i < secs * 200; i++) { const t = i / 200; const ph = (((t - offsetS) % 1) + 1) % 1; rms.push({ t, v: opts.beep !== false && ph < 0.1 ? -12 : -70 }) }
  return { luma, rms }
}

test("audio late: positive offset, read from the flash/beep pairs", () => {
  const { luma, rms } = synth(0.12)
  const r = avOffset(luma, rms)
  assert.ok(r)
  assert.ok(Math.abs(r.offsetMs - 120) <= 5, String(r.offsetMs))
  assert.ok(r.pairs >= 3)
  assert.match(avOffsetLine(r, "Main", "x"), /^A\/V offset \+12\dms \(audio late\) · Main/)
})

test("audio early: negative offset", () => {
  const { luma, rms } = synth(-0.08)
  const r = avOffset(luma, rms)
  assert.ok(r && Math.abs(r.offsetMs + 80) <= 5, String(r?.offsetMs))
  assert.match(avOffsetLine(r, "Backup", "x"), /audio early/)
})

test("no flash or no beep: silent (null)", () => {
  assert.equal(avOffset(...Object.values(synth(0.1, { flash: false })) as [Sample[], Sample[]]), null)
  assert.equal(avOffset(...Object.values(synth(0.1, { beep: false })) as [Sample[], Sample[]]), null)
})

test("a read starting mid-flash does not count the first sample as an onset", () => {
  const luma = [0, 0.04, 0.08, 0.2, 0.6, 1.0, 1.04, 1.2].map((t) => ({ t, v: t % 1 < 0.1 ? 230 : 40 }))
  assert.deepEqual(onsets(luma, 60, 0.3), [1.0])
})

test("parses ffmpeg metadata print lines (video luma, audio RMS, -inf)", () => {
  const text = [
    "[Parsed_metadata_2 @ 0x1] frame:0    pts:21      pts_time:0.021",
    "[Parsed_metadata_2 @ 0x1] lavfi.signalstats.YAVG=235.278",
    "[Parsed_ametadata_6 @ 0x2] frame:0    pts:0       pts_time:0",
    "[Parsed_ametadata_6 @ 0x2] lavfi.astats.Overall.RMS_level=-inf",
    "[Parsed_ametadata_6 @ 0x2] frame:1    pts:240     pts_time:0.005",
    "[Parsed_ametadata_6 @ 0x2] lavfi.astats.Overall.RMS_level=-23.5",
    "frame=  100 fps=0.0 q=-0.0 size=N/A",
  ].join("\n")
  const r = parseAvMetadata(text)
  assert.deepEqual(r.luma, [{ t: 0.021, v: 235.278 }])
  assert.deepEqual(r.rms, [{ t: 0, v: -120 }, { t: 0.005, v: -23.5 }])
})

test("decode args: one short read of the given URL, null output", () => {
  const a = avDecodeArgs("rtmp://127.0.0.1:19350/capture")
  assert.equal(a.filter((x) => x === "-i").length, 1)
  assert.deepEqual(a.slice(a.indexOf("-t"), a.indexOf("-t") + 2), ["-t", "4"])
  assert.deepEqual(a.slice(-3), ["-f", "null", "-"])
})
