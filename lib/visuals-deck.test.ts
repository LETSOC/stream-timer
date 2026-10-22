import assert from "node:assert/strict"
import { test } from "node:test"
import { deckLights, parseDuration, stepStrap, talkReadout } from "@/lib/visuals-deck"
import { DEFAULT_STAGE } from "@/lib/stage"
import { parseAction, visualPatch } from "@/lib/transport"

const T0 = 1_800_000_000_000

test("Prev/Next speaker wraps; no pick starts at first/last; empty list = null", () => {
  assert.equal(stepStrap(["a", "b", "c"], "a", 1), "b")
  assert.equal(stepStrap(["a", "b", "c"], "c", 1), "a")
  assert.equal(stepStrap(["a", "b", "c"], "a", -1), "c")
  assert.equal(stepStrap(["a", "b"], "", 1), "a")
  assert.equal(stepStrap(["a", "b"], "zz", -1), "b")
  assert.equal(stepStrap([], "", 1), null)
})

test("custom duration: minutes, mm:ss, h:mm:ss; junk, 0 and over 4h rejected", () => {
  assert.equal(parseDuration("25"), 1500)
  assert.equal(parseDuration(" 25:30 "), 1530)
  assert.equal(parseDuration("1:05:00"), 3900)
  for (const bad of ["", "0", "abc", "1:2:3:4", "-5", "300", "4:00:01"]) assert.equal(parseDuration(bad), null, bad)
})

test("status lights and talk readout", () => {
  const v = { straps: [{ id: "a" }], strapId: "a", strapMode: "in" as const, strapAt: T0, strapHoldSec: 5, socialsOverlay: false, talkVisible: true, tickerVisible: true, tickerCount: 0, qaVisible: true, sponsorVisible: false, streamVisuals: false, talkEndsAt: T0 + 60_000, talkPausedMs: null }
  assert.deepEqual(deckLights(v, T0 + 1000), { strap: true, talk: true, ticker: false, qa: true, sponsor: false, socials: false, layer: false })
  assert.equal(deckLights(v, T0 + 60_000).strap, false, "IN ends after hold")
  assert.deepEqual(talkReadout(v, T0), { ms: 60_000, state: "running" })
  assert.deepEqual(talkReadout(v, T0 + 61_000), { ms: 0, state: "over" })
  assert.deepEqual(talkReadout({ ...v, talkPausedMs: 5000 }, T0), { ms: 5000, state: "paused" })
  assert.deepEqual(talkReadout({ ...v, talkEndsAt: null }, T0), { ms: null, state: "stopped" })
})

test("Clear all: everything off the picture, timer and texts kept", () => {
  const a = parseAction({ type: "visual", target: "clear" })
  assert.ok(a && a.type === "visual")
  const p = visualPatch({ ...DEFAULT_STAGE, talkEndsAt: T0 }, a as never, T0)
  assert.deepEqual(p, { strapMode: "out", talkVisible: false, tickerVisible: false, qaVisible: false, sponsorVisible: false, socialsOverlay: false })
})
