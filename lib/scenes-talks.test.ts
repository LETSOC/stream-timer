import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_SCENES, MAIN_SCENE_IDS, SCENE_IDS, TALK_SCENE_IDS, isScene, isTalkScene, parseScene, parseScenes } from "@/lib/visuals-assets"
import { CARD_OVERLAYS, parseStage } from "@/lib/stage"
import { deskCoverNext } from "@/lib/scene-handoff"

test("Scenes - Talks: eight cards talk01–08, default Left, every classic option present", () => {
  assert.deepEqual([...TALK_SCENE_IDS], ["talk01", "talk02", "talk03", "talk04", "talk05", "talk06", "talk07", "talk08"])
  for (const id of TALK_SCENE_IDS) {
    assert.ok(isScene(id) && isTalkScene(id))
    assert.ok((CARD_OVERLAYS as readonly string[]).includes(id))
    assert.equal(DEFAULT_SCENES[id].align, "left")
    assert.deepEqual(Object.keys(DEFAULT_SCENES[id]).sort(), Object.keys(DEFAULT_SCENES.hold05).sort())
  }
  for (const id of MAIN_SCENE_IDS) { assert.equal(isTalkScene(id), false); assert.equal(DEFAULT_SCENES[id].align, "center") }
  assert.equal(MAIN_SCENE_IDS.length + TALK_SCENE_IDS.length, SCENE_IDS.length)
})

test("align validates: talks take left/right only, classic scenes stay centred", () => {
  assert.equal(parseScene({ align: "right" }, DEFAULT_SCENES.talk02).align, "right")
  assert.equal(parseScene({ align: "center" }, DEFAULT_SCENES.talk02).align, "left")
  assert.equal(parseScene({ align: "<x>" }, DEFAULT_SCENES.talk02).align, "left")
  assert.equal(parseScene({ align: "right" }, DEFAULT_SCENES.hold05).align, "center")
})

test("old saved data (no talks, no align) still loads", () => {
  const old = { hold05: { label: "Coffee", sub: "", dot: "#112233", pill: "P" }, showreel: { video: "/uploads/a.mp4", autoSwitch: true, next: "hold06" } }
  const s = parseScenes(old)
  assert.equal(s.hold05.label, "Coffee")
  assert.equal(s.hold05.align, "center")
  assert.equal(s.showreel.next, "hold06")
  assert.deepEqual(s.talk01, DEFAULT_SCENES.talk01)
  const stage = parseStage({ scenes: old, overlay: "talk03" })
  assert.equal(stage.overlay, "talk03")
  assert.equal(stage.scenes.talk04.align, "left")
})

test("talks card can be a video 'next' target and round-trips", () => {
  const s = parseScenes({ showreel: { next: "talk01" }, talk01: { align: "right", video: "/uploads/v.mp4", next: "talk02" } })
  assert.equal(s.showreel.next, "talk01")
  assert.equal(s.talk01.next, "talk02")
  assert.deepEqual(parseScenes(JSON.parse(JSON.stringify(s))), s)
})

test("desk card → Talks card uses the same seamless handoff cover", () => {
  const cover = deskCoverNext({ cover: null, from: "hold", to: "talk01", fromIsScene: false, toIsScene: isScene("talk01") })
  assert.ok(cover && cover.from === "hold")
})

