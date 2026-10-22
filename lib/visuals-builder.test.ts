import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_STAGE, parseStage } from "@/lib/stage"
import { deckState, parseAction, visualPatch } from "@/lib/transport"
import { boxesOverlap, cornerOrigin, DEFAULT_LAYOUT, parseVisualsLayout, partCorner, placeOffsets, type Box, type PartPlace } from "@/lib/visuals-layout"
import { addStrap, deleteStrap, draftDirty, draftFrom, duplicateStrap, previewStage, saveBody, setPlace } from "@/lib/visuals-builder"

const T0 = 1_800_000_000_000

test("layout: junk falls back to defaults, values clamped, stage keeps it", () => {
  assert.deepEqual(parseVisualsLayout(null), DEFAULT_LAYOUT)
  const l = parseVisualsLayout({ program: { talk: { corner: "bottom-right", snap: "edge", dx: 5000, dy: -3, size: 10 } }, countdown: "x" })
  assert.deepEqual(l.program.talk, { corner: "bottom-right", snap: "edge", dx: 1800, dy: 0, size: 50 })
  assert.deepEqual(l.countdown, DEFAULT_LAYOUT.countdown)
  assert.deepEqual(parseStage({}).visualsLayout, DEFAULT_LAYOUT)
  const s = parseStage({ visualsLayout: { countdown: { qa: { corner: "top-left", dx: 12 } } } })
  assert.equal(s.visualsLayout.countdown.qa.corner, "top-left")
  assert.equal(s.visualsLayout.countdown.qa.dx, 12)
  // partial stage PUT keeps the layout
  assert.deepEqual(parseStage({ checker: 4 }, s).visualsLayout, s.visualsLayout)
})

test("layout: offsets from safe line or edge, plus inset, gap and ticker lift", () => {
  const p: PartPlace = { corner: "bottom-right", snap: "safe", dx: 10, dy: 20, size: 100 }
  assert.deepEqual(placeOffsets(p, 4, 64), { right: 96 + 4 + 10, bottom: 54 + 4 + 20 + 64 })
  assert.deepEqual(placeOffsets({ ...p, snap: "edge", corner: "top-left" }, 0, 64), { left: 42, top: 52 })
  assert.equal(cornerOrigin("top-right"), "top right")
})

test("program strap/socials follow the deck corner buttons; countdown uses the layout corner", () => {
  const deck = { strapCorner: "top-right" as const, socialsCorner: "top-left" as const }
  assert.equal(partCorner("program", "strap", DEFAULT_LAYOUT, deck), "top-right")
  assert.equal(partCorner("program", "socials", DEFAULT_LAYOUT, deck), "top-left")
  assert.equal(partCorner("countdown", "strap", DEFAULT_LAYOUT, deck), DEFAULT_LAYOUT.countdown.strap.corner)
  assert.equal(partCorner("program", "talk", DEFAULT_LAYOUT, deck), "top-left")
})

/** Countdown screen no-go zones (1920x1080, from countdown-stage): badge line, QR, social icons, gallery. */
const LIVE_COUNTDOWN_LINE: Box = { x: 96, y: 90, w: 1018, h: 50 }
const QR: Box = { x: 1700, y: 24, w: 200, h: 250 }
const SOCIAL_ICONS: Box = { x: 96, y: 840, w: 700, h: 220 }
const LOGO_GALLERY: Box = { x: 1150, y: 290, w: 660, h: 500 }
// generous sizes (px @1080p at 100%)
const SIZE = { talk: { w: 420, h: 64 }, sponsor: { w: 320, h: 60 }, qa: { w: 420, h: 60 }, strap: { w: 760, h: 130 } }
function box(part: keyof typeof SIZE): Box {
  const p = DEFAULT_LAYOUT.countdown[part]
  const o = placeOffsets(p)
  const w = (SIZE[part].w * p.size) / 100
  const h = (SIZE[part].h * p.size) / 100
  return { x: o.left ?? 1920 - (o.right ?? 0) - w, y: o.top ?? 1080 - (o.bottom ?? 0) - h, w, h }
}

test("countdown defaults: talk pill off the LIVE COUNTDOWN line, Sponsored off the QR, strap off the social icons, no part on another", () => {
  assert.equal(boxesOverlap(box("talk"), LIVE_COUNTDOWN_LINE), false)
  assert.equal(boxesOverlap(box("talk"), QR), false)
  assert.equal(boxesOverlap(box("sponsor"), QR), false)
  assert.equal(boxesOverlap(box("strap"), SOCIAL_ICONS), false)
  for (const part of ["talk", "sponsor", "qa", "strap"] as const) assert.equal(boxesOverlap(box(part), LOGO_GALLERY), false, `${part} vs logo/gallery`)
  const parts = ["talk", "sponsor", "qa", "strap"] as const
  for (const a of parts) for (const b of parts) if (a < b) assert.equal(boxesOverlap(box(a), box(b)), false, `${a} vs ${b}`)
  // program keeps the classic corners
  assert.equal(DEFAULT_LAYOUT.program.talk.corner, "top-left")
  assert.equal(DEFAULT_LAYOUT.program.sponsor.corner, "top-right")
})

