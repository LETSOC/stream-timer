import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import QRCode from "qrcode"
import { DEFAULT_STAGE, LIVE_VISUAL_KEYS, parseStage, stageScreen } from "@/lib/stage"
import { applyTransport, deckState, parseAction, SCREENS, visualPatch, type TransportState } from "@/lib/transport"
import { DEFAULT_EVENT } from "@/lib/event"
import { DEFAULT_LOGO_SVG, DEFAULT_SCENES, LOGO_BRAND, LOGO_IDS, logoSrc, parseLogos, parseQr, parseScenes, qrBadgeBox, qrMatrix, qrRingCell, sanitizeSvg, SCENE_IDS, uploadPath } from "@/lib/visuals-assets"
import { boxesOverlap, DEFAULT_LAYOUT, placeOffsets, type Box, type LayoutPart } from "@/lib/visuals-layout"
import { DRAFT_KEYS, draftFrom, previewStage, saveBody } from "@/lib/visuals-builder"
import { tickerLine } from "@/lib/visuals"

const T0 = 1_800_000_000_000

test("sanitizeSvg: strips script, foreignObject, handlers, external refs; keeps the drawing", () => {
  const evil = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><foreignObject><div>x</div></foreignObject>
    <a href="javascript:alert(1)"><rect width="10" height="10" fill="#f00" onclick='x()'/></a><image href="https://evil.example/x.png"/><use xlink:href="#ok"/>
    <rect style="fill:url(https://evil.example/p)" fill="url(#g)"/><style>@import url(x)</style></svg>`
  const out = sanitizeSvg(evil)
  assert.ok(out.startsWith("<svg"), out)
  for (const bad of ["<script", "foreignObject", "onload", "onclick", "javascript:", "evil.example", "@import", "ENTITY", "<style"]) assert.equal(out.includes(bad), false, bad)
  assert.ok(out.includes('xlink:href="#ok"'), "local refs stay")
  assert.ok(out.includes('fill="url(#g)"'), "local url() stays")
  assert.ok(out.includes('fill="#f00"'))
  assert.ok(out.includes('xmlns="http://www.w3.org/2000/svg"'))
  assert.equal(sanitizeSvg("<div>hi</div>"), "")
  assert.equal(sanitizeSvg("<svg>" + "x".repeat(100_001) + "</svg>"), "")
  assert.equal(sanitizeSvg(42), "")
})

test("logos: the 5 built-in SVGs from the design survive sanitising; colour recolours the brand orange", () => {
  for (const id of LOGO_IDS) {
    assert.ok(sanitizeSvg(DEFAULT_LOGO_SVG[id]).includes("<path"), id)
    assert.ok(DEFAULT_LOGO_SVG[id].includes(`fill="${LOGO_BRAND}"`), id)
  }
  assert.ok(DEFAULT_LOGO_SVG.logo5.includes('width="517" height="137"'))
  const src = logoSrc("logo2", { source: "default", image: "", svg: "", color: "#1236a0", text: "" })
  assert.ok(src.startsWith("data:image/svg+xml"))
  const svg = decodeURIComponent(src.split(",")[1])
  assert.ok(svg.includes('fill="#1236a0"') && !svg.includes(LOGO_BRAND))
  assert.equal(logoSrc("logo1", { source: "image", image: "/uploads/" + "a".repeat(32) + ".png", svg: "", color: LOGO_BRAND, text: "" }), "/uploads/" + "a".repeat(32) + ".png")
  assert.equal(logoSrc("logo1", { source: "svg", image: "", svg: "", color: LOGO_BRAND, text: "" }), "")
})

test("logos/QR/scenes parse junk-tolerant; uploads only from /uploads; pasted SVG cleaned on parse", () => {
  const l = parseLogos({ logo3: { source: "svg", svg: '<svg onload="x()"><circle r="2"/></svg>', color: "red", text: " Hi  there " }, logo1: { source: "image", image: "https://evil.example/a.png" } })
  assert.equal(l.logo3.source, "svg")
  assert.equal(l.logo3.svg.includes("onload"), false)
  assert.equal(l.logo3.color, LOGO_BRAND, "bad colour falls back")
  assert.equal(l.logo3.text, "Hi there")
  assert.equal(l.logo1.image, "", "remote images refused")
  assert.equal(uploadPath("/uploads/" + "b".repeat(32) + ".svg"), "/uploads/" + "b".repeat(32) + ".svg")
  assert.equal(uploadPath("/uploads/../x.svg"), "")
  const q = parseQr({ url: "javascript:alert(1)", color: "#123456", badgeText: "LONGTEXT" })
  assert.equal(q.url, "https://linktr.ee/onlinehyphen")
  assert.equal(q.color, "#123456")
  assert.equal(q.badgeText, "LONG")
  const sc = parseScenes({ hold05: { label: "", pill: "X", bgMode: "video", dim: 500 } })
  assert.equal(sc.hold05.label, DEFAULT_SCENES.hold05.label)
  assert.equal(sc.hold05.pill, "X")
  assert.equal(sc.hold05.bgMode, "solid")
  assert.equal(sc.hold05.dim, 90)
  const st = parseStage({ logosOn: ["logo5", "nope", "logo1"], qrOn: true, overlay: "showreel" })
  assert.deepEqual(st.logosOn, ["logo1", "logo5"])
  assert.equal(st.qrOn, true)
  assert.equal(st.overlay, "showreel")
  assert.equal(parseStage({ overlay: "hold99" }).overlay, "none")
})

test("QR: real modules (same as the qrcode lib), Logo QR is ECC H with a small centre badge clear of the finders", () => {
  const url = "https://linktr.ee/onlinehyphen"
  const m = qrMatrix(url, "M")!
  const ref = QRCode.create(url, { errorCorrectionLevel: "M" })
  assert.equal(m.size, ref.modules.size)
  assert.equal(m.dark.filter(Boolean).length, Array.from(ref.modules.data).filter(Boolean).length)
  const h = qrMatrix(url, "H")!
  const b = qrBadgeBox(h.size)
  assert.ok((b.w * b.w) / (h.size * h.size) < 0.09, "badge covers < 9% (ECC H restores ~30%)")
  assert.ok(b.x >= 8 && b.x + b.w <= h.size - 8, "badge never on a finder pattern")
  assert.equal(qrMatrix("", "M"), null)
  // animated step cell: always on the quiet-zone ring, never on a module
  for (let i = 0; i < 4 * (m.size + 1) + 3; i++) {
    const c = qrRingCell(m.size, i)
    assert.ok(c.x === -1 || c.y === -1 || c.x === m.size || c.y === m.size, `step ${i}`)
  }
})

const state = (stage = DEFAULT_STAGE): TransportState => ({ event: DEFAULT_EVENT, stage, testUntil: null, pausedAt: null })

test("deck: logo / QR show-hide actions; junk refused; clear all turns them off", () => {
  assert.equal(parseAction({ type: "visual", target: "logo", logo: "logo9", show: true }), null)
  assert.equal(parseAction({ type: "visual", target: "logo", logo: "logo2" }), null, "needs show")
  const a = parseAction({ type: "visual", target: "logo", logo: "logo2", show: true })!
  assert.deepEqual(visualPatch(DEFAULT_STAGE, a as never, T0), { logosOn: ["logo2"] })
  const two = visualPatch({ ...DEFAULT_STAGE, logosOn: ["logo4"] }, a as never, T0)
  assert.deepEqual(two, { logosOn: ["logo2", "logo4"] })
  const hide = parseAction({ type: "visual", target: "logo", logo: "logo4", show: false })!
  assert.deepEqual(visualPatch({ ...DEFAULT_STAGE, logosOn: ["logo2", "logo4"] }, hide as never, T0), { logosOn: ["logo2"] })
  assert.deepEqual(visualPatch(DEFAULT_STAGE, parseAction({ type: "visual", target: "qr", show: true }) as never, T0), { qrOn: true })
  assert.deepEqual(visualPatch(DEFAULT_STAGE, parseAction({ type: "visual", target: "qrLogo", show: true }) as never, T0), { qrLogoOn: true })
  for (const k of ["logosOn", "qrOn", "qrLogoOn"]) assert.ok((LIVE_VISUAL_KEYS as readonly string[]).includes(k), k)
  const d = deckState({ ...state({ ...DEFAULT_STAGE, logosOn: ["logo3"], qrOn: true }), rev: 1, testSetAt: null }, T0)
  assert.deepEqual(d.visuals?.logosOn, ["logo3"])
  assert.equal(d.visuals?.qrOn, true)
})

test("scenes: one screen action each, same full-screen system as Break/Hold/Welcome (cards over program)", () => {
  for (const id of SCENE_IDS) {
    assert.ok(SCREENS.includes(id), id)
    const r = applyTransport(state({ ...DEFAULT_STAGE, program: true }), parseAction({ type: "screen", screen: id })!, T0)
    assert.ok(r.ok)
    if (!r.ok) continue
    assert.equal(r.next.stage.overlay, id)
    assert.equal(r.next.stage.overlayAt, T0)
    assert.equal(r.next.stage.program, true, "program stays on underneath")
    assert.equal(stageScreen(r.next.stage, false), id)
  }
  const back = applyTransport(state({ ...DEFAULT_STAGE, overlay: "hold07", program: true }), { type: "screen", screen: "program" }, T0)
  assert.ok(back.ok && back.next.stage.overlay === "none" && stageScreen(back.next.stage, false) === "program")
  assert.equal(parseAction({ type: "screen", screen: "hold99" }), null)
})

/** Countdown no-go zones (same as the builder test) + the parts already placed. */
const NO_GO: Record<string, Box> = {
  liveLine: { x: 96, y: 90, w: 1018, h: 50 },
  qr: { x: 1700, y: 24, w: 200, h: 250 },
  socialIcons: { x: 96, y: 840, w: 700, h: 220 },
  gallery: { x: 1150, y: 290, w: 660, h: 500 },
}
const SIZE: Record<LayoutPart, { w: number; h: number }> = {
  talk: { w: 420, h: 64 }, sponsor: { w: 320, h: 60 }, qa: { w: 420, h: 60 }, strap: { w: 760, h: 130 }, socials: { w: 0, h: 0 },
  logo1: { w: 178, h: 178 }, logo2: { w: 178, h: 178 }, logo3: { w: 178, h: 178 }, logo4: { w: 178, h: 178 }, logo5: { w: 517, h: 137 },
  qr: { w: 178, h: 178 }, qrLogo: { w: 178, h: 178 },
}
function box(screen: "countdown" | "program", part: LayoutPart): Box {
  const p = DEFAULT_LAYOUT[screen][part]
  const o = placeOffsets(p)
  const w = (SIZE[part].w * p.size) / 100
  const h = (SIZE[part].h * p.size) / 100
  return { x: o.left ?? 1920 - (o.right ?? 0) - w, y: o.top ?? 1080 - (o.bottom ?? 0) - h, w, h }
}

test("countdown defaults: logos and QR clear of the countdown screen and of every other part", () => {
  const added: LayoutPart[] = ["logo1", "logo2", "logo3", "logo4", "logo5", "qr", "qrLogo"]
  const old: LayoutPart[] = ["talk", "sponsor", "qa", "strap"]
  for (const a of added) {
    for (const [name, z] of Object.entries(NO_GO)) assert.equal(boxesOverlap(box("countdown", a), z), false, `${a} vs ${name}`)
    for (const b of old) assert.equal(boxesOverlap(box("countdown", a), box("countdown", b)), false, `${a} vs ${b}`)
  }
  // the logos share one slot (one at a time); the two QR codes sit side by side
  assert.equal(boxesOverlap(box("countdown", "qr"), box("countdown", "qrLogo")), false)
  for (const l of ["logo1", "logo5"] as const) for (const q of ["qr", "qrLogo"] as const) assert.equal(boxesOverlap(box("countdown", l), box("countdown", q)), false, `${l} vs ${q}`)
  // program: logos, QR and the classic pills don't collide either
  const prog: LayoutPart[] = ["talk", "sponsor", "qa", "strap", "logo1", "logo5", "qr", "qrLogo"]
  for (const a of prog) for (const b of prog) if (a < b && !(a.startsWith("logo") && b.startsWith("logo"))) assert.equal(boxesOverlap(box("program", a), box("program", b)), false, `program ${a} vs ${b}`)
})

test("builder: logos / QR / scenes / strap toggles go via Save (full body, clock unchanged); preview shows one logo + both QR", () => {
  for (const k of ["logos", "qr", "scenes", "strapAccentCircle", "strapArrow"]) assert.ok((DRAFT_KEYS as readonly string[]).includes(k), k)
  const d = draftFrom(DEFAULT_STAGE)
  const edited = { ...d, strapArrow: false, qr: { ...d.qr, url: "https://example.com/x" }, scenes: { ...d.scenes, hold06: { ...d.scenes.hold06, label: "Doors" } } }
  const loaded = { event: { name: "E" }, stage: { checker: 6, qrOn: true, logosOn: ["logo1"] }, rev: 7, testUntil: 123, pausedAt: null }
  const body = saveBody(loaded, edited)
  assert.equal(body.rev, 7)
  assert.equal(body.testUntil, 123)
  assert.equal(body.pausedAt, null)
  assert.equal((body.stage as Record<string, unknown>).strapArrow, false)
  assert.equal(((body.stage as Record<string, { label: string }>).scenes as unknown as Record<string, { label: string }>).hold06.label, "Doors")
  assert.equal((body.stage as Record<string, unknown>).qrOn, true, "live fields pass through as loaded")
  const pv = previewStage({}, undefined, d, { showAll: true, now: T0, logo: "logo4" })
  assert.deepEqual(pv.logosOn, ["logo4"])
  assert.equal(pv.qrOn && pv.qrLogoOn, true)
})

test("ticker lines carry the PLANNER / SOCIAL tag like the design", () => {
  assert.equal(tickerLine("planner", "10:00 Keynote"), "PLANNER • 10:00 Keynote")
  assert.equal(tickerLine("social", "SOCIAL • Q&A open"), "SOCIAL • Q&A open")
})

test("uploads: logo SVG is sanitised and stored as .svg; card uploads stay raster-only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-up-"))
  const prev = process.env.STREAM_DATA_DIR
  process.env.STREAM_DATA_DIR = dir
  try {
    const { saveUpload } = await import("@/lib/uploads")
    const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>1</script><rect width="4" height="4"/></svg>')
    assert.equal(saveUpload(bytes).ok, false, "not on the card path")
    const r = saveUpload(bytes, { svg: true })
    assert.ok(r.ok)
    if (!r.ok) return
    assert.match(r.url, /^\/uploads\/[a-f0-9]{32}\.svg$/)
    const stored = fs.readFileSync(path.join(dir, "uploads", r.url.split("/").pop()!), "utf8")
    assert.equal(stored.includes("script") || stored.includes("onload"), false)
    assert.equal(saveUpload(new TextEncoder().encode("<svg><foreignObject/></svg"), { svg: true }).ok, false)
  } finally {
    if (prev === undefined) delete process.env.STREAM_DATA_DIR
    else process.env.STREAM_DATA_DIR = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("ticker: Planner and Social keep separate lists; legacy single list migrates into the current type", () => {
  const legacy = parseStage({ tickerType: "social", tickerItems: ["old"] })
  assert.deepEqual([legacy.tickerSocialItems, legacy.tickerPlannerItems, legacy.tickerItems], [["old"], [], ["old"]])
  const st = parseStage({ tickerType: "planner", tickerPlannerItems: ["p1"], tickerSocialItems: ["s1", "s2"], tickerItems: ["stale"] })
  assert.deepEqual(st.tickerItems, ["p1"])
  assert.ok(LIVE_VISUAL_KEYS.includes("tickerPlannerItems") && LIVE_VISUAL_KEYS.includes("tickerSocialItems"))
  // switching type shows that type's own items; lists untouched
  const sw = visualPatch(st, { type: "visual", target: "ticker", tickerType: "social" }, 0)
  assert.deepEqual([sw.tickerItems, sw.tickerPlannerItems, sw.tickerSocialItems], [["s1", "s2"], ["p1"], ["s1", "s2"]])
  // editing the selected tab's list (list given) replaces only that list
  const a = parseAction({ type: "visual", target: "ticker", items: ["n1"], list: "social" })
  assert.equal((a as { list?: string }).list, "social")
  const ed = visualPatch(st, a as never, 0)
  assert.deepEqual([ed.tickerSocialItems, ed.tickerPlannerItems, ed.tickerItems], [["n1"], ["p1"], ["p1"]])
  // no list: edits the current type
  const cur = visualPatch(st, { type: "visual", target: "ticker", items: ["x"] }, 0)
  assert.deepEqual([cur.tickerPlannerItems, cur.tickerSocialItems], [["x"], ["s1", "s2"]])
  const ds = deckState({ ...state(st), rev: 1, testSetAt: null }, T0)
  assert.deepEqual([ds.visuals?.tickerPlannerItems, ds.visuals?.tickerSocialItems], [["p1"], ["s1", "s2"]])
})

test("scene cards survive the stage parser + desk reconcile (regression: new cards reverted to LIVE)", async () => {
  const { CARD_OVERLAYS, OVERLAYS, isOverlay } = await import("@/lib/stage")
  const { SCENE_IDS } = await import("@/lib/visuals-assets")
  for (const id of [...SCENE_IDS, "break", "hold", "welcome"]) {
    assert.ok(isOverlay(id) && CARD_OVERLAYS.includes(id as never), id)
    // what the desk re-saves after reading the stage must keep the card up
    assert.equal(parseStage(parseStage({ overlay: id })).overlay, id)
    assert.ok(SCREENS.includes(id as never))
  }
  assert.equal(parseStage({ overlay: "bogus" }).overlay, "none")
  assert.deepEqual(OVERLAYS, ["none", ...CARD_OVERLAYS])
  // the desk's load must accept every card (it used to whitelist only break/hold/welcome)
  const src = fs.readFileSync(path.join(process.cwd(), "components/operator-console.tsx"), "utf8")
  assert.match(src, /if \(isOverlay\(stage\.overlay\)\) setOverlay\(stage\.overlay\)/)
})

test("two-tap: every screen/card switch is risky, on any device, live or not", async () => {
  const { isRisky } = await import("@/lib/transport")
  for (const s of SCREENS) assert.ok(isRisky({ type: "screen", screen: s }), s)
  const deck = fs.readFileSync(path.join(process.cwd(), "components/visuals-deck.tsx"), "utf8")
  assert.doesNotMatch(deck, /scr === "program" && target !== "program"/)
})

test("every scene card has a renderer on /stream and in the desk preview (regression: desk preview fell back to the countdown)", async () => {
  const { CARD_OVERLAYS } = await import("@/lib/stage")
  const { isScene } = await import("@/lib/visuals-assets")
  const classic = CARD_OVERLAYS.filter((c) => !isScene(c))
  assert.deepEqual(classic, ["break", "hold", "welcome"])
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8")
  assert.match(read("components/stream-view.tsx"), /isScene\(shownScreen\) \? \(\s*<SceneHandoff id=\{shownScreen\}/)
  assert.match(read("components/operator-console.tsx"), /isScene\(previewScreen\) \? \([\s\S]{0,120}<SceneCardView id=\{previewScreen\}/)
  const React = await import("react")
  const { renderToStaticMarkup } = await import("react-dom/server")
  const { SceneCardView } = await import("@/components/visual-assets")
  for (const id of SCENE_IDS) {
    const html = renderToStaticMarkup(React.createElement(SceneCardView, { id, card: DEFAULT_SCENES[id], now: 0 }))
    assert.ok(html.includes(DEFAULT_SCENES[id].label) && html.includes(DEFAULT_SCENES[id].pill), id)
  }
})

test("scene handoff renders one keyed scene with no cover at rest (loop switch keeps the outgoing video on top)", async () => {
  const React = await import("react")
  const { renderToStaticMarkup } = await import("react-dom/server")
  const { SceneHandoff } = await import("@/components/scene-handoff")
  const id = SCENE_IDS[0]
  const html = renderToStaticMarkup(React.createElement(SceneHandoff, { id, scenes: DEFAULT_SCENES, now: 0, className: "x" }))
  assert.ok(html.includes(`data-testid="scene-${id}"`))
  assert.ok(html.includes('data-leaving=""'))
  const src = fs.readFileSync(path.join(process.cwd(), "components/scene-handoff.tsx"), "utf8")
  assert.match(src, /<SceneCardView key=\{sid\}/)
})
