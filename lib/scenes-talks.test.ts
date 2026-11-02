import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_SCENES, MAIN_SCENE_IDS, SCENE_IDS, TALK_SCENE_IDS, isScene, isTalkScene, parseScene, parseScenes } from "@/lib/visuals-assets"
import { CARD_OVERLAYS, parseStage } from "@/lib/stage"
import { deskCoverNext } from "@/lib/scene-handoff"

test("Scenes - Talks: four cards talk01–04, default Left, every classic option present", () => {
  assert.deepEqual([...TALK_SCENE_IDS], ["talk01", "talk02", "talk03", "talk04"])
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
