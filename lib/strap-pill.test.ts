import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { NameStrap } from "@/components/name-strap"
import { VisualsLayer } from "@/components/visuals-layer"
import { DEFAULT_EVENT } from "@/lib/event"
import { DEFAULT_STAGE, parseStage } from "@/lib/stage"
import { DEFAULT_PILL, parsePillDesign, pillIconSide, pillOrder, pillPadding } from "@/lib/strap-pill"
import { DEFAULT_STRAP_DESIGN, parseStrapDesigns, type StrapDesign } from "@/lib/visuals"
import { cornerOrigin, DEFAULT_LAYOUT, parsePlace, parseVisualsLayout, placeOffsets } from "@/lib/visuals-layout"
import { setPlace } from "@/lib/visuals-builder"

const preset = { name: "Alex Rivera", title: "Designer", handle: "@alex", platform: "instagram" as const }
const strap = (design: StrapDesign) => renderToStaticMarkup(createElement(NameStrap, { preset, visible: true, look: { style: "pill", motion: "slide-left", accent: "#d9ff43", text: "#ffffff", design } }))

test("parsePillDesign: junk-tolerant, clamps, undefined when absent", () => {
  assert.equal(parsePillDesign(undefined), undefined)
  assert.equal(parsePillDesign("x"), undefined)
  assert.equal(parsePillDesign([]), undefined)
  assert.deepEqual(parsePillDesign({}), DEFAULT_PILL)
  const p = parsePillDesign({ layout: "inline", order: "icon-text-dot", icon: "full", box: "glass", hideSub: true, padY: 999, gap: -5, border: "3", blur: "junk" })!
  assert.equal(p.layout, "inline")
  assert.equal(p.order, "icon-text-dot")
  assert.equal(p.icon, "full")
  assert.equal(p.box, "glass")
  assert.equal(p.hideSub, true)
  assert.equal(p.padY, 48)
  assert.equal(p.gap, 0)
  assert.equal(p.border, 3)
  assert.equal(p.blur, DEFAULT_PILL.blur)
  assert.equal(parsePillDesign({ layout: "diagonal", order: "x" })!.layout, "stack")
})

test("parseStrapDesigns: pill options only on the Social pill, absent stays absent", () => {
  const d = parseStrapDesigns({ pill: { pill: { layout: "inline" } }, house: { pill: { layout: "inline" } } })
  assert.equal(d.pill.pill?.layout, "inline")
  assert.equal("pill" in d.house, false)
  assert.equal("pill" in parseStrapDesigns({}).pill, false)
  // survives a stage round trip
  const st = parseStage({ strapDesigns: { pill: { pill: { order: "dot-text-icon", icon: "full" } } } })
  assert.equal(st.strapDesigns.pill.pill?.order, "dot-text-icon")
  assert.equal(parseStage(JSON.parse(JSON.stringify(st))).strapDesigns.pill.pill?.icon, "full")
})

test("pillOrder / pillIconSide / pillPadding", () => {
  const all = { dot: true, icon: true }
  assert.deepEqual(pillOrder({ order: "auto", icon: "inline" }, all), ["dot", "icon", "text"])
  assert.deepEqual(pillOrder({ order: "auto", icon: "full" }, all), ["icon", "dot", "text"])
  assert.deepEqual(pillOrder({ order: "icon-text-dot", icon: "inline" }, { dot: false, icon: true }), ["icon", "text"])
  assert.deepEqual(pillOrder({ order: "dot-text-icon", icon: "inline" }, { dot: true, icon: false }), ["dot", "text"])
  assert.equal(pillIconSide(["icon", "dot", "text"]), "first")
  assert.equal(pillIconSide(["dot", "text", "icon"]), "last")
  assert.equal(pillIconSide(["dot", "icon", "text"]), "mid")
  assert.equal(pillIconSide(["dot", "text"]), "none")
  const full = { ...DEFAULT_PILL, icon: "full" as const, iconInset: 4 }
  assert.deepEqual(pillPadding(DEFAULT_PILL, "first"), [16, 32, 16, 32])
  assert.deepEqual(pillPadding(full, "first"), [4, 32, 4, 4])
  assert.deepEqual(pillPadding(full, "last"), [4, 4, 4, 32])
  assert.deepEqual(pillPadding(full, "mid"), [4, 32, 4, 32])
  assert.deepEqual(pillPadding(full, "none"), [16, 32, 16, 32])
})

test("NameStrap pill: no options = the classic markup (unchanged)", () => {
  const html = strap(DEFAULT_STRAP_DESIGN)
  assert.equal(html.includes("strap-pill-x"), false)
  assert.ok(html.indexOf("strap-live-dot") < html.indexOf("data-platform") && html.indexOf("data-platform") < html.indexOf("strap-name"))
  assert.ok(html.includes("@alex"))
})

