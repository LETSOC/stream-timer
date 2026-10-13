/** Rules for a numeric desk field. Values are validated as typed text, clamped only on commit (blur / Enter). */
export type NumberRule = { min: number; max: number; integer?: boolean }

export type DraftCheck =
  | { kind: "empty" }
  | { kind: "partial" } // "-", "1.", "": still typing
  | { kind: "invalid"; error: string }
  | { kind: "number"; value: number; inRange: boolean }

const PARTIAL = /^-?\.?$|^-?\d+\.$/

export function checkNumberDraft(raw: string, rule: NumberRule): DraftCheck {
  const text = raw.trim()
  if (text === "") return { kind: "empty" }
  if (PARTIAL.test(text)) return { kind: "partial" }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(text)) return { kind: "invalid", error: "Numbers only." }
  const value = Number(text)
  if (!Number.isFinite(value)) return { kind: "invalid", error: "Numbers only." }
  if (rule.integer && !Number.isInteger(value)) return { kind: "invalid", error: "Whole numbers only." }
  return { kind: "number", value, inRange: value >= rule.min && value <= rule.max }
}

/**
 * On blur / Enter: clamp numbers into range; empty, partial or invalid text is an error and
 * nothing is committed (the field keeps the text so the operator can fix it).
 */
export function commitNumberDraft(raw: string, rule: NumberRule): { ok: true; value: number; clamped: boolean } | { ok: false; error: string } {
  const check = checkNumberDraft(raw, rule)
  if (check.kind === "number") {
    const value = Math.min(rule.max, Math.max(rule.min, check.value))
    return { ok: true, value, clamped: value !== check.value }
  }
  if (check.kind === "invalid") return { ok: false, error: check.error }
  return { ok: false, error: `Enter a number from ${rule.min} to ${rule.max}.` }
}
