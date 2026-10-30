import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { PROGRAM_FADE_TAIL_MS, programCoverNext, programCoverReady, sceneTailNext } from "./scene-handoff"

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8")

test("program → scene: the program picture covers the incoming scene", () => {
  assert.equal(programCoverNext({ cover: null, from: "program", to: "hold05", toIsScene: true, programVideo: true }), "hold05")
  // No picture up (Waiting for OBS / under): nothing to hold, normal cut.
  assert.equal(programCoverNext({ cover: null, from: "program", to: "hold05", toIsScene: true, programVideo: false }), null)
  // Program → a card without the scene handoff (countdown, break…): no cover.
  assert.equal(programCoverNext({ cover: null, from: "program", to: "countdown", toIsScene: false, programVideo: true }), null)
})

test("scene → scene while still covered follows the newest scene; plain scene cuts don't cover", () => {
  assert.equal(programCoverNext({ cover: "hold05", from: "hold05", to: "showreel", toIsScene: true, programVideo: false }), "showreel")
  assert.equal(programCoverNext({ cover: null, from: "hold05", to: "showreel", toIsScene: true, programVideo: true }), null)
})

test("only the covered scene's first frame drops the cover", () => {
  assert.equal(programCoverReady("hold05", "hold05"), null)
  assert.equal(programCoverReady("showreel", "hold05"), "showreel")
  assert.equal(programCoverReady(null, "hold05"), null)
})

test("scene → program keeps the scene under the fade-in", () => {
  assert.equal(sceneTailNext({ from: "standby", to: "program", fromIsScene: true }), "standby")
  assert.equal(sceneTailNext({ from: "countdown", to: "program", fromIsScene: false }), null)
  assert.equal(sceneTailNext({ from: "program", to: "standby", fromIsScene: false }), null)
  assert.ok(PROGRAM_FADE_TAIL_MS >= 300) // the feed's opacity transition is 300ms
})

test("wiring: stream-view passes the cover to the on-air feed, listens to scene readiness, keeps the scene slot", () => {
  const sv = read("components/stream-view.tsx")
  assert.match(sv, /coverOut=\{programCover !== null && isAir\}/)
  assert.match(sv, /onReady=\{onSceneReady\}/)
  assert.match(sv, /setTimeout\(\(\) => setProgramCover\(null\), HANDOFF_MAX_MS\)/)
  assert.match(sv, /shownScreen === "program" \? \(\s*\/\/[^\n]*\n\s*sceneTail !== null/)
  const pf = read("components/program-feed.tsx")
  assert.match(pf, /coverVideo \? "z-\[30\]"/)
  // switch-sync work still there
  assert.match(pf, /onAirJumpDue\(settle, lat\)/)
  assert.match(pf, /cappedDiff\(/)
  assert.match(read("components/scene-handoff.tsx"), /onReady\?\.\(sid\)/)
})