test("NameStrap pill options: order, one line, hide sub, full-bleed, box", () => {
  const base = { ...DEFAULT_STRAP_DESIGN }
  const def = strap({ ...base, pill: DEFAULT_PILL })
  assert.ok(def.includes('data-pill-order="dot-icon-text"'))
  assert.ok(def.includes("padding:calc(16 * var(--px)) calc(32 * var(--px)) calc(16 * var(--px)) calc(32 * var(--px))"))
  const o = strap({ ...base, pill: { ...DEFAULT_PILL, order: "icon-text-dot", layout: "inline", box: "glass" } })
  assert.ok(o.includes('data-pill-order="icon-text-dot"'))
  assert.ok(o.indexOf("data-platform") < o.indexOf("strap-name") && o.indexOf("strap-name") < o.indexOf("strap-live-dot"))
  assert.ok(o.includes("strap-pill-inline") && o.includes("strap-pill-box-glass"))
  const hidden = strap({ ...base, off: ["live", "icon"], pill: { ...DEFAULT_PILL, hideSub: true } })
  assert.ok(hidden.includes('data-pill-order="text"'))
  assert.equal(hidden.includes("@alex"), false)
  assert.equal(hidden.includes("data-platform"), false)
  const full = strap({ ...base, pill: { ...DEFAULT_PILL, icon: "full", iconInset: 2 } })
  assert.ok(full.includes("strap-pill-full"))
  assert.ok(full.includes('data-pill-order="icon-dot-text"'))
  assert.ok(full.includes("padding:calc(2 * var(--px)) calc(32 * var(--px)) calc(2 * var(--px)) calc(2 * var(--px))"))
  // full-bleed with the icon hidden falls back to normal padding
  const noIcon = strap({ ...base, off: ["icon"], pill: { ...DEFAULT_PILL, icon: "full" } })
  assert.equal(noIcon.includes("strap-pill-full"), false)
})

test("Layout centre: parse, offsets, origin, setPlace toggles off cleanly", () => {
  assert.equal("center" in parsePlace({}, DEFAULT_LAYOUT.program.strap), false)
  assert.equal(parsePlace({ center: true }, DEFAULT_LAYOUT.program.strap).center, true)
  assert.equal("center" in parseVisualsLayout(undefined).program.strap, false)
  const c = { ...DEFAULT_LAYOUT.program.strap, center: true, dx: 10 }
  assert.deepEqual(placeOffsets(c), { left: 970, bottom: 54 })
  assert.equal(cornerOrigin("bottom-left", true), "bottom center")
  assert.equal(cornerOrigin("top-right"), "top right")
  const on = setPlace(DEFAULT_LAYOUT, "program", "strap", { center: true })
  assert.equal(on.program.strap.center, true)
  assert.equal("center" in setPlace(on, "program", "strap", { center: false }).program.strap, false)
})

test("VisualsLayer: centred strap is anchored on the middle of the frame", () => {
  const layout = setPlace(DEFAULT_LAYOUT, "program", "strap", { center: true })
  const stage = { ...parseStage({ ...DEFAULT_STAGE, visualsLayout: layout }), strapId: "a", strapMode: "in" as const, straps: [{ id: "a", ...preset, style: "pill" as const }] }
  const html = renderToStaticMarkup(createElement(VisualsLayer, { stage, event: DEFAULT_EVENT, screen: "program", now: 1_800_000_000_000, eventEndMs: null }))
  const m = html.match(/<div class="vl-anchor" data-part="strap" style="([^"]*)"/)
  assert.ok(m, html.slice(0, 400))
  assert.ok(m[1].includes("left:calc(960 * var(--px))"), m[1])
  assert.ok(m[1].includes("translateX(-50%)"), m[1])
})

test("Minimal line: one-line option (line only, default two lines)", () => {
  assert.equal("oneLine" in parseStrapDesigns({}).line, false)
  assert.equal(parseStrapDesigns({ line: { oneLine: true } }).line.oneLine, true)
  assert.equal("oneLine" in parseStrapDesigns({ line: { oneLine: "yes" } }).line, false)
  assert.equal("oneLine" in parseStrapDesigns({ house: { oneLine: true } }).house, false)
  assert.equal(parseStage(JSON.parse(JSON.stringify(parseStage({ strapDesigns: { line: { oneLine: true } } })))).strapDesigns.line.oneLine, true)
  const line = (design: StrapDesign) => renderToStaticMarkup(createElement(NameStrap, { preset, visible: true, look: { style: "line", motion: "slide-left", accent: "#d9ff43", text: "#ffffff", design } }))
  const two = line(DEFAULT_STRAP_DESIGN)
  assert.equal(two.includes("strap-one-line"), false)
  assert.equal(two.includes("data-one-line"), false)
  const one = line({ ...DEFAULT_STRAP_DESIGN, oneLine: true })
  assert.ok(one.includes("strap-one-line") && one.includes('data-one-line="1"'))
  assert.ok(one.includes("Designer") && one.includes("@alex"))
})

test("speaker preset panel draws its own live strap preview from the draft design", async () => {
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(new URL("../components/visuals-builder.tsx", import.meta.url), "utf8")
  const at = src.indexOf('data-testid="vb-strap-mini"')
  assert.ok(at > 0, "inline preview present in the preset panel")
  const block = src.slice(at, at + 600)
  assert.match(block, /<NameStrap[^>]*preset=\{s\}/)
  assert.match(block, /style: s\.style/)
  assert.match(block, /design: draft\.strapDesigns\[s\.style\]/)
  // the preset preview path renders one line for a preset with title + handle + platform icon + live dot
  const full = { name: "Speaker Name", title: "Job title · Company", handle: "@onlinehyphen", platform: "youtube" as const }
  const html = renderToStaticMarkup(createElement(NameStrap, { preset: full, visible: true, look: { style: "line", motion: "slide-left", accent: "#d9ff43", text: "#ffffff", design: { ...DEFAULT_STRAP_DESIGN, nameSize: 50, subSize: 100, oneLine: true } } }))
  assert.ok(html.includes("strap-one-line") && html.includes("@onlinehyphen") && html.includes("Job title"))
  assert.ok(html.includes('data-testid="strap-live-dot"'))
})
