import assert from "node:assert/strict"
import test from "node:test"
import { liveJumpTick, liveTarget, newSettle, phoneLiveCount, PHONE_AMNESTY_MS, PHONE_COUNT_MAX, settleTick, SETTLE_RATE, type LiveJumpState } from "./live-catchup"

test("jump to live only after >3s behind for 1s, then not again for 5s", () => {
  const st: LiveJumpState = { overSince: null, lastJumpAt: 0 }
  assert.equal(liveJumpTick(st, 2500, 10_000), false)
  assert.equal(liveJumpTick(st, 8000, 10_150), false) // first sample over
  assert.equal(liveJumpTick(st, 8000, 10_900), false)
  assert.equal(liveJumpTick(st, 8000, 11_200), true)
  assert.equal(liveJumpTick(st, 8000, 12_300), false)
  assert.equal(liveJumpTick(st, 8000, 15_000), false) // still within 5s of the jump
  assert.equal(liveJumpTick(st, 8000, 16_300), true)
})

test("a single late sample does not jump; null latency resets", () => {
  const st: LiveJumpState = { overSince: null, lastJumpAt: 0 }
  assert.equal(liveJumpTick(st, 4000, 1_000), false)
  assert.equal(liveJumpTick(st, 1200, 1_150), false)
  assert.equal(liveJumpTick(st, 4000, 2_200), false)
  assert.equal(liveJumpTick(st, null, 2_400), false)
  assert.equal(liveJumpTick(st, 4000, 3_000), false)
})

test("live target: hls.js live sync position, else 1s inside the buffer; never backwards", () => {
  assert.equal(liveTarget(120, 125, 112), 120)
  assert.equal(liveTarget(null, 125, 112), 124)
  assert.equal(liveTarget(112.2, 125, 112), null)
  assert.equal(liveTarget(undefined, null, 5), null)
})

test("settle: after a stall leaves it 1.4s behind, catches up gently and reports done", () => {
  const st = newSettle()
  let t = 0
  for (; t < 5000; t += 150) assert.equal(settleTick(st, 2100, 2, t).rate, 1)
  // stall: now 3.5s behind
  let started = false
  for (; t < 20000; t += 150) { const s = settleTick(st, 3530, 2, t); if (s.event?.kind === "start") started = true }
  assert.ok(started)
  assert.equal(st.floorMs, 2000) // capped at the configured target
  let lat = 3530, done = null as null | number
  for (; t < 80000 && done === null; t += 150) { const s = settleTick(st, lat, 2, t); if (s.rate === SETTLE_RATE) lat -= 150 * 0.05; if (s.event?.kind === "done") done = s.event.toMs }
  assert.ok(done !== null && done <= 2400, `settled at ${done}`)
  assert.equal(settleTick(st, 2250, 2, t).rate, 1)
})

test("settle: a short blip doesn't start it; thin buffer aborts", () => {
  const st = newSettle()
  settleTick(st, 2000, 2, 0)
  for (let t = 150; t < 9000; t += 150) assert.equal(settleTick(st, 3000, 2, t).rate, 1)
  assert.equal(settleTick(st, 2000, 2, 9100).rate, 1)
  for (let t = 9200; t < 20000; t += 150) settleTick(st, 3000, 2, t)
  assert.equal(st.active, true)
  assert.equal(settleTick(st, 3000, 0.3, 20100).event?.kind, "abort")
  for (let t = 20200; t < 70000; t += 150) assert.equal(settleTick(st, 3000, 2, t).rate, 1)
  let again = false
  for (let t = 70000; t < 95000; t += 150) if (settleTick(st, 3000, 2, t).event?.kind === "start") again = true
  assert.ok(again)
})

test("settle: a restart that starts at 3.5s never learns 3.5s as normal (target 2s)", () => {
  const st = newSettle()
  let t = 0, started = false
  for (; t < 15000; t += 150) if (settleTick(st, 3500, 2, t).event?.kind === "start") started = true
  assert.ok(started)
  assert.ok(st.floorMs! <= 2000)
})

test("settle: a learned base lower than the target is kept", () => {
  const st = newSettle()
  for (let t = 0; t < 5000; t += 150) settleTick(st, 1400, 2, t)
  assert.equal(st.floorMs, 1400)
  for (let t = 5000; t < 16000; t += 150) settleTick(st, 2000, 2, t)
  assert.equal(st.active, true)
})

test("phone live count: empty, one stall, cap, amnesty", () => {
  const now = 1_000_000
  assert.equal(phoneLiveCount([], now), 5)
  assert.equal(phoneLiveCount([now - 1000], now), 6)
  assert.equal(phoneLiveCount(Array.from({ length: 10 }, (_, i) => now - i * 1000), now), PHONE_COUNT_MAX)
  assert.equal(phoneLiveCount([now - PHONE_AMNESTY_MS - 1, now - 500], now), 6) // old stall forgiven
})
