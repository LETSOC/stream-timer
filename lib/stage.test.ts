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

test("sameSpeakers: order and fields matter (speaker draft)", async () => {
  const { sameSpeakers } = await import("@/lib/stage")
  const a = { image: "a.png", name: "A", description: "" }
  const b = { image: "b.png", name: "B", description: "" }
  assert.equal(sameSpeakers([a, b], [a, b]), true)
  assert.equal(sameSpeakers([a, b], [b, a]), false)
  assert.equal(sameSpeakers([a], [{ ...a, name: "A2" }]), false)
  assert.equal(sameSpeakers([], []), true)
})

test("desk test clock: stale server clock and stale/undated local cache are ignored", async () => {
  const { serverClock, localClock, TEST_CLOCK_TTL_MS } = await import("@/lib/stage")
  const now = 10 * TEST_CLOCK_TTL_MS
  assert.deepEqual(serverClock({ testUntil: 5, pausedAt: null, testSetAt: now - 1000 }, now), { testUntil: 5, pausedAt: null, testSetAt: now - 1000 })
  assert.equal(serverClock({ testUntil: 5, testSetAt: now - TEST_CLOCK_TTL_MS - 1 }, now).testUntil, null)
  assert.equal(serverClock({ testUntil: 5, testStale: true }, now).testUntil, null)
  assert.equal(localClock(JSON.stringify({ testUntil: 5, savedAt: now - 1000 }), now).testUntil, 5)
  assert.equal(localClock(JSON.stringify({ testUntil: 5, savedAt: now - TEST_CLOCK_TTL_MS - 1 }), now).testUntil, null)
  assert.equal(localClock(JSON.stringify({ testUntil: 5 }), now).testUntil, null)
  assert.equal(localClock("{bad", now).testUntil, null)
})

test("social + countdown stroke options clamp and validate colours", () => {
  const d = parseStage({})
  assert.equal(d.socialDwellMs, 2500)
  assert.equal(d.socialStrokeColor, "#d4ff32")
  assert.equal(d.countdownStrokePx, 2)
  const s = parseStage({ socialDwellMs: 50, socialCooldownMs: 99999, socialStrokePx: 3.3, socialStrokeColor: "red;}", countdownStrokePx: 40, countdownStrokeColor: "#ABC", socialSpotlight: false })
  assert.equal(s.socialDwellMs, 500)
  assert.equal(s.socialCooldownMs, 15000)
  assert.equal(s.socialStrokePx, 3.5)
  assert.equal(s.socialStrokeColor, "#d4ff32")
  assert.equal(s.countdownStrokePx, 12)
  assert.equal(s.countdownStrokeColor, "#abc")
  assert.equal(s.socialSpotlight, false)
})
