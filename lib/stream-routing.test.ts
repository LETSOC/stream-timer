import assert from "node:assert/strict"
import { test } from "node:test"
import { parseStage } from "@/lib/stage"
import { parseAction } from "@/lib/transport"
import { dbToGain, nextIndex } from "@/components/stream-bed"

test("stream audio routing defaults: program on, bed off", () => {
  const s = parseStage({})
  assert.equal(s.streamProgramAudio, true); assert.equal(s.streamBedAudio, false)
  const t = parseStage({ streamProgramAudio: false, streamBedAudio: true })
  assert.equal(t.streamProgramAudio, false); assert.equal(t.streamBedAudio, true)
})

test("streamAudio transport action parses booleans only", () => {
  assert.deepEqual(parseAction({ type: "streamAudio", bed: true }), { type: "streamAudio", bed: true })
  assert.deepEqual(parseAction({ type: "streamAudio", program: false, bed: "x" }), { type: "streamAudio", program: false })
  assert.equal(parseAction({ type: "streamAudio" }), null)
})

test("in-page bed: playlist order and volume", () => {
  assert.equal(nextIndex(0, 3, false), 1); assert.equal(nextIndex(2, 3, false), 0)
  for (let i = 0; i < 20; i++) assert.notEqual(nextIndex(1, 3, true), 1)
  assert.equal(nextIndex(0, 1, true), 0)
  assert.equal(dbToGain(0), 1); assert.ok(Math.abs(dbToGain(-20) - 0.1) < 1e-9); assert.equal(dbToGain(6), 1)
})
