import assert from "node:assert/strict"
import test from "node:test"
// @ts-expect-error plain .mjs script module
import { createShowreelQueue, pushShowreel, takeShowreel, showreelBedGain, SHOWREEL_STALE_MS } from "../scripts/showreel-audio.mjs"

const chunk = (frames: number, v: number) => { const b = Buffer.alloc(frames * 4); for (let i = 0; i < frames; i++) { b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2) } return b }

test("empty or stale showreel queue: null, bed gain untouched (mix exactly as before)", () => {
  const q = createShowreelQueue()
  assert.equal(takeShowreel(q, 480, 100, 1000), null)
  assert.equal(q.gain, 1)
  pushShowreel(q, chunk(48000, 5), 1000)
  assert.equal(takeShowreel(q, 480, 100, 1000 + SHOWREEL_STALE_MS + 1), null)
  assert.equal(q.bytes, 0)
})

test("showreel PCM is delayed to the target, then mixed; bed ducks to 0 and comes back", () => {
  const q = createShowreelQueue()
  pushShowreel(q, chunk(2400, 1234), 1000) // 50ms < 100ms target
  assert.equal(takeShowreel(q, 480, 100, 1000), null)
  pushShowreel(q, chunk(4800, 1234), 1000)
  const out = takeShowreel(q, 480, 100, 1000)
  assert.ok(out)
  assert.equal(out.readInt16LE(0), 1234)
  // simulate the pcmBlock loop: bed 0.5 with gain ramp
  const step = 1 / (0.2 * 48000)
  let g = 1
  for (let i = 0; i < 9600; i++) g = showreelBedGain(q, true, step)
  assert.equal(g, 0)
  for (let i = 0; i < 9600; i++) g = showreelBedGain(q, false, step)
  assert.equal(g, 1)
})

test("too much queued (>300ms over target) drops back to the target", () => {
  const q = createShowreelQueue()
  pushShowreel(q, chunk(48000, 1), 0)
  takeShowreel(q, 480, 100, 0)
  assert.ok(q.bytes <= Math.round(0.1 * 48000) * 4)
})

