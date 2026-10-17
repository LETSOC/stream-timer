import assert from "node:assert/strict"
import { test } from "node:test"
import { clampHold, cornerOffsets, sanitizeStraps, strapVisible, STRAP_IN_MS, STRAP_LOOP_GAP_MS, STRAP_OUT_MS } from "@/lib/visuals"

test("strap IN shows for in + hold, then goes out by itself", () => {
  assert.equal(strapVisible("in", 1000, 5, 1000), true)
  assert.equal(strapVisible("in", 1000, 5, 1000 + STRAP_IN_MS + 4999), true)
  assert.equal(strapVisible("in", 1000, 5, 1000 + STRAP_IN_MS + 5000), false)
  assert.equal(strapVisible("out", 1000, 5, 1500), false)
  assert.equal(strapVisible("in", null, 5, 1500), false)
})
test("strap LOOP repeats in/hold/out/gap", () => {
  const cycle = STRAP_IN_MS + 3000 + STRAP_OUT_MS + STRAP_LOOP_GAP_MS
  assert.equal(strapVisible("loop", 0, 3, STRAP_IN_MS + 3100), false)
  assert.equal(strapVisible("loop", 0, 3, cycle + 10), true)
})
test("strap hold clamps to 3-10s", () => {
  assert.equal(clampHold(1), 3)
  assert.equal(clampHold(20), 10)
  assert.equal(clampHold("x", 6), 6)
})
test("strap presets are sanitised", () => {
  const out = sanitizeStraps([{ id: "a", name: "A", platform: "bogus", style: "pill" }, { id: "a", name: "B" }, { name: "" }, "junk"])
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { id: "a", name: "A", title: "", handle: "", platform: "none", style: "pill" })
  assert.notEqual(out[1].id, "a")
})
test("overlay corners: 96/96 bottom-left default; top-right clears the QR", () => {
  assert.deepEqual(cornerOffsets("bottom-left"), { left: 96, bottom: 96 })
  assert.ok((cornerOffsets("top-right").top ?? 0) >= 242)
})

import { applyTransport, parseAction } from "@/lib/transport"
import { DEFAULT_EVENT } from "@/lib/event"
import { DEFAULT_STAGE, parseStage } from "@/lib/stage"

test("strap/socials actions parse and apply live", () => {
  assert.equal(parseAction({ type: "strap" }), null)
  assert.deepEqual(parseAction({ type: "strap", mode: "in", id: "host", holdSec: 99 }), { type: "strap", mode: "in", id: "host", holdSec: 10 })
  assert.deepEqual(parseAction({ type: "socials", show: true, corner: "top-right" }), { type: "socials", show: true, corner: "top-right" })
  const state = { event: { ...DEFAULT_EVENT }, testUntil: null, pausedAt: null, stage: parseStage({}) }
  const r = applyTransport(state, { type: "strap", mode: "in", id: "host" }, 5000)
  assert.ok(r.ok && r.next.stage.strapMode === "in" && r.next.stage.strapAt === 5000 && r.next.stage.strapId === "host")
  const bad = applyTransport(state, { type: "strap", mode: "in", id: "nope" }, 5000)
  assert.equal(bad.ok, false)
  const out = applyTransport(state, { type: "strap", mode: "out" }, 5000)
  assert.ok(out.ok && out.next.stage.strapMode === "out")
  const s = applyTransport(state, { type: "socials", show: true, corner: "top-left" }, 1)
  assert.ok(s.ok && s.next.stage.socialsOverlay && s.next.stage.socialsCorner === "top-left")
  assert.equal(DEFAULT_STAGE.strapCorner, "bottom-left")
})
