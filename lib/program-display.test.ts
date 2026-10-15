import { test } from "node:test"
import assert from "node:assert/strict"
import { handoverDone, keepLoaded, programDisplay } from "@/lib/program-display"

const base = { now: 10_000, activeSince: 10_000, readyAt: 1000, ready: true, notReadySince: null, lastFrameAt: null }

test("program layer stays under the previous screen until the first frame", () => {
  assert.equal(programDisplay({ ...base, activeSince: null }), "under")
  assert.equal(programDisplay(base), "under")
  assert.equal(programDisplay({ ...base, now: 14_000 }), "under")
  assert.equal(programDisplay({ ...base, now: 10_400, lastFrameAt: 10_350 }), "video")
  assert.equal(programDisplay({ ...base, now: 15_500 }), "standby")
})

test("stalls hold the last frame, then standby", () => {
  assert.equal(programDisplay({ ...base, now: 20_000, lastFrameAt: 17_000 }), "video")
  assert.equal(programDisplay({ ...base, now: 20_000, lastFrameAt: 15_000 }), "standby")
})

test("not ready: standby only after the debounce", () => {
  const off = { ...base, ready: false, notReadySince: 9000 }
  assert.equal(programDisplay({ ...off, now: 11_000 }), "under")
  assert.equal(programDisplay({ ...off, now: 13_500 }), "standby")
  assert.equal(programDisplay({ ...base, ready: false, notReadySince: null, now: 13_100 }), "standby")
  assert.equal(keepLoaded(false, 9000, 11_000), true)
  assert.equal(keepLoaded(false, 9000, 12_500), false)
  assert.equal(keepLoaded(true, null, 0), true)
})

test("Main/Backup hand-over: hold the on-air input until the incoming one has played the switch buffer", () => {
  const base = { screenIsProgram: true, pendingSince: 0, airDisplay: "video" as const, bufferMs: 1000 }
  assert.equal(handoverDone({ ...base, now: 3000, incomingVideoSince: null }), false) // never standby mid-switch
  assert.equal(handoverDone({ ...base, now: 3000, incomingVideoSince: 2500 }), false)
  assert.equal(handoverDone({ ...base, now: 3500, incomingVideoSince: 2500 }), true)
  assert.equal(handoverDone({ ...base, bufferMs: 0, now: 2500, incomingVideoSince: 2500 }), true)
  // the one on air is already gone: take the incoming one at its first frame, or after 4s
  assert.equal(handoverDone({ ...base, airDisplay: "standby", now: 1000, incomingVideoSince: 900 }), true)
  assert.equal(handoverDone({ ...base, airDisplay: "standby", now: 3000, incomingVideoSince: null }), false)
  assert.equal(handoverDone({ ...base, airDisplay: "standby", now: 4100, incomingVideoSince: null }), true)
  assert.equal(handoverDone({ ...base, now: 31_000, incomingVideoSince: null }), true) // cap
  assert.equal(handoverDone({ ...base, screenIsProgram: false, now: 10, incomingVideoSince: null }), true)
})
