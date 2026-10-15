import assert from "node:assert/strict"
import test from "node:test"
import { stallBackoffMs } from "./use-resume.ts"

test("stall reload backoff: 3s, 6s, 12s, 24s, then 30s cap", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(stallBackoffMs), [3000, 6000, 12000, 24000, 30000, 30000])
})
