import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

test("showreel video with pauseBed holds the capture bed (live file volume), release restores it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bedhold-"))
  process.env.STREAM_DATA_DIR = dir
  const { stageHoldsBed } = await import("./event-server")
  const { setBedHold, bedHeld, BED_HOLD_DB, liveAudioPlan } = await import("./audio-bed")
  const { DEFAULT_STAGE } = await import("./stage")
  const scenes = { ...DEFAULT_STAGE.scenes, showreel: { ...DEFAULT_STAGE.scenes.showreel, video: "/uploads/" + "a".repeat(32) + ".mp4", pauseBed: true } }
  assert.equal(stageHoldsBed({ ...DEFAULT_STAGE, scenes, overlay: "showreel" }), true)
  assert.equal(stageHoldsBed({ ...DEFAULT_STAGE, scenes, overlay: "none" }), false)
  assert.equal(stageHoldsBed({ ...DEFAULT_STAGE, scenes: { ...scenes, showreel: { ...scenes.showreel, pauseBed: false } }, overlay: "showreel" }), false)
  assert.equal(stageHoldsBed({ ...DEFAULT_STAGE, scenes: { ...scenes, showreel: { ...scenes.showreel, video: "" } }, overlay: "showreel" }), false)
  assert.equal(bedHeld(), false)
  setBedHold(true)
  assert.equal(bedHeld(), true)
  assert.equal(setBedHold(true), false)
  setBedHold(false)
  assert.equal(bedHeld(), false)
  assert.ok(BED_HOLD_DB <= -100)
  assert.ok(typeof liveAudioPlan === "function")
  fs.rmSync(dir, { recursive: true, force: true })
})
