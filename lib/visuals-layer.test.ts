import assert from "node:assert/strict"
import { test } from "node:test"
import { formatClock, parseTalkTimer, sanitizeTickerItems, STRAP_STYLES, DEFAULT_STRAPS, talkAdjust, talkPause, talkPillValue, talkRemainingMs, talkResume, talkStart, TALK_MAX_SEC, TALK_STOPPED, visualText } from "@/lib/visuals"
import { DEFAULT_STAGE, LIVE_VISUAL_KEYS, parseStage } from "@/lib/stage"
import { parseAction, visualPatch } from "@/lib/transport"

const T0 = 1_800_000_000_000

test("talk timer: start, remaining, +1/-1 min, pause/resume, stop", () => {
  const t = talkStart(600, T0)
  assert.equal(talkRemainingMs(t, T0 + 1000), 599_000)
  assert.equal(talkRemainingMs(talkAdjust(t, 60, T0), T0), 660_000)
  assert.equal(talkRemainingMs(talkAdjust(t, -900, T0), T0), 0, "never below 0")
  const p = talkPause(t, T0 + 100_000)
  assert.deepEqual(p, { endsAt: null, pausedMs: 500_000 })
  assert.equal(talkRemainingMs(p, T0 + 999_999), 500_000, "paused does not tick")
  assert.equal(talkRemainingMs(talkAdjust(p, 60, T0), T0), 560_000, "adjust while paused stays paused")
  assert.deepEqual(talkResume(p, T0 + 200_000), { endsAt: T0 + 700_000, pausedMs: null })
  assert.equal(talkRemainingMs(TALK_STOPPED, T0), null)
  assert.deepEqual(talkAdjust(TALK_STOPPED, 60, T0), TALK_STOPPED, "stopped: +1 does nothing")
  assert.equal(talkRemainingMs(talkStart(TALK_MAX_SEC * 10, T0), T0), TALK_MAX_SEC * 1000, "capped at 4h")
  assert.equal(talkRemainingMs(talkStart(-5, T0), T0), 0)
})

test("talk timer: stored values validated (paused wins, junk = stopped)", () => {
  assert.deepEqual(parseTalkTimer(T0, 5000), { endsAt: null, pausedMs: 5000 })
  assert.deepEqual(parseTalkTimer(T0, null), { endsAt: T0, pausedMs: null })
  assert.deepEqual(parseTalkTimer("x", NaN), TALK_STOPPED)
  assert.deepEqual(parseTalkTimer(null, -10), { endsAt: null, pausedMs: 0 })
})

test("formatClock and the pill value (Session timer vs Festival to event end)", () => {
  assert.equal(formatClock(754_000), "12:34")
  assert.equal(formatClock(3_723_000), "1:02:03")
  assert.equal(formatClock(400), "00:01", "rounds up: 0:00 only at the end")
  assert.equal(formatClock(0), "00:00")
  assert.equal(formatClock(null), "--:--")
  const timer = talkStart(300, T0)
  assert.deepEqual(talkPillValue("session", timer, null, T0), { ms: 300_000, over: false })
  assert.deepEqual(talkPillValue("session", timer, null, T0 + 400_000), { ms: 0, over: true })
  assert.deepEqual(talkPillValue("festival", TALK_STOPPED, T0 + 3_600_000, T0), { ms: 3_600_000, over: false })
  assert.deepEqual(talkPillValue("festival", timer, null, T0), { ms: null, over: false })
})

test("ticker items and pill text sanitised", () => {
  assert.deepEqual(sanitizeTickerItems("a\n\n  b  \r\nc"), ["a", "b", "c"])
  assert.equal(sanitizeTickerItems(Array.from({ length: 50 }, (_, i) => `x${i}`)).length, 20)
  assert.equal(sanitizeTickerItems([1, null, "ok"]).length, 1)
  assert.equal(visualText("a\nb   c", "f"), "a b c")
  assert.equal(visualText("y".repeat(500), "f").length, 120)
  assert.equal(visualText(5, "f"), "f")
})

test("house strap style: available, default for new presets; old 4 styles kept", () => {
  for (const s of ["house", "line", "block", "pill", "gradient"]) assert.ok((STRAP_STYLES as readonly string[]).includes(s))
  assert.equal(DEFAULT_STRAPS[0].style, "house")
})