test("builder draft: dirty, setPlace, add/duplicate/delete speakers", () => {
  const d = draftFrom(DEFAULT_STAGE)
  assert.equal(draftDirty(DEFAULT_STAGE, d), false)
  const moved = { ...d, visualsLayout: setPlace(d.visualsLayout, "countdown", "qa", { dy: 40 }) }
  assert.equal(moved.visualsLayout.countdown.qa.dy, 40)
  assert.equal(moved.visualsLayout.program.qa.dy, 0)
  assert.equal(draftDirty(DEFAULT_STAGE, moved), true)
  const added = addStrap(d.straps, T0, 0.5)
  assert.equal(added.length, d.straps.length + 1)
  assert.equal(added.at(-1)?.style, "house")
  const dup = duplicateStrap(added, added[0].id, T0 + 1, 0.1)
  assert.equal(dup[1].name, `${added[0].name} (copy)`)
  assert.notEqual(dup[1].id, added[0].id)
  assert.equal(deleteStrap(dup, dup[1].id).length, added.length)
})

test("save body: full event + stage + rev, test clock unchanged, only save-path fields replaced", () => {
  const loaded = { event: { name: "E" }, stage: { ...DEFAULT_STAGE, qaText: "LIVE" } as Record<string, unknown>, rev: 7, testUntil: 123, pausedAt: null }
  const draft = { ...draftFrom(DEFAULT_STAGE), strapAccent: "#123456" }
  const body = saveBody(loaded, draft)
  assert.equal(body.rev, 7)
  assert.equal(body.testUntil, 123)
  assert.equal(body.pausedAt, null)
  assert.deepEqual(body.event, { name: "E" })
  assert.equal(body.stage.strapAccent, "#123456")
  assert.equal(body.stage.qaText, "LIVE")
  assert.ok(body.stage.visualsLayout)
})

test("preview stage: live values over saved, draft over both; Show all forces every part on", () => {
  const d = draftFrom(DEFAULT_STAGE)
  const p = previewStage({ ...DEFAULT_STAGE }, { qaText: "Ask us" }, d, { showAll: false, now: T0 })
  assert.equal(p.qaText, "Ask us")
  assert.equal(p.qaVisible, false)
  const all = previewStage({ ...DEFAULT_STAGE }, undefined, d, { showAll: true, now: T0 })
  assert.ok(all.qaVisible && all.sponsorVisible && all.talkVisible && all.tickerVisible && all.socialsOverlay && all.streamVisuals)
  assert.equal(all.strapMode, "in")
  assert.equal(all.strapAt, T0)
  assert.ok(all.tickerItems.length > 0)
})

test("talk prefixes: separate fields set either prefix without flipping the mode", () => {
  const a = parseAction({ type: "visual", target: "talk", festivalPrefix: "Fest ends" })
  assert.ok(a && a.type === "visual")
  const patch = visualPatch({ ...DEFAULT_STAGE, talkMode: "session" }, a as Extract<NonNullable<typeof a>, { type: "visual" }>, T0)
  assert.deepEqual(patch, { festivalPrefix: "Fest ends" })
  const b = parseAction({ type: "visual", target: "talk", talkPrefix: "  Talk  ends " })
  const pb = visualPatch({ ...DEFAULT_STAGE, talkMode: "festival" }, b as Extract<NonNullable<typeof b>, { type: "visual" }>, T0)
  assert.deepEqual(pb, { talkPrefix: "Talk ends" })
  assert.equal(parseAction({ type: "visual", target: "talk" }), null)
})

test("deck state exposes both talk prefixes", () => {
  const s = deckState({ event: { date: "2026-11-04", time: "10:00", endTime: "18:00", timeZone: "Europe/London" } as never, testUntil: null, pausedAt: null, stage: { ...DEFAULT_STAGE, festivalPrefix: "F" }, rev: 1, testSetAt: null } as never, T0)
  assert.equal(s.visuals?.talkPrefix, DEFAULT_STAGE.talkPrefix)
  assert.equal(s.visuals?.festivalPrefix, "F")
})

test("builder program feed: on-air input when signal, placeholder when off or no signal", async () => {
  const { builderProgramFeed } = await import("@/lib/visuals-builder")
  assert.deepEqual(builderProgramFeed({ programSource: "main", programReady: true }, true), { path: "program", source: "main", signal: true })
  assert.deepEqual(builderProgramFeed({ programSource: "backup", programReady: true, programSources: { main: { ready: true }, backup: { ready: true } } }, true), { path: "program-backup", source: "backup", signal: true })
  assert.deepEqual(builderProgramFeed({ programSource: "backup", programReady: true, programSources: { main: { ready: true }, backup: { ready: false } } }, true), { path: null, source: "backup", signal: false })
  assert.equal(builderProgramFeed({ programSource: "main", programReady: true }, false).path, null)
  assert.deepEqual(builderProgramFeed(null, true), { path: null, source: "main", signal: false })
})

test("builder Live tab: real /stream muted, only mounted while selected, /stream untouched", async () => {
  const fs = await import("node:fs")
  const src = fs.readFileSync("components/visuals-builder.tsx", "utf8")
  assert.match(src, /src="\/stream\?mute=1"/)
  assert.match(src, /\{liveView \? <LiveMonitor state=\{state\} \/> : \(/)
  assert.match(src, /data-testid="vb-screen-live"[\s\S]{0,200}>Live<\/button>/)
  assert.match(src, /data-testid="vb-multiview"/)
  assert.match(src, /vb-multiview/)
  assert.match(src, /ProgramPlayer/)
  assert.match(src, /programOperatorSrc/)
  // the existing mute param still mutes program and bed on /stream
  const view = fs.readFileSync("components/stream-view.tsx", "utf8")
  assert.match(view, /muted=\{params\.get\("mute"\) === "1" \|\| !isAir\}/)
  assert.match(view, /urlMute=\{params\.get\("mute"\) === "1"\}/)
})
