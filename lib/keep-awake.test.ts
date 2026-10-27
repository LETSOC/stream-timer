import assert from "node:assert/strict"
import test from "node:test"
import { formatSleep, sleepGapMs } from "./keep-awake"

test("normal ticks and small jitter are not a sleep", () => {
  assert.equal(sleepGapMs(0, 5000), 0)
  assert.equal(sleepGapMs(0, 6200), 0)
  assert.equal(sleepGapMs(0, 24_000), 0) // 19s late: under the threshold
})

test("a long freeze is reported as the extra time", () => {
  assert.equal(sleepGapMs(0, 25_000), 20_000)
  assert.equal(sleepGapMs(1000, 1000 + 4_919_000 + 5000), 4_919_000)
})

test("a clock stepping backwards is not a sleep", () => {
  assert.equal(sleepGapMs(10_000, 4000), 0)
})

test("sleep length reads naturally", () => {
  assert.equal(formatSleep(45_000), "45s")
  assert.equal(formatSleep(4_919_000), "82 min")
})
