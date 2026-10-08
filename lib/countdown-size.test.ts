import assert from "node:assert/strict"
import test from "node:test"
import {
  CLOCK_MAX_ROW,
  CLOCK_SCALE_RANGE,
  CLOCK_TEXT_RANGE,
  clampSize,
  clockRowWidth,
  fitClockScale,
} from "./countdown-size.ts"

test("clampSize keeps good values, clamps to the range, and rejects junk", () => {
  assert.equal(clampSize(1.25, CLOCK_SCALE_RANGE), 1.25)
  assert.equal(clampSize("1.25", CLOCK_SCALE_RANGE), 1.25)
  assert.equal(clampSize(99, CLOCK_SCALE_RANGE), CLOCK_SCALE_RANGE.max)
  assert.equal(clampSize(0, CLOCK_TEXT_RANGE), CLOCK_TEXT_RANGE.min)
  assert.equal(clampSize(-3, CLOCK_TEXT_RANGE), CLOCK_TEXT_RANGE.min)
  for (const bad of ["abc", "", "  ", null, undefined, Number.NaN, Infinity, {}]) {
    assert.equal(clampSize(bad, CLOCK_SCALE_RANGE), 1)
  }
  assert.equal(clampSize("abc", CLOCK_SCALE_RANGE, 1.3), 1.3)
})

test("the default sizes are never changed by the fit cap", () => {
  assert.equal(fitClockScale(1, 1), 1)
  assert.equal(fitClockScale(0.7, 0.7), 0.7)
})

test("the cap stops the row before the logo, at every slider combination", () => {
  for (let scale = CLOCK_SCALE_RANGE.min; scale <= CLOCK_SCALE_RANGE.max + 1e-9; scale += 0.05) {
    for (let text = CLOCK_TEXT_RANGE.min; text <= CLOCK_TEXT_RANGE.max + 1e-9; text += 0.05) {
      const shown = fitClockScale(scale, text)
      assert.ok(shown <= scale + 1e-9, `never grows past what was asked (${scale}, ${text})`)
      assert.ok(shown * clockRowWidth(text) <= CLOCK_MAX_ROW + 1e-9, `row fits (${scale}, ${text})`)
    }
  }
})

test("the cap only bites when the row would not fit", () => {
  assert.equal(fitClockScale(1.2, 1), 1.2)
  assert.ok(fitClockScale(1.8, 1) < 1.8)
  assert.ok(fitClockScale(1, 2.2) < 1.2)
})

test("out-of-range input is clamped before it is used", () => {
  assert.equal(fitClockScale(Number.NaN, 1), 1)
  assert.ok(fitClockScale(50, 1) <= CLOCK_SCALE_RANGE.max)
})