test("Talks layout CSS: content, pill and QR on the 5% safe line (96/54 of 1920x1080)", async () => {
  const fs = await import("node:fs")
  const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")
  assert.match(css, /--talk-safe-x: calc\(96 \* var\(--vl-px0, var\(--px\)\)\); --talk-safe-y: calc\(54 \*/)
  assert.match(css, /\.scene-align-left \.scene-pill \{ left: var\(--talk-safe-x\)/)
  assert.match(css, /\.scene-align-right \.scene-qr \{ right: auto; left: var\(--talk-safe-x\); bottom: var\(--talk-safe-y\)/)
  assert.doesNotMatch(css, /scene-align-[a-z]+[^}]*160 \*/)
})

test("scene font sizes: defaults 144/26, clamped, old data keeps defaults", async () => {
  const { SCENE_LABEL_PX, SCENE_SUB_PX } = await import("@/lib/visuals-assets")
  for (const id of SCENE_IDS) { assert.equal(DEFAULT_SCENES[id].labelPx, 144); assert.equal(DEFAULT_SCENES[id].subPx, 26) }
  assert.equal(parseScene({}, DEFAULT_SCENES.hold05).labelPx, 144)
  assert.equal(parseScene({ labelPx: 999, subPx: 1 }, DEFAULT_SCENES.talk01).labelPx, SCENE_LABEL_PX.max)
  assert.equal(parseScene({ labelPx: 999, subPx: 1 }, DEFAULT_SCENES.talk01).subPx, SCENE_SUB_PX.min)
  assert.equal(parseScene({ labelPx: "big", subPx: 40.4 }, DEFAULT_SCENES.talk01).labelPx, 144)
  assert.equal(parseScene({ subPx: 40.4 }, DEFAULT_SCENES.talk01).subPx, 40)
})

test("scene label/subline keep manual line breaks, sanitised", async () => {
  const { sceneLines, sceneOneLine } = await import("@/lib/visuals-assets")
  const c = parseScene({ label: "Grace  Hopper\r\non compilers\n\n\nand more", sub: "  one  line  " }, DEFAULT_SCENES.talk02)
  assert.equal(c.label, "Grace Hopper\non compilers") // capped at 4 lines, trailing blanks dropped
  assert.equal(sceneLines("\n\nA\n\nB\n\n"), "A\n\nB")
  assert.equal(c.sub, "one line")
  assert.equal(sceneLines("a\nb\nc\nd\ne\nf"), "a\nb\nc\nd")
  assert.equal(sceneLines("<b>x</b>\ny"), "<b>x</b>\ny") // stays text; React renders it escaped
  assert.equal(parseScene({ label: "\n\n" }, DEFAULT_SCENES.hold05).label, DEFAULT_SCENES.hold05.label)
  assert.equal(sceneOneLine("Grace Hopper\non compilers"), "Grace Hopper on compilers")
  assert.deepEqual(parseScenes(JSON.parse(JSON.stringify({ talk01: c }))).talk01.label, c.label)
})

test("scene subline renders at full opacity (same colour as the label)", async () => {
  const fs = await import("node:fs")
  const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")
  const rule = css.match(/\.scene-sub \{[^}]*\}/)?.[0] ?? ""
  assert.ok(rule && !/opacity|color|filter/.test(rule), rule)
})

test("TALKS 05–08 exist with labels and the same options", () => {
  for (const id of ["talk05", "talk06", "talk07", "talk08"] as const) {
    assert.ok(isTalkScene(id))
    assert.equal(DEFAULT_SCENES[id].pill, `TALKS ${id.slice(4)}`)
    assert.equal(parseScene({ align: "right", labelPx: 90, textWidth: 50, label: "A\nB" }, DEFAULT_SCENES[id]).align, "right")
  }
  const stage = parseStage({ overlay: "talk08" })
  assert.equal(stage.overlay, "talk08")
})

test("imageFront: default off, validated, survives save round-trip", () => {
  for (const id of SCENE_IDS) assert.equal(DEFAULT_SCENES[id].imageFront, false)
  assert.equal(parseScene({ imageFront: true }, DEFAULT_SCENES.talk05).imageFront, true)
  assert.equal(parseScene({ imageFront: "yes" }, DEFAULT_SCENES.talk05).imageFront, false)
  const saved = parseScenes({ talk07: { imageFront: true, image: "/uploads/logo.png", bgMode: "image" } })
  const again = parseScenes(JSON.parse(JSON.stringify(saved)))
  assert.equal(again.talk07.imageFront, true)
  assert.equal(parseStage({ scenes: saved }).scenes.talk07.imageFront, true)
  assert.equal(parseScenes({ hold05: { label: "x" } }).hold05.imageFront, false)
})

test("imageFront render: image layer above everything, QR on top of it; off = classic order", async () => {
  const React = await import("react")
  const { renderToStaticMarkup } = await import("react-dom/server")
  const { SceneCardView } = await import("@/components/visual-assets")
  const qr = { url: "https://example.com" } as never
  const base = { ...DEFAULT_SCENES.talk05, bgMode: "image" as const, image: "/uploads/a.png", video: "/uploads/v.mp4", videoFront: true }
  const on = renderToStaticMarkup(React.createElement(SceneCardView, { id: "talk05", card: { ...base, imageFront: true }, qr, now: 0 }))
  const iTop = on.indexOf("scene-image-top-talk05"), iVid = on.indexOf("scene-video-talk05"), iQr = on.indexOf("scene-qr")
  assert.ok(iVid > 0 && iTop > iVid && iQr > iTop, "front video < image < QR")
  assert.doesNotMatch(on, /background-image:url/)
  const off = renderToStaticMarkup(React.createElement(SceneCardView, { id: "talk05", card: { ...base, videoFront: false }, qr, now: 0 }))
  assert.doesNotMatch(off, /scene-image-top/)
  const hero = renderToStaticMarkup(React.createElement(SceneCardView, { id: "talk05", card: { ...base, video: "", bgMode: "hero", imageFront: true }, qr, now: 0 }))
  assert.match(hero, /scene-hero-top/)
})
