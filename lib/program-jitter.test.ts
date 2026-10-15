import assert from "node:assert/strict"
import test from "node:test"
// @ts-expect-error plain .mjs script module
import { createJitterMeter, deadBandMs, splice, spliceFrames } from "../scripts/program-jitter.mjs"

function tone(frames: number, hz: number, rate = 48000, phase0 = 0) {
  const b = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) { const v = Math.round(10000 * Math.sin(2 * Math.PI * hz * (i + phase0) / rate)); b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2) }
  return b
}
/** Zero crossings per second → frequency estimate. */
function freq(b: Buffer, rate = 48000) {
  let z = 0; const n = b.length / 4
  for (let i = 1; i < n; i++) if ((b.readInt16LE((i - 1) * 4) < 0) !== (b.readInt16LE(i * 4) < 0)) z++
  return (z / 2) * (rate / n)
}

test("splice: d=0 is a copy; drop/repeat return exactly n frames", () => {
  const raw = tone(1200, 880)
  assert.deepEqual(splice(raw, 1200, 0), raw)
  assert.equal(splice(tone(1200, 880), 960, 240).length, 960 * 4)
  assert.equal(splice(tone(720, 880), 960, -240).length, 960 * 4)
  assert.throws(() => splice(tone(100, 880), 960, 0))
})

test("splices never change pitch: 880 Hz stays 880 Hz (vs ±16% resampling before)", () => {
  // 2s of output built from 20ms blocks with a splice every 5th block, alternating drop/repeat.
  const blocks: Buffer[] = []
  let pos = 0
  for (let k = 0; k < 100; k++) {
    const d = k % 5 === 0 ? (k % 10 === 0 ? 120 : -120) : 0
    blocks.push(splice(tone(960 + d, 880, 48000, pos), 960, d))
    pos += 960 + d
  }
  const f = freq(Buffer.concat(blocks))
  assert.ok(Math.abs(f - 880) < 880 * 0.01, `measured ${f}`)
})

test("splice crossfade has no hard discontinuity", () => {
  const out = splice(tone(1200, 440), 960, 240)
  let maxStep = 0
  for (let i = 1; i < 960; i++) maxStep = Math.max(maxStep, Math.abs(out.readInt16LE(i * 4) - out.readInt16LE((i - 1) * 4)))
  // a 440 Hz sine at 10000 moves at most ~576/sample; a hard cut could jump up to 20000
  assert.ok(maxStep < 1500, `max step ${maxStep}`)
})

test("dead band grows a little with jitter (max 40ms); no correction inside it", () => {
  assert.equal(deadBandMs(0), 15)
  assert.equal(deadBandMs(200), 25)
  assert.equal(deadBandMs(5000), 40) // never wider than the 40ms sync target
  assert.equal(spliceFrames(100, 115, 48000, 240), 0)
  assert.equal(spliceFrames(-19, 20, 48000, 240), 0)
  assert.equal(spliceFrames(200, 115, 48000, 240), 240)
  assert.equal(spliceFrames(-25, 20, 48000, 240), -240)
  assert.equal(spliceFrames(21, 20, 48000, 240), 528 > 240 ? 240 : 528)
})

test("jitter meter: spread of bursty levels over the window", () => {
  const m = createJitterMeter(1000)
  for (let t = 0; t < 3000; t += 20) m.add(1000 + ((t / 20) % 10 < 2 ? 180 : 0), t) // bursts of +180ms
  assert.equal(m.spreadMs(), 180)
  m.reset(); assert.equal(m.spreadMs(), 0)
  for (let t = 0; t < 3000; t += 20) m.add(1000, t)
  assert.equal(m.spreadMs(), 0)
})
