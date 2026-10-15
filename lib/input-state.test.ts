import assert from "node:assert/strict"
import { test } from "node:test"
import { inputState, nextBaseline, parseStreamInfo, readiness, type InputStats } from "@/lib/input-state"

const stats: InputStats = { fps: 30, fpsMin: 29.5, fpsNominal: 30, video: true, audio: { hz: 48000, channels: "stereo", codec: "aac" } }
const ok = { ready: true, kbps: 3000, dataAgeMs: 200 }

test("states: hiccups are SUSPECT, only a confirmed stall is FAILED", () => {
  assert.equal(inputState(ok, stats, 3000, 3000).state, "healthy")
  assert.equal(inputState({ ...ok, dataAgeMs: 1600 }, stats, 3000, 3000).state, "suspect")
  assert.equal(inputState({ ...ok, dataAgeMs: 3200 }, stats, 3000, 3000).state, "failed")
  assert.equal(inputState({ ready: false, kbps: null, dataAgeMs: null }, null, null, 3000).state, "failed")
  assert.equal(inputState({ ...ok, kbps: 500 }, stats, 3000, 3000).state, "suspect")
  assert.equal(inputState(ok, { ...stats, fps: 18 }, 3000, 3000).state, "suspect")
})

test("READY needs video+audio, stable fps, fresh data, 48 kHz", () => {
  assert.deepEqual(readiness(ok, stats), { ok: true, issues: [] })
  assert.ok(readiness(ok, { ...stats, audio: { ...stats.audio!, hz: 44100 } }).issues.includes("audio 44.1 kHz (need 48)"))
  assert.ok(readiness(ok, { ...stats, audio: null }).issues.includes("no audio"))
  assert.ok(readiness(ok, { ...stats, fpsMin: 20 }).issues.includes("fps not stable"))
  assert.ok(readiness({ ...ok, dataAgeMs: 1500 }, stats).issues.includes("data not fresh"))
  assert.equal(readiness({ ready: false, kbps: null, dataAgeMs: null }, null).issues[0], "no signal")
})

test("baseline only learns from healthy seconds; ffmpeg stream lines parse", () => {
  assert.equal(nextBaseline(null, 3000, "healthy"), 3000)
  assert.equal(nextBaseline(3000, 100, "suspect"), 3000)
  assert.equal(parseStreamInfo("  Stream #0:1: Video: h264 (High), yuv420p(progressive), 1280x720, 30.30 fps, 30 tbr, 1k tbn").fpsNominal, 30.3)
  assert.deepEqual(parseStreamInfo("  Stream #0:0: Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s").audio, { codec: "aac", hz: 48000, channels: "stereo" })
})