test("stage: defaults, validation, partial updates keep the rest", () => {
  assert.equal(DEFAULT_STAGE.streamVisuals, true)
  assert.equal(DEFAULT_STAGE.talkVisible, false)
  const s = parseStage({ talkMode: "bogus", tickerType: "social", tickerItems: "One\nTwo", qaText: "   ", talkEndsAt: T0, talkPausedMs: 1000, streamVisuals: "no" })
  assert.equal(s.talkMode, "session")
  assert.equal(s.tickerType, "social")
  assert.deepEqual(s.tickerItems, ["One", "Two"])
  assert.equal(s.qaText, DEFAULT_STAGE.qaText, "blank text keeps the default")
  assert.equal(s.talkEndsAt, null)
  assert.equal(s.talkPausedMs, 1000)
  assert.equal(s.streamVisuals, true, "only false turns it off")
  const next = parseStage({ qaVisible: true }, s)
  assert.deepEqual(next.tickerItems, ["One", "Two"])
  assert.equal(next.talkPausedMs, 1000)
})

test("live visual keys: a desk save can't write stale copies back", () => {
  for (const k of ["streamVisuals", "talkVisible", "talkEndsAt", "talkPausedMs", "tickerVisible", "tickerItems", "qaVisible", "sponsorVisible"]) assert.ok((LIVE_VISUAL_KEYS as readonly string[]).includes(k), k)
})

test("deck action 'visual': parse rejects junk, patches apply", () => {
  assert.equal(parseAction({ type: "visual", target: "nope", show: true }), null)
  assert.equal(parseAction({ type: "visual", target: "talk", op: "start" }), null, "start needs sec")
  assert.equal(parseAction({ type: "visual", target: "talk" }), null, "no-op")
  const start = parseAction({ type: "visual", target: "talk", op: "start", sec: 1200 })
  assert.ok(start && start.type === "visual")
  const stage = { ...DEFAULT_STAGE }
  const p = visualPatch(stage, start as never, T0)
  assert.deepEqual(p, { talkEndsAt: T0 + 1_200_000, talkPausedMs: null, talkVisible: true, talkMode: "session" })
  const add = visualPatch({ ...stage, ...p }, { type: "visual", target: "talk", op: "add", sec: -60 }, T0)
  assert.equal(add.talkEndsAt, T0 + 1_140_000)
  assert.deepEqual(visualPatch(stage, { type: "visual", target: "talk", op: "stop" }, T0), { talkEndsAt: null, talkPausedMs: null })
  assert.deepEqual(visualPatch(stage, { type: "visual", target: "talk", show: true, mode: "festival" }, T0), { talkVisible: true, talkMode: "festival" })
  const tick = parseAction({ type: "visual", target: "ticker", show: true, tickerType: "social", items: "a\nb" })
  assert.deepEqual(visualPatch(stage, tick as never, T0), { tickerVisible: true, tickerType: "social", tickerPlannerItems: [], tickerSocialItems: ["a", "b"], tickerItems: ["a", "b"] })
  assert.deepEqual(visualPatch(stage, { type: "visual", target: "qa", show: true, text: "Ask us" }, T0), { qaVisible: true, qaText: "Ask us" })
  assert.deepEqual(visualPatch(stage, { type: "visual", target: "sponsor", show: false }, T0), { sponsorVisible: false })
  assert.deepEqual(visualPatch(stage, { type: "visual", target: "stream", show: false }, T0), { streamVisuals: false })
})

test("layer parts: full-screen cards hide it; master switch; OBS overlay ignores the /stream switch", async () => {
  const { layerParts } = await import("@/components/visuals-layer")
  const on = { ...DEFAULT_STAGE, talkVisible: true, tickerVisible: true, tickerItems: ["x"], qaVisible: true, sponsorVisible: true, socialsOverlay: true }
  assert.deepEqual(layerParts(on, "program"), { strap: true, talk: true, ticker: true, qa: true, sponsor: true, socials: true, logos: [], qr: false, qrLogo: false })
  assert.equal(layerParts(on, "countdown").socials, false, "countdown has its own circles")
  const off = (v: unknown) => (Array.isArray(v) ? v.length === 0 : !v)
  for (const sc of ["break", "hold", "welcome", "end", "hold05", "hold06", "hold07", "standby", "showreel"] as const) assert.ok(Object.values(layerParts({ ...on, logosOn: ["logo1"], qrOn: true }, sc)).every(off), sc)
  assert.ok(Object.values(layerParts({ ...on, streamVisuals: false }, "program")).every(off))
  assert.equal(layerParts({ ...on, streamVisuals: false }, "overlay").talk, true)
  assert.equal(layerParts({ ...on, tickerItems: [] }, "program").ticker, false, "empty ticker stays hidden")
})
