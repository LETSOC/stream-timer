import { test } from "node:test"
import assert from "node:assert/strict"
import { keepLoaded, programDisplay } from "@/lib/program-display"

const base = { now: 10_000, activeSince: 10_000, readyAt: 1000, ready: true, notReadySince: null, lastFrameAt: null }

test("program layer stays under the previous screen until the first frame", () => {
  assert.equal(programDisplay({ ...base, activeSince: null }), "under")
  assert.equal(programDisplay(base), "under")
  assert.equal(programDisplay({ ...base, now: 14_000 }), "under")
  assert.equal(programDisplay({ ...base, now: 10_400, lastFrameAt: 10_350 }), "video")
  assert.equal(programDisplay({ ...base, now: 15_500 }), "standby")
})

test("stalls hold the last frame, then standby", () => {
  assert.equal(programDisplay({ ...base, now: 20_000, lastFrameAt: 17_000 }), "video")
  assert.equal(programDisplay({ ...base, now: 20_000, lastFrameAt: 15_000 }), "standby")
})

test("not ready: standby only after the debounce", () => {
  const off = { ...base, ready: false, notReadySince: 9000 }
  assert.equal(programDisplay({ ...off, now: 11_000 }), "under")
  assert.equal(programDisplay({ ...off, now: 13_500 }), "standby")
  assert.equal(programDisplay({ ...base, ready: false, notReadySince: null, now: 13_100 }), "standby")
  assert.equal(keepLoaded(false, 9000, 11_000), true)
  assert.equal(keepLoaded(false, 9000, 12_500), false)
  assert.equal(keepLoaded(true, null, 0), true)
})
