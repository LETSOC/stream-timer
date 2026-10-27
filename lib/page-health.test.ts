import assert from "node:assert/strict"
import test from "node:test"
import { frameStateDue, latencyStateDue, memLine, ON_AIR_STUCK_MS, pageHung } from "./page-health.ts"

test("on-air watchdog waits 5s", () => assert.equal(ON_AIR_STUCK_MS, 5000))

test("page hung: tick gap over 2s only", () => {
  assert.equal(pageHung(null, 5000), false)
  assert.equal(pageHung(1000, 1150), false)
  assert.equal(pageHung(1000, 3000), false)
  assert.equal(pageHung(1000, 3001), true)
})

test("frame state: at most every 250ms", () => {
  assert.equal(frameStateDue(null, 0), true)
  assert.equal(frameStateDue(1000, 1150), false)
  assert.equal(frameStateDue(1000, 1250), true)
})

test("latency state: on a 100ms move, a null change, or 1s with any change", () => {
  assert.equal(latencyStateDue(null, 900, 0), true)
  assert.equal(latencyStateDue({ value: 900, at: 0 }, 950, 150), false)
  assert.equal(latencyStateDue({ value: 900, at: 0 }, 1000, 150), true)
  assert.equal(latencyStateDue({ value: 900, at: 0 }, null, 150), true)
  assert.equal(latencyStateDue({ value: 900, at: 0 }, 930, 1000), true)
  assert.equal(latencyStateDue({ value: 900, at: 0 }, 900, 5000), false)
})

test("[mem] line", () => {
  assert.equal(memLine({ usedBytes: 182 * 1048576, totalBytes: 240 * 1048576, hls: 2, video: 3, ctx: 2, rebuilds: 14 }), "[mem] heap 182/240MB · hls 2 · video 3 · ctx 2 · rebuilds 14")
  assert.equal(memLine({ usedBytes: null, totalBytes: null, hls: 0, video: 1, ctx: 0, rebuilds: 0 }), "[mem] heap n/a · hls 0 · video 1 · ctx 0 · rebuilds 0")
})
