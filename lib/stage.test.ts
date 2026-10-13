import assert from "node:assert/strict"
import { test } from "node:test"
import { BODY_MAX, clampChecker, DEFAULT_STAGE, effectiveEndTime, parseEndAt, parseStage, TEST_CLOCK_TTL_MS, testClockStale, TEXT_MAX } from "@/lib/stage"

test("partial stage keeps the base values (B)", () => {
  const base = { ...DEFAULT_STAGE, checker: 9, endTitle: "Custom", blockGap: 3 }
  const next = parseStage({ showMeta: false }, base)
  assert.equal(next.showMeta, false)
  assert.equal(next.checker, 9)
  assert.equal(next.endTitle, "Custom")
  assert.equal(next.blockGap, 3)
})

test("blockGap 0 survives; null/'' fall back (I)", () => {
  assert.equal(parseStage({ blockGap: 0 }).blockGap, 0)
  assert.equal(parseStage({ blockGap: null }).blockGap, DEFAULT_STAGE.blockGap)
  assert.equal(parseStage({ blockGap: "" }).blockGap, DEFAULT_STAGE.blockGap)
  assert.equal(parseStage({ galleryOffset: 0 }).galleryOffset, 0)
})

test("endAt: empty by default, HH:MM only, empty means event end (C)", () => {
  assert.equal(DEFAULT_STAGE.endAt, "")
  assert.equal(parseStage({ endAt: "" }).endAt, "")
  assert.equal(parseStage({ endAt: "17:05" }).endAt, "17:05")
  assert.equal(parseStage({ endAt: "25:99" }, { ...DEFAULT_STAGE, endAt: "16:00" }).endAt, "16:00")
  assert.equal(parseEndAt("nope"), "")
  assert.equal(effectiveEndTime({ endAt: "" }, "18:00"), "18:00")
  assert.equal(effectiveEndTime({ endAt: "17:00" }, "18:00"), "17:00")
})

test("grid clamp (J)", () => {
  assert.equal(clampChecker("abc", 6), 6)
  assert.equal(clampChecker("99"), 12)
  assert.equal(clampChecker("1"), 4)
  assert.equal(clampChecker("7.6"), 8)
})

test("text caps (R)", () => {
  const long = "x".repeat(5000)
  const s = parseStage({ endTitle: long, endBody: long })
  assert.equal(s.endTitle.length, TEXT_MAX)
  assert.equal(s.endBody.length, BODY_MAX)
})

test("test clock goes stale after 2 hours (A)", () => {
  const now = 1_800_000_000_000
  assert.equal(testClockStale(null, now), false)
  assert.equal(testClockStale(now - TEST_CLOCK_TTL_MS + 1000, now), false)
  assert.equal(testClockStale(now - TEST_CLOCK_TTL_MS - 1000, now), true)
})
