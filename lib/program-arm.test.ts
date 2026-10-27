import assert from "node:assert/strict"
import test from "node:test"
import { disarmPlan, feedDisarmedInView, nextArmState, parseDisarmed } from "./program-arm"

const ARMED = { programArmed: true, disarmed: { main: false, backup: false } }
const OFF = { programArmed: false, disarmed: { main: false, backup: false } }

test("disarm one feed keeps the other armed; the last one off = fully disarmed", () => {
  const a = nextArmState(ARMED, "disarm", "backup")
  assert.deepEqual(a, { programArmed: true, disarmed: { main: false, backup: true } })
  assert.deepEqual(nextArmState(a, "disarm", "main"), OFF)
  assert.deepEqual(nextArmState(ARMED, "disarm", "both"), OFF)
})

test("arm one feed from fully disarmed arms only that feed; arm both clears", () => {
  assert.deepEqual(nextArmState(OFF, "arm", "main"), { programArmed: true, disarmed: { main: false, backup: true } })
  assert.deepEqual(nextArmState({ programArmed: true, disarmed: { main: false, backup: true } }, "arm", "backup"), ARMED)
  assert.deepEqual(nextArmState(OFF, "arm", "both"), ARMED)
})

test("disarm plan: standby no effect; on-air hands over if the other is healthy, else warns", () => {
  assert.deepEqual(disarmPlan("backup", "main", false), { handoverTo: null, affectsAir: false, warning: null })
  assert.deepEqual(disarmPlan("main", "main", true), { handoverTo: "backup", affectsAir: false, warning: null })
  assert.equal(disarmPlan("main", "main", false).warning, "Backup not healthy — output will hold/standby card")
  assert.equal(disarmPlan("backup", "backup", false).warning, "Main not healthy — output will hold/standby card")
  assert.equal(disarmPlan("both", "main", true).affectsAir, true)
})

test("parseDisarmed defaults to none", () => {
  assert.deepEqual(parseDisarmed(undefined), { main: false, backup: false })
  assert.deepEqual(parseDisarmed({ backup: true }), { main: false, backup: true })
})

test("feedDisarmedInView: null view (relay not armed) = both disarmed; per-feed flags otherwise", () => {
  assert.equal(feedDisarmedInView(null, "main"), true)
  assert.equal(feedDisarmedInView(undefined, "backup"), true)
  assert.equal(feedDisarmedInView({ armed: { main: true, backup: false } }, "main"), false)
  assert.equal(feedDisarmedInView({ armed: { main: true, backup: false } }, "backup"), true)
  assert.equal(feedDisarmedInView({}, "main"), false)
})

test("disarming the last armed feed turns the relay off; arming one feed from there arms just that one", () => {
  const backupOnly = { programArmed: true, disarmed: { main: true, backup: false } }
  const off = nextArmState(backupOnly, "disarm", "backup")
  assert.equal(off.programArmed, false)
  assert.deepEqual(nextArmState(off, "arm", "main"), { programArmed: true, disarmed: { main: false, backup: true } })
})
