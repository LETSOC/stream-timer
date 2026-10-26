import { test } from "node:test"
import assert from "node:assert/strict"
import { previewLight, previewHlsCaps, previewFrameShown, handoverDone, keepLoaded, diagPrefix, previewGentle, previewMountSource, programDisplay, READY_STALL_TIMEOUT_MS } from "@/lib/program-display"

test("gentle HLS only for touch devices in a muted operator preview, never capture/OBS", () => {
  assert.equal(previewGentle({ mute: true, touch: true, capturePage: false }), true)
  assert.equal(previewGentle({ mute: true, touch: false, capturePage: false }), false) // desktop preview keeps LL
  assert.equal(previewGentle({ mute: false, touch: true, capturePage: false }), false) // real viewer / OBS URL
  assert.equal(previewGentle({ mute: true, touch: true, capturePage: true }), false) // browser capture
})

test("diag prefix: phone, desk, obs, capture", () => {
  assert.equal(diagPrefix({ touch: true, capturePage: false, obs: false }), "[phone] ")
  assert.equal(diagPrefix({ touch: false, capturePage: false, obs: false }), "[desk] ")
  assert.equal(diagPrefix({ touch: false, capturePage: false, obs: true }), "[obs] ")
  assert.equal(diagPrefix({ touch: true, capturePage: true, obs: false }), "[capture] ") // capture wins
  assert.equal(diagPrefix({ touch: false, capturePage: true, obs: true }), "[capture] ")
})

test("phone preview mounts only the on-air input; desktop/capture prewarm both", () => {
  assert.equal(previewMountSource({ gentle: true, live: true }), true)   // on air / hand-over target
  assert.equal(previewMountSource({ gentle: true, live: false }), false) // standby stays down
  assert.equal(previewMountSource({ gentle: false, live: false }), true) // desktop / OBS / capture prewarm
  assert.equal(previewMountSource({ gentle: false, live: true }), true)
})

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

test("re-arm hold: a disarm/arm cycle (auto re-arm or the desk buttons) freezes on the last frame, never 'Waiting for OBS'", async () => {
  const { previewDisplay, NOT_READY_MS } = await import("@/lib/program-display")
  const { nextRearmHold, rearmHoldLeft, REARM_HOLD_MS } = await import("@/lib/program-rearm")
  // 15:00:53 replay: OBS kicked (not ready), player torn down (no frame in the element), cover holds the last frame.
  const gone = { ...base, now: 20_000, ready: false, notReadySince: 20_000 - NOT_READY_MS - 500, lastFrameAt: null, held: true }
  assert.equal(programDisplay(gone), "standby") // before: the card
  assert.equal(programDisplay({ ...gone, rearmHold: true }), "video") // now: the held frame
  assert.equal(programDisplay({ ...gone, lastFrameAt: 14_000, held: false, rearmHold: true }), "video") // element still has its frame
  assert.equal(programDisplay({ ...gone, held: false, rearmHold: true }), "standby") // nothing to hold: normal rules
  // previews: "reconnecting" with the last frame instead of the card
  const p = { now: 20_000, ready: false, notReadySince: 10_000, lastFrameAt: 15_000 }
  assert.equal(previewDisplay(p), "standby")
  assert.equal(previewDisplay({ ...p, rearmHold: true }), "reconnecting")
  // the hold lasts REARM_HOLD_MS from the disarm, then the normal rules apply
  const h = nextRearmHold(1000)
  assert.equal(rearmHoldLeft(h, 1000), REARM_HOLD_MS)
  assert.equal(rearmHoldLeft(h, 1000 + REARM_HOLD_MS + 1), 0)
  assert.ok(REARM_HOLD_MS >= 10_000 && REARM_HOLD_MS <= 15_000)
})

test("capture start: with Program up, the (re)started Browser capture waits for the program picture (≤ 8s), never opens on the countdown", async () => {
  const { captureStartReady, CAPTURE_FIRST_FRAME_WAIT_MS } = await import("@/lib/program-display")
  const b = { capturePage: true, blocked: false, screen: "program", shownScreen: "countdown", waitedMs: 900 }
  assert.equal(captureStartReady(b), false) // 14:59:40: countdown under, program's first frame not up yet
  assert.equal(captureStartReady({ ...b, shownScreen: "program" }), true)
  assert.equal(captureStartReady({ ...b, waitedMs: CAPTURE_FIRST_FRAME_WAIT_MS }), true)
  assert.equal(captureStartReady({ ...b, screen: "countdown" }), true)
  assert.equal(captureStartReady({ ...b, capturePage: false }), true) // OBS Browser Source / plain tab: unchanged
  assert.equal(captureStartReady({ ...b, blocked: true }), true) // the script must still see "View key required"
  assert.ok(CAPTURE_FIRST_FRAME_WAIT_MS < 15_000) // capture-stream.mjs waits 15s for the marker
})

test("light preview: any ?mute=1 page except Browser capture", () => {
  assert.equal(previewLight({ mute: true, capturePage: false }), true)
  assert.equal(previewLight({ mute: false, capturePage: false }), false)
  assert.equal(previewLight({ mute: true, capturePage: true }), false)
})

test("light preview skips the standby input; the real output keeps both", () => {
  assert.equal(previewMountSource({ gentle: true, live: false }), false)
  assert.equal(previewMountSource({ gentle: false, live: false }), true)
  assert.equal(previewMountSource({ gentle: true, live: true }), true)
})

test("preview HLS caps only apply to a light preview", () => {
  assert.deepEqual(previewHlsCaps(false), {})
  assert.equal(previewHlsCaps(true).capLevelToPlayerSize, true)
  assert.ok(Number(previewHlsCaps(true).maxBufferLength) <= 4)
})

test("preview iframe mounts only on screen in a visible tab", () => {
  assert.equal(previewFrameShown({ intersecting: true, docVisible: true }), true)
  assert.equal(previewFrameShown({ intersecting: false, docVisible: true }), false)
  assert.equal(previewFrameShown({ intersecting: true, docVisible: false }), false)
})
