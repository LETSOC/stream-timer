import assert from "node:assert/strict"
import { test } from "node:test"
import { handoffReady, handoffShow, handoffStart } from "@/lib/scene-handoff"

test("scene handoff: outgoing scene stays until the incoming one is ready", () => {
  let s = handoffStart("standby")
  s = handoffShow(s, "showreel")
  assert.deepEqual(s, { current: "showreel", leaving: "standby" })
  // A late ready from the outgoing scene does not drop the cover.
  assert.equal(handoffReady(s, "standby"), s)
  s = handoffReady(s, "showreel")
  assert.deepEqual(s, { current: "showreel", leaving: null })
})

test("scene handoff: same scene is a no-op; a switch mid-handoff keeps the visible cover", () => {
  const s = handoffStart("standby")
  assert.equal(handoffShow(s, "standby"), s)
  const a = handoffShow(s, "showreel")
  assert.deepEqual(handoffShow(a, "hold05"), { current: "hold05", leaving: "standby" })
  assert.deepEqual(handoffShow(a, "standby"), { current: "standby", leaving: "standby" })
})
