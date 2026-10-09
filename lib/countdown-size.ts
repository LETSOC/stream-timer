export type SizeRange = { min: number; max: number }

/** "Countdown size": scales the four boxes and everything in them. */
export const CLOCK_SCALE_RANGE: SizeRange = { min: 0.7, max: 1.8 }
/** "Text size": scales the numbers and labels inside the boxes, relative to the countdown size. */
export const CLOCK_TEXT_RANGE: SizeRange = { min: 0.7, max: 2.2 }

/** Accepts a number or numeric string; anything else (NaN, "", "abc", null) returns the fallback. */
export function clampSize(value: unknown, range: SizeRange, fallback = 1): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(range.max, Math.max(range.min, n))
}

/** All lengths are in cqi (1% of the stage width) at countdown size 1 and text size 1. */
export const CLOCK_GEOMETRY = {
  digit: 3.1,
  label: 0.72,
  boxMinWidth: 8.6,
  boxMinHeight: 6.1,
  padX: 0.45,
  padY: 0.9,
  gap: 0.55,
  labelGap: 0.4,
}

// Arial bold digits are 0.556em wide; "SECONDS" with 0.14em letter spacing is about 5.93em.
const DIGIT_WIDTH_EM = 0.58
const LABEL_WIDTH_EM = 6.0
const BORDER_CQI = 0.15

/**
 * Widest the countdown row may be. The logo column starts at 60cqi and the row starts at 5.4cqi;
 * this leaves a small gap and also fits inside the 58% text column.
 */
export const CLOCK_MAX_ROW = 51.5

/** Width of one box in cqi at countdown size 1. Boxes only grow past the minimum when text needs room. */
export function clockBoxWidth(text: number, digits = 3): number {
  const g = CLOCK_GEOMETRY
  const content = Math.max(digits * DIGIT_WIDTH_EM * g.digit * text, LABEL_WIDTH_EM * g.label * text)
  return Math.max(g.boxMinWidth, content + 2 * g.padX + BORDER_CQI)
}

/** Width of the whole row in cqi at countdown size 1. */
export function clockRowWidth(text: number, digits = 3): number {
  return 4 * clockBoxWidth(text, digits) + 3 * CLOCK_GEOMETRY.gap
}

/**
 * The countdown size that will actually be drawn. Everything in the row scales with it, so the
 * row can be capped exactly: it stops growing before it would touch the logo or leave the stage.
 */
export function fitClockScale(scale: number, text: number, digits = 3): number {
  const safeScale = clampSize(scale, CLOCK_SCALE_RANGE)
  const safeText = clampSize(text, CLOCK_TEXT_RANGE)
  const max = Math.floor((CLOCK_MAX_ROW / clockRowWidth(safeText, digits)) * 100) / 100
  return Math.min(safeScale, max)
}
