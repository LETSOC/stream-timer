import assert from "node:assert/strict"
import test from "node:test"
import { liveJumpTick, liveTarget, type LiveJumpState } from "./live-catchup"

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
