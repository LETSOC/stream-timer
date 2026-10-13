import assert from "node:assert/strict"
import { test } from "node:test"
import { checkNumberDraft, commitNumberDraft } from "@/lib/number-draft"

const secs = { min: 2, max: 30 }
const scale = { min: 40, max: 200, integer: true }
const offset = { min: -600, max: 400, integer: true }

test("typing never snaps: empty, partial and below-min prefixes stay as text", () => {
  assert.equal(checkNumberDraft("", secs).kind, "empty")
  assert.equal(checkNumberDraft("-", offset).kind, "partial")
  assert.equal(checkNumberDraft("1.", secs).kind, "partial")
  // "4" on the way to "40" is a number but out of range: not pushed live, not clamped.
  assert.deepEqual(checkNumberDraft("4", scale), { kind: "number", value: 4, inRange: false })
  assert.deepEqual(checkNumberDraft("40", scale), { kind: "number", value: 40, inRange: true })
  assert.equal(checkNumberDraft("abc", secs).kind, "invalid")
  assert.equal(checkNumberDraft("1.5", scale).kind, "invalid")
})

test("commit clamps numbers and rejects empty/invalid without inventing a value", () => {
  assert.deepEqual(commitNumberDraft("4", scale), { ok: true, value: 40, clamped: true })
  assert.deepEqual(commitNumberDraft("-900", offset), { ok: true, value: -600, clamped: true })
  assert.deepEqual(commitNumberDraft("-86", offset), { ok: true, value: -86, clamped: false })
  assert.deepEqual(commitNumberDraft("7.5", secs), { ok: true, value: 7.5, clamped: false })
  assert.equal(commitNumberDraft("", secs).ok, false)
  assert.equal(commitNumberDraft("-", offset).ok, false)
  assert.equal(commitNumberDraft("x", secs).ok, false)
})
