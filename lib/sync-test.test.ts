import assert from "node:assert/strict"
import test from "node:test"
import { syncBeep, syncFlash, syncTestContext, syncTimecode } from "@/lib/sync-test"

test("timecode: seconds tick on the beep, FF = frames since it", () => {
  const t = Date.UTC(2026, 9, 17, 0, 49, 7) // 01:49:07 BST
  assert.equal(syncTimecode(t, 30), "01:49:07:00")
  assert.equal(syncTimecode(t + 99, 30), "01:49:07:02")
  assert.equal(syncTimecode(t + 999, 30), "01:49:07:29")
  assert.equal(syncTimecode(t + 500, 25, "UTC"), "00:49:07:12")
  assert.equal(syncBeep(t + 50) && syncFlash(t + 150) && !syncBeep(t + 150) && !syncFlash(t + 250), true)
})

test("overlay only in capture (or forced), never in operator previews", () => {
  assert.equal(syncTestContext("?capture=1", "Mozilla", false, false), "capture")
  assert.equal(syncTestContext("", "Mozilla HeadlessChrome/130", false, false), "capture")
  assert.equal(syncTestContext("?mute=1", "Mozilla HeadlessChrome", true, false), null)
  assert.equal(syncTestContext("?capture=1", "Mozilla", false, true), null)
  assert.equal(syncTestContext("", "Mozilla Chrome", false, false), null)
  assert.equal(syncTestContext("?synctest=1&mute=1", "Mozilla", false, true), "forced")
})
