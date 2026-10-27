import assert from "node:assert/strict"
import test from "node:test"
import { alignTick, newAlign, onAirLatency, reportPlayerLatency } from "./pair-align"

test("standby far behind seeks forward inside its buffer, then not again for 3s", () => {
  const st = newAlign()
  assert.deepEqual(alignTick(st, 900, 2, 0, 0).seekSec, 0.9)
  assert.equal(alignTick(st, 900, 2, 0, 1000).seekSec, null)
})
test("no seek without buffer: rate trim instead", () => {
  const st = newAlign()
  const r = alignTick(st, 900, 1, 0, 0)
  assert.equal(r.seekSec, null); assert.equal(r.rate, 1.05)
})
test("standby ahead: slow, or seek back when buffered", () => {
  assert.equal(alignTick(newAlign(), -200, 1, 0, 0).rate, 0.95)
  assert.equal(alignTick(newAlign(), -800, 1, 1, 0).seekSec, -0.8)
})
test("deadband with hysteresis, unknown → rate 1", () => {
  const st = newAlign()
  assert.equal(alignTick(st, 40, 1, 0, 0).rate, 1)
  assert.equal(alignTick(st, 100, 1, 0, 0).rate, 1.05)
  assert.equal(alignTick(st, 45, 1, 0, 0).rate, 1.05)
  assert.equal(alignTick(st, 20, 1, 0, 0).rate, 1)
  assert.equal(alignTick(st, null, 1, 0, 0).rate, 1)
})
test("on-air latency: fresh only, never self", () => {
  reportPlayerLatency("A", 2000, true, 0)
  assert.equal(onAirLatency("B", 1000), 2000)
  assert.equal(onAirLatency("A", 1000), null)
  assert.equal(onAirLatency("B", 5000), null)
})
