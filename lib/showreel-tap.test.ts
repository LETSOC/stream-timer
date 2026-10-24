import assert from "node:assert/strict"
import test from "node:test"
import { pcmChunkB64 } from "./showreel-tap"

test("page tap encodes float stereo as s16le", () => {
  const b = Buffer.from(pcmChunkB64(new Float32Array([0.5, -1]), new Float32Array([0, 1])), "base64")
  assert.deepEqual([b.readInt16LE(0), b.readInt16LE(2), b.readInt16LE(4), b.readInt16LE(6)], [16384, 0, -32767, 32767])
})
