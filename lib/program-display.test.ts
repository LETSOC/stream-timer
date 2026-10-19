import { test } from "node:test"
import assert from "node:assert/strict"
import { handoverDone, keepLoaded, programDisplay, READY_STALL_TIMEOUT_MS } from "@/lib/program-display"

const base = { now: 10_000, activeSince: 10_000, readyAt: 1000, ready: true, notReadySince: null, lastFrameAt: null }

test("program layer stays under the previous screen until the first frame", () => {
  assert.equal(programDisplay({ ...base, activeSince: null }), "under")
  assert.equal(programDisplay(base), "under")
  assert.equal(programDisplay({ ...base, now: 14_000 }), "under")
  assert.equal(programDisplay({ ...base, now: 10_400, lastFrameAt: 10_350 }), "video")
  // publisher there (ready) but no first frame yet: never "Waiting for OBS" before the ready timeout
  assert.equal(programDisplay({ ...base, now: 15_500 }), "under")
  assert.equal(programDisplay({ ...base, now: 10_000 + READY_STALL_TIMEOUT_MS + 1 }), "standby")
  // not ready (no publisher) and no first frame: standby after the grace as before
  assert.equal(programDisplay({ ...base, ready: false, notReadySince: 9000, now: 15_500 }), "standby")
})

test("OBS reconnected after a disarm/arm: relay says READY, rebuilt player has no frame yet → hold the last frame, no 'Waiting for OBS'", () => {
  // the user's log: publisher back 14:32:27, player rebuilt 14:32:28, first frame 14:32:33; card shown 14:32:30
  const t = { activeSince: 0, readyAt: 27_000, ready: true, notReadySince: null, lastFrameAt: null, held: true }
  for (const now of [27_100, 30_000, 33_000, 27_000 + READY_STALL_TIMEOUT_MS]) assert.equal(programDisplay({ ...t, now }), "video", String(now))
  assert.equal(programDisplay({ ...t, held: false, now: 30_000 }), "under") // nothing to hold: previous screen, still no card
  assert.equal(programDisplay({ ...t, now: 27_000 + READY_STALL_TIMEOUT_MS + 1 }), "standby") // never plays: card after the timeout
  // publisher gone: the card as before
  assert.equal(programDisplay({ ...t, ready: false, notReadySince: 30_000, now: 33_100 }), "standby")
})

test("stalls hold the last frame, then standby", () => {
  assert.equal(programDisplay({ ...base, now: 20_000, lastFrameAt: 17_000 }), "video")
  assert.equal(programDisplay({ ...base, now: 20_000, lastFrameAt: 15_000 }), "video") // still publishing: hold
  assert.equal(programDisplay({ ...base, now: 20_000, lastFrameAt: 15_000, ready: false, notReadySince: 16_000 }), "standby")
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

test("LL-HLS stall while MediaMTX still has the publisher: keep the last frame, standby only when gone or after the timeout", async () => {
  const { programDisplay, READY_STALL_TIMEOUT_MS, NOT_READY_MS } = await import("@/lib/program-display")
  const base = { activeSince: 0, readyAt: 0, lastFrameAt: 100_000 }
  assert.equal(programDisplay({ ...base, now: 108_000, ready: true, notReadySince: null }), "video")
  assert.equal(programDisplay({ ...base, now: 100_000 + READY_STALL_TIMEOUT_MS + 1, ready: true, notReadySince: null }), "standby")
  assert.equal(programDisplay({ ...base, now: 108_000, ready: false, notReadySince: 108_000 - NOT_READY_MS - 1 }), "standby")
})

test("standby input is held (paused, warm) only in a plain tab: never on air, never the hand-over target, never in Browser capture", async () => {
  const { holdStandby } = await import("@/lib/program-display")
  assert.equal(holdStandby({ onAir: false, incoming: false, captureTap: false }), true)
  assert.equal(holdStandby({ onAir: true, incoming: false, captureTap: false }), false)
  assert.equal(holdStandby({ onAir: false, incoming: true, captureTap: false }), false)
  assert.equal(holdStandby({ onAir: false, incoming: false, captureTap: true }), false)
})

test("hand-over: a dead/frozen on-air input is cut at the new input's first frame; a healthy one keeps the overlap", () => {
  const base = { screenIsProgram: true, pendingSince: 0, airDisplay: "video" as const, bufferMs: 5000 }
  assert.equal(handoverDone({ ...base, now: 1200, incomingVideoSince: 1000, airAlive: true }), false)
  assert.equal(handoverDone({ ...base, now: 1200, incomingVideoSince: 1000, airAlive: false }), true)
  assert.equal(handoverDone({ ...base, now: 1200, incomingVideoSince: null, airAlive: false }), false) // nothing to cut to yet: hold
  assert.equal(handoverDone({ ...base, now: 6100, incomingVideoSince: 1000, airAlive: true }), true)
})
