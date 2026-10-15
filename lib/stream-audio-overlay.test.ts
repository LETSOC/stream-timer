import assert from "node:assert/strict"
import test from "node:test"
import { interactiveViewer } from "../components/stream-audio-overlay.tsx"

const desk = { search: "", ua: "Mozilla/5.0 (Macintosh) Safari/605", webdriver: false, framed: false }
test("audio overlay: interactive browsers only; never OBS, capture, previews", () => {
  assert.equal(interactiveViewer(desk), true)
  assert.equal(interactiveViewer({ ...desk, ua: "Mozilla/5.0 Chrome/127 OBS/30.2.0" }), false)
  assert.equal(interactiveViewer({ ...desk, ua: "obsstudio/31" }), false)
  assert.equal(interactiveViewer({ ...desk, webdriver: true }), false) // Browser capture (Playwright)
  assert.equal(interactiveViewer({ ...desk, framed: true }), false) // deck/desk preview iframe
  assert.equal(interactiveViewer({ ...desk, search: "?k=abc" }), false) // the OBS view-key URL
  assert.equal(interactiveViewer({ ...desk, search: "?mute=1" }), false)
  assert.equal(interactiveViewer({ ...desk, search: "?controls=0" }), false)
  assert.equal(interactiveViewer({ ...desk, webdriver: true, search: "?k=abc&controls=1" }), true)
})

test("overlay never fights the player's mute (no toggling under a card)", async () => {
  const { viewerMutedState } = await import("@/components/stream-audio-overlay")
  assert.equal(viewerMutedState(true, false, true), null) // card up: player keeps it silent
  assert.equal(viewerMutedState(true, true, true), false) // program shown: viewer's unmute applies
  assert.equal(viewerMutedState(true, true, false), null)
  assert.equal(viewerMutedState(false, true, false), true) // viewer muted
  assert.equal(viewerMutedState(false, false, true), null)
})

test("unchecked raw program audio does not lock a viewer's unmute", async () => {
  const { programWantsSound, bedGainMuted } = await import("@/components/stream-audio-overlay")
  const off = { active: true, hardMuted: false, programAudio: false, viewerChose: false, viewerMuted: false }
  assert.equal(programWantsSound(off), false) // checkbox unchecked: start silent
  assert.equal(programWantsSound({ ...off, viewerChose: true, viewerMuted: false }), true) // Unmute sticks
  assert.equal(programWantsSound({ ...off, viewerChose: true, viewerMuted: true }), false)
  assert.equal(programWantsSound({ ...off, programAudio: true }), true) // checked: sound without a click
  assert.equal(programWantsSound({ active: true, hardMuted: true, programAudio: true, viewerChose: true, viewerMuted: false }), false) // ?mute=1 still wins
  assert.equal(programWantsSound({ active: false, hardMuted: false, programAudio: false, viewerChose: true, viewerMuted: false }), false) // countdown / card
  assert.equal(bedGainMuted({ urlMute: false, screenIsProgram: true, programAudio: false, viewerChose: false, viewerMuted: false }), false) // bed plays while program audio is off
  assert.equal(bedGainMuted({ urlMute: false, screenIsProgram: true, programAudio: true, viewerChose: false, viewerMuted: false }), true)
  assert.equal(bedGainMuted({ urlMute: false, screenIsProgram: true, programAudio: false, viewerChose: true, viewerMuted: true }), true)
})
