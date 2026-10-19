import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_PREF, elementMuted, nextPref, parsePref } from "@/lib/preview-audio"

test("mute is user-owned: only toggle/volume/hidden change it; source switch, remount and swap never do", () => {
  const on = nextPref(DEFAULT_PREF, { type: "toggle" })
  assert.equal(on.muted, false)
  for (const type of ["source-switch", "remount", "swap"] as const) assert.equal(nextPref(on, { type }), on)
  assert.equal(nextPref(on, { type: "toggle" }).muted, true)
  assert.equal(nextPref(on, { type: "volume", volume: 2 }).volume, 1)
  assert.equal(nextPref(on, { type: "volume", volume: 0.3 }).muted, false)
})

test("background mutes and it stays muted on return (no auto-unmute)", () => {
  const on = nextPref(DEFAULT_PREF, { type: "toggle" })
  const hidden = nextPref(on, { type: "hidden" })
  assert.equal(hidden.muted, true)
  assert.equal(nextPref(hidden, { type: "source-switch" }).muted, true)
})

test("only the audio element, after a gesture, unmuted and visible is audible", () => {
  const pref = { muted: false, volume: 0.8 }
  assert.equal(elementMuted({ pref, audioOn: true, audioElement: true, pageVisible: true }), false)
  assert.equal(elementMuted({ pref, audioOn: true, audioElement: false, pageVisible: true }), true) // hidden WebRTC element
  assert.equal(elementMuted({ pref, audioOn: true, audioElement: true, pageVisible: false }), true) // background
  assert.equal(elementMuted({ pref, audioOn: false, audioElement: true, pageVisible: true }), true) // no gesture yet
  assert.equal(elementMuted({ pref: { muted: true, volume: 1 }, audioOn: true, audioElement: true, pageVisible: true }), true)
  assert.deepEqual(parsePref({ muted: false, volume: 5 }), { muted: false, volume: 1 })
  assert.deepEqual(parsePref("junk"), DEFAULT_PREF)
})

test("mute-only on deck, iPhone, iPad (desktop UA) and touch; desktop desk keeps volume + meter", async () => {
  const { muteOnlyAudio } = await import("@/lib/preview-audio")
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15"
  assert.equal(muteOnlyAudio({ ua: mac, maxTouchPoints: 0, coarsePointer: false, deck: false }), false)
  assert.equal(muteOnlyAudio({ ua: mac, maxTouchPoints: 5, coarsePointer: false, deck: false }), true)
  assert.equal(muteOnlyAudio({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5, coarsePointer: true, deck: false }), true)
  assert.equal(muteOnlyAudio({ ua: mac, maxTouchPoints: 0, coarsePointer: false, deck: true }), true)
  assert.equal(muteOnlyAudio({ ua: "Mozilla/5.0 (Linux; Android 14)", maxTouchPoints: 5, coarsePointer: true, deck: false }), true)
})
