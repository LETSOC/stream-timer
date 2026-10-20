import assert from "node:assert/strict"
import test from "node:test"
// @ts-expect-error plain .mjs script module
import { plannedRefreshDue, relaunchBackoffMs } from "../scripts/chrome-life.mjs"

const H = 3_600_000
const base = { now: 10 * H, launchedAt: 0, hours: 3, screen: "countdown", lastSwitchAt: 0, busy: false }

test("relaunch backoff grows to 30s and never stops", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9, 50].map(relaunchBackoffMs), [0, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})

test("planned refresh: due on countdown/cards after N hours", () => {
  assert.equal(plannedRefreshDue(base), true)
  for (const screen of ["hold", "break", "welcome", "end", "countdown"]) assert.equal(plannedRefreshDue({ ...base, screen }), true)
  assert.equal(plannedRefreshDue({ ...base, now: 2.9 * H }), false)
})

test("planned refresh: never during the program, off at 0h, not within 30s of a switch, not while recovering", () => {
  assert.equal(plannedRefreshDue({ ...base, screen: "program" }), false)
  assert.equal(plannedRefreshDue({ ...base, screen: "" }), false) // page didn't answer: unknown
  assert.equal(plannedRefreshDue({ ...base, hours: 0 }), false)
  assert.equal(plannedRefreshDue({ ...base, lastSwitchAt: base.now - 10_000 }), false)
  assert.equal(plannedRefreshDue({ ...base, lastSwitchAt: base.now - 30_000 }), true)
  assert.equal(plannedRefreshDue({ ...base, busy: true }), false)
})
