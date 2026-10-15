import assert from "node:assert/strict"
import test from "node:test"
import { interactiveViewer } from "../components/stream-audio-overlay.tsx"

const desk = { search: "", ua: "Mozilla/5.0 (Macintosh) Safari/605", webdriver: false, framed: false }
test("audio overlay: interactive browsers only; never OBS, capture, previews", () => {
  assert.equal(interactiveViewer(desk), true)
  assert.equal(interactiveViewer({ ...desk, ua: "Mozilla/5.0 Chrome/127 OBS/30.2.0" }), false)
  assert.equal(interactiveViewer({ ...desk, ua: "obsstudio/31" }), false)
  assert.equal(interactiveViewer({ ...desk, webdriver: true }), false) // Browser capture (Playwright)
  assert.equal(interactiveViewer({ ...desk, framed: true }), false) // deck/desk preview iframe
  assert.equal(interactiveViewer({ ...desk, search: "?k=abc" }), false) // the OBS view-key URL
  assert.equal(interactiveViewer({ ...desk, search: "?mute=1" }), false)
  assert.equal(interactiveViewer({ ...desk, search: "?controls=0" }), false)
  assert.equal(interactiveViewer({ ...desk, webdriver: true, search: "?k=abc&controls=1" }), true)
})
