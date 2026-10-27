import { test } from "node:test"
import assert from "node:assert/strict"
import { crossfadeMsOf as capMs, equalPower, mixCrossfade, newFade, reverseFade, shouldCrossfade, switchLine, fadeProgress } from "../scripts/switch-crossfade.mjs"
import { crossfadeMsOf, equalPowerCurve, pageShouldFade } from "./switch-crossfade"
import { DEFAULT_FAILOVER, parseFailover } from "./program-source"

const RATE = 48000
const tone = (n: number, v: number) => { const b = Buffer.alloc(n * 4); for (let i = 0; i < n; i++) { b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2) } return b }

test("setting: 0 = Hard cut by default, clamped 100–1000 when on", () => {
  assert.equal(DEFAULT_FAILOVER.crossfadeMs, 0)
  assert.equal(parseFailover({}).crossfadeMs, 0)
  assert.equal(parseFailover({ crossfadeMs: 250 }).crossfadeMs, 250)
  assert.equal(parseFailover({ crossfadeMs: 20 }).crossfadeMs, 100)
  assert.equal(parseFailover({ crossfadeMs: 5000 }).crossfadeMs, 1000)
  assert.equal(parseFailover({ crossfadeMs: "x" }).crossfadeMs, 0)
  for (const f of [capMs, crossfadeMsOf]) { assert.equal(f(0), 0); assert.equal(f(-5), 0); assert.equal(f(250), 250); assert.equal(f(50), 100); assert.equal(f(2000), 1000) }
})

test("equal-power curve: ends, midpoint and constant power", () => {
  assert.deepEqual(equalPower(0), { gin: 0, gout: 1 })
  const end = equalPower(1)
  assert.ok(Math.abs(end.gin - 1) < 1e-12 && Math.abs(end.gout) < 1e-12)
  const mid = equalPower(0.5)
  assert.ok(Math.abs(mid.gin - Math.SQRT1_2) < 1e-12 && Math.abs(mid.gout - Math.SQRT1_2) < 1e-12) // not 0.5 (linear dip)
  for (let g = 0; g <= 1; g += 0.05) { const { gin, gout } = equalPower(g); assert.ok(Math.abs(gin * gin + gout * gout - 1) < 1e-9) }
})

test("gating: fade only when both inputs have audio queued", () => {
  assert.equal(shouldCrossfade({ ms: 250, outBytes: 100, inBytes: 100 }), true)
  assert.equal(shouldCrossfade({ ms: 0, outBytes: 100, inBytes: 100 }), false) // Hard cut
  assert.equal(shouldCrossfade({ ms: 250, outBytes: 0, inBytes: 100 }), false) // dead outgoing (failover)
  assert.equal(shouldCrossfade({ ms: 250, outBytes: 100, inBytes: 0 }), false) // incoming has no audio yet
  assert.equal(pageShouldFade({ ms: 250, outAlive: true, outRouted: true, inRouted: true }), true)
  assert.equal(pageShouldFade({ ms: 250, outAlive: false, outRouted: true, inRouted: true }), false)
  assert.equal(pageShouldFade({ ms: 250, outAlive: true, outRouted: false, inRouted: true }), false)
  assert.equal(pageShouldFade({ ms: 0, outAlive: true, outRouted: true, inRouted: true }), false)
})

test("mix: 250ms fade goes from all-outgoing to all-incoming", () => {
  const f = newFade(250, RATE)
  assert.equal(f.total, 12000)
  const first = mixCrossfade(tone(480, 10000), tone(480, -8000), f, 480)
  assert.equal(first.buf.readInt16LE(0), -8000) // g=0: outgoing only
  let done = first.done
  while (!done) done = mixCrossfade(tone(480, 10000), tone(480, -8000), f, 480).done
  const after = mixCrossfade(tone(4, 10000), tone(4, -8000), f, 4)
  assert.equal(after.buf.readInt16LE(0), 10000)
  assert.equal(fadeProgress(f), 1)
})

test("mid-fade re-switch continues from the current level (no jump)", () => {
  const f = newFade(250, RATE)
  mixCrossfade(null, null, f, 3000) // 25% in
  const before = equalPower(fadeProgress(f))
  const r = reverseFade(f)
  const after = equalPower(fadeProgress(r))
  // The input that was coming in is now going out at the same level, and vice versa.
  assert.ok(Math.abs(after.gout - before.gin) < 1e-9)
  assert.ok(Math.abs(after.gin - before.gout) < 1e-9)
  assert.equal(r.total, f.total)
})

test("page curve: from silence, and from a mid-fade level", () => {
  const full = equalPowerCurve(0, "in", 5)
  assert.equal(full.share, 1)
  assert.ok(Math.abs(full.curve[0]) < 1e-6 && Math.abs(full.curve[4] - 1) < 1e-6)
  assert.ok(Math.abs(full.curve[2] - Math.SQRT1_2) < 1e-6)
  const out = equalPowerCurve(1, "out", 5)
  assert.ok(Math.abs(out.curve[0] - 1) < 1e-6 && Math.abs(out.curve[4]) < 1e-6)
  const part = equalPowerCurve(Math.SQRT1_2, "in", 3) // reversed half-way: half the time left
  assert.ok(Math.abs(part.share - 0.5) < 1e-6 && Math.abs(part.curve[0] - Math.SQRT1_2) < 1e-6)
})

test("switch log line: delta, and a trim hint over 150ms", () => {
  assert.equal(switchLine({ ms: 250, faded: true, deltaMs: 42, to: "Backup" }), "[switch] crossfade 250ms, delta 42ms → Backup")
  assert.match(switchLine({ ms: 250, faded: true, deltaMs: -180, to: "Main" }), /delta -180ms → Main — over 150ms: tighten/)
  assert.match(switchLine({ ms: 0, faded: false, deltaMs: 10, to: "Main" }), /^\[switch\] hard cut, delta 10ms/)
  assert.match(switchLine({ ms: 250, faded: false, deltaMs: null, to: "Main" }), /crossfade skipped.*delta n\/a/)
})
