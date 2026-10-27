import assert from "node:assert/strict"
import test from "node:test"
// @ts-expect-error plain .mjs script module
import { plannedRefreshDue, refreshOnProgramFromEnv, relaunchBackoffMs } from "../scripts/chrome-life.mjs"

const H = 3_600_000
const base = { now: 10 * H, launchedAt: 0, hours: 3, screen: "countdown", lastSwitchAt: 0, busy: false, onProgram: false }

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

test("planned refresh on the program (CAPTURE_CHROME_REFRESH_ON_PROGRAM=1): due after N hours, still 30s after a switch", () => {
  const on = { ...base, screen: "program", onProgram: true }
  assert.equal(plannedRefreshDue(on), true)
  assert.equal(plannedRefreshDue({ ...on, now: 2.9 * H }), false)
  assert.equal(plannedRefreshDue({ ...on, lastSwitchAt: on.now - 10_000 }), false) // just switched Main/Backup
  assert.equal(plannedRefreshDue({ ...on, lastSwitchAt: on.now - 30_000 }), true)
  assert.equal(plannedRefreshDue({ ...on, hours: 0 }), false)
  assert.equal(plannedRefreshDue({ ...on, busy: true }), false)
  assert.equal(plannedRefreshDue({ ...on, screen: "" }), false)
  assert.equal(plannedRefreshDue({ ...on, screen: "countdown" }), true)
})

test("CAPTURE_CHROME_REFRESH_ON_PROGRAM parsing: opt-in only", () => {
  for (const v of ["1", "true", "YES", " on "]) assert.equal(refreshOnProgramFromEnv(v), true)
  for (const v of [undefined, "", "0", "false", "no", "off", "2"]) assert.equal(refreshOnProgramFromEnv(v), false)
})
