import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { deskCoverNext, deskCoverReady } from "./scene-handoff"

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8")

test("desk card → scene: the desk card covers the incoming scene", () => {
  for (const from of ["hold", "break", "welcome", "countdown", "end"]) {
    assert.deepEqual(deskCoverNext({ cover: null, from, to: "hold05", fromIsScene: false, toIsScene: true }), { from, scene: "hold05" })
  }
  // Program → scene uses the program cover; desk card → desk card is a plain cut.
  assert.equal(deskCoverNext({ cover: null, from: "program", to: "hold05", fromIsScene: false, toIsScene: true }), null)
  assert.equal(deskCoverNext({ cover: null, from: "hold", to: "countdown", fromIsScene: false, toIsScene: false }), null)
})

test("scene → scene while covered keeps the desk card and waits on the newest scene; plain scene cuts don't cover", () => {
  assert.deepEqual(deskCoverNext({ cover: { from: "hold", scene: "hold05" }, from: "hold05", to: "showreel", fromIsScene: true, toIsScene: true }), { from: "hold", scene: "showreel" })
  assert.equal(deskCoverNext({ cover: null, from: "hold05", to: "showreel", fromIsScene: true, toIsScene: true }), null)
  // Leaving the scene for a desk card or program drops the cover.
  assert.equal(deskCoverNext({ cover: { from: "hold", scene: "hold05" }, from: "hold05", to: "program", fromIsScene: true, toIsScene: false }), null)
})

test("only the awaited scene's first frame drops the desk cover", () => {
  assert.equal(deskCoverReady({ from: "hold", scene: "hold05" }, "hold05"), null)
  assert.deepEqual(deskCoverReady({ from: "hold", scene: "showreel" }, "hold05"), { from: "hold", scene: "showreel" })
  assert.equal(deskCoverReady(null, "hold05"), null)
})

test("wiring: the desk card stays in its own slot (not remounted) and is lifted over the scene", () => {
  const sv = read("components/stream-view.tsx")
  assert.match(sv, /setDeskCover\(\(c\) => deskCoverReady\(c, id\)\)/)
  assert.match(sv, /setTimeout\(\(\) => setDeskCover\(null\), HANDOFF_MAX_MS\)/)
  assert.match(sv, /data-testid="desk-card-slot"/)
  assert.match(sv, /onReady=\{onSceneReady\}/)
  // program ⇄ scene handoff still there
  assert.match(sv, /coverOut=\{programCover !== null && isAir\}/)
})
