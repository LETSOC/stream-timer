import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { NameStrap } from "@/components/name-strap"
import { VisualsLayer } from "@/components/visuals-layer"
import { DEFAULT_EVENT } from "@/lib/event"
import { DEFAULT_STAGE, parseStage } from "@/lib/stage"
import { CORNERS, DEFAULT_STRAP_DESIGNS, DEFAULT_TEXT_SCALE, parseStrapDesigns, parseTextScale, STYLE_ACCENTS, toggleStrapAccent, type StrapDesign } from "@/lib/visuals"
import { DRAFT_KEYS, draftFrom, previewStage, saveBody, toggleDraftAccent } from "@/lib/visuals-builder"

test("corner pickers follow the screen: top left, top right / bottom left, bottom right", () => {
  assert.deepEqual([...CORNERS], ["top-left", "top-right", "bottom-left", "bottom-right"])
})

test("old configs keep their look: defaults 100% and every accent on; old house toggles carry over", () => {
  assert.deepEqual(parseStage({}).strapDesigns, DEFAULT_STRAP_DESIGNS)
  assert.deepEqual(parseStage({}).textScale, DEFAULT_TEXT_SCALE)
  const old = parseStage({ strapAccentCircle: false, strapArrow: true })
  assert.deepEqual(old.strapDesigns.house.off, ["dot"])
  assert.deepEqual(old.strapDesigns.line, DEFAULT_STRAP_DESIGNS.line)
  // Saved designs win over the old fields.
  const saved = parseStage({ strapAccentCircle: false, strapDesigns: { house: { nameSize: 120, subSize: 80, off: [] } } })
  assert.deepEqual(saved.strapDesigns.house, { nameSize: 120, subSize: 80, off: [] })
})

test("designs and text sizes are junk-tolerant and clamped", () => {
  const d = parseStrapDesigns({ house: { nameSize: 999, subSize: "x", off: ["bar", "arrow", "nope"] }, pill: null })
  assert.equal(d.house.nameSize, 200)
  assert.equal(d.house.subSize, 100)
  assert.deepEqual(d.house.off, ["arrow"]) // bar is not a house accent
  assert.deepEqual(d.pill, DEFAULT_STRAP_DESIGNS.pill)
  assert.deepEqual(parseTextScale({ ticker: 10, qa: 150, talk: "130" }), { ...DEFAULT_TEXT_SCALE, ticker: 50, qa: 150, talk: 130 })
})

test("accent toggles: per design, and the house ones keep the old fields in sync", () => {
  const t = toggleStrapAccent(DEFAULT_STRAP_DESIGNS, "line", "bar")
  assert.deepEqual(t.line.off, ["bar"])
  assert.deepEqual(toggleStrapAccent(t, "line", "bar").line.off, [])
  const draft = draftFrom(DEFAULT_STAGE)
  const next = toggleDraftAccent(draft, "house", "arrow")
  assert.equal(next.strapArrow, false)
  assert.equal(next.strapAccentCircle, true)
  for (const k of ["strapDesigns", "textScale"]) assert.ok((DRAFT_KEYS as readonly string[]).includes(k), k)
  const body = saveBody({ event: {}, stage: {}, rev: 1, testUntil: null, pausedAt: null }, { ...next, textScale: { ...next.textScale, qa: 140 } })
  assert.equal(parseStage(body.stage).textScale.qa, 140)
  assert.deepEqual(parseStage(body.stage).strapDesigns.house.off, ["arrow"])
})

const preset = { name: "Alex", title: "Host", handle: "@h", platform: "instagram" as const }
const strap = (style: "house" | "line" | "block" | "pill" | "gradient", design?: StrapDesign) =>
  renderToStaticMarkup(createElement(NameStrap, { preset, visible: true, look: { style, motion: "slide-left", accent: "#d9ff43", text: "#ffffff", design } }))

test("name strap: off accents are not rendered (box shrinks), on ones are", () => {
  for (const style of ["house", "line", "block", "pill", "gradient"] as const) {
    const all = strap(style)
    assert.ok(all.includes('data-platform="instagram"'), `${style} icon on`)
    const none = strap(style, { nameSize: 100, subSize: 100, off: [...STYLE_ACCENTS[style]] })
    assert.ok(!none.includes("data-platform"), `${style} icon off`)
    assert.ok(!/strap-(dot|arrow|bar|live-dot)"/.test(none), `${style} accents off`)
  }
  assert.ok(strap("house").includes("strap-accent-circle") && strap("house").includes("strap-arrow"))
  assert.ok(strap("line", { nameSize: 100, subSize: 100, off: ["bar"] }).includes("strap-no-bar"))
})

test("name strap: default size keeps --px; sizes rescale it from the page value", () => {
  assert.ok(!strap("house").includes("--px:"))
  const big = strap("house", { nameSize: 150, subSize: 80, off: [] })
  assert.ok(big.includes("--px:calc(var(--strap-px0) * 1.5)"))
  assert.ok(big.includes("--strap-sub-px:calc(var(--strap-px0) * 0.8)"))
})

test("layer: pill and ticker text sizes scale their box; the ticker lift follows", () => {
  const stage = previewStage({}, undefined, { ...draftFrom(DEFAULT_STAGE), textScale: { ticker: 150, talk: 100, festival: 100, qa: 120, sponsor: 80 } }, { showAll: true, now: 1_800_000_000_000 })
  const html = renderToStaticMarkup(createElement(VisualsLayer, { stage, event: DEFAULT_EVENT, screen: "program", now: 1_800_000_000_000, eventEndMs: null }))
  assert.ok(/data-testid="vl-qa"[^>]*style="--px:calc\(var\(--vl-px0\) \* 1.2\)"/.test(html))
  assert.ok(/data-testid="vl-sponsor"[^>]*style="--px:calc\(var\(--vl-px0\) \* 0.8\)"/.test(html))
  assert.ok(/data-testid="vl-talk"[^>]*data-text-size="100"/.test(html))
  assert.ok(/data-testid="vl-ticker"[^>]*style="--px:calc\(var\(--vl-px0\) \* 1.5\)"/.test(html))
  // Q&A sits bottom-right on program: lifted by 72 (48 × 1.5) + 16.
  assert.ok(html.includes("bottom:calc(142 * var(--px))"), "lift = 54 safe + 72 + 16")
})
