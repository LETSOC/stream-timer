import assert from "node:assert/strict"
import test from "node:test"
import { newSettle, noteStandbyLatency, onAirJumpDue, ON_AIR_JUMP_OVER_MS, settleOnAir, settleTick, SETTLE_CREEP_HOLD_MS } from "./live-catchup"
import { ALIGN_MAX_PULL_MS, cappedDiff } from "./pair-align"
import { DEFAULT_EVENT } from "./event"
import { DEFAULT_STAGE, parseStage } from "./stage"
import { applyTransport, parseAction } from "./transport"

test("standby learns its own normal delay; it never creeps up while pulled", () => {
  const st = newSettle()
  noteStandbyLatency(st, 1200)
  noteStandbyLatency(st, 3500)
  noteStandbyLatency(st, 3600)
  assert.equal(st.floorMs, 1200)
  noteStandbyLatency(st, null)
  assert.equal(st.floorMs, 1200)
})

test("on air with an inherited delay → jump due; at its own delay → not", () => {
  const st = newSettle()
  noteStandbyLatency(st, 1200)
  assert.equal(onAirJumpDue(st, 3500), true)
  assert.equal(onAirJumpDue(st, 1200 + ON_AIR_JUMP_OVER_MS), false)
  assert.equal(onAirJumpDue(newSettle(), 9000), false) // no baseline yet: leave it to the 3 s live jump
})

test("after going on air the floor doesn't creep toward the inherited delay", () => {
  const st = newSettle()
  noteStandbyLatency(st, 1200)
  settleOnAir(st, 0)
  for (let t = 0; t < SETTLE_CREEP_HOLD_MS - 1000; t += 150) settleTick(st, 1600, 2, t)
  assert.equal(st.floorMs, 1200)
  // later it may creep again (a really slower path)
  for (let t = SETTLE_CREEP_HOLD_MS; t < SETTLE_CREEP_HOLD_MS + 15000; t += 150) settleTick(st, 1600, 2, t)
  assert.ok(st.floorMs! > 1200)
})

test("settleOnAir clears a half-done catch-up", () => {
  const st = newSettle()
  st.active = true; st.overSince = 5; st.retryAt = 99
  settleOnAir(st, 1000)
  assert.deepEqual([st.active, st.overSince, st.retryAt, st.creepHoldUntil], [false, null, 0, 1000 + SETTLE_CREEP_HOLD_MS])
})

test("pair-align never pulls the standby more than the cap behind its own baseline", () => {
  assert.equal(cappedDiff(-3000, 1200, 1200), -ALIGN_MAX_PULL_MS)
  assert.equal(cappedDiff(-3000, 2500, 1200), -(ALIGN_MAX_PULL_MS - 1300))
  assert.equal(cappedDiff(-3000, 3000, 1200), -0)
  assert.equal(cappedDiff(-400, 1200, 1200), -400)
  assert.equal(cappedDiff(800, 1200, 1200), 800) // standby behind: catch-up untouched
  assert.equal(cappedDiff(-3000, 1200, null), -3000)
  assert.equal(cappedDiff(null, 1200, 1200), null)
})

test("resyncPlayers: parsed, stamps playerResyncAt, survives parseStage", () => {
  assert.deepEqual(parseAction({ type: "resyncPlayers" }), { type: "resyncPlayers" })
  const r = applyTransport({ event: { ...DEFAULT_EVENT }, testUntil: null, pausedAt: null, stage: { ...DEFAULT_STAGE, program: true, deskLive: true } }, { type: "resyncPlayers" }, 4242)
  assert.ok(r.ok)
  if (r.ok) {
    assert.equal(r.next.stage.playerResyncAt, 4242)
    assert.equal(r.next.stage.program, true) // not a disarm
    assert.equal(parseStage(JSON.parse(JSON.stringify(r.next.stage))).playerResyncAt, 4242)
  }
  assert.equal(parseStage({}).playerResyncAt, null)
  assert.equal(parseStage({ playerResyncAt: "x" }).playerResyncAt, null)
})
