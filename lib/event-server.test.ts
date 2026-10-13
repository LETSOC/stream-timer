import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, test } from "node:test"

import { DEFAULT_EVENT } from "@/lib/event"
import { publicState, readServerState, RevConflict, validClockValue, writeServerEvent } from "@/lib/event-server"
import { TEST_CLOCK_TTL_MS } from "@/lib/stage"

// event-server reads STREAM_DATA_DIR on every call, so setting it here is enough.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-server-test-"))
process.env.STREAM_DATA_DIR = dir
const file = path.join(dir, "event.json")

beforeEach(() => {
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name))
})

test("rev increments and a stale rev is rejected (O)", () => {
  const first = writeServerEvent(DEFAULT_EVENT)
  assert.equal(first?.rev, 1)
  const second = writeServerEvent({ ...DEFAULT_EVENT, name: "Two" }, undefined, undefined, undefined, 1)
  assert.equal(second?.rev, 2)
  assert.throws(() => writeServerEvent({ ...DEFAULT_EVENT, name: "Three" }, undefined, undefined, undefined, 1), RevConflict)
  // No rev (scripts, old clients) still writes.
  assert.equal(writeServerEvent({ ...DEFAULT_EVENT, name: "Three" })?.rev, 3)
  // Identical content: no write, no conflict, rev unchanged.
  assert.equal(writeServerEvent({ ...DEFAULT_EVENT, name: "Three" }, undefined, undefined, undefined, 1)?.rev, 3)
})

test("partial stage PUT merges with saved stage (B)", () => {
  writeServerEvent(DEFAULT_EVENT, undefined, undefined, { checker: 10, endTitle: "Bye" })
  writeServerEvent(DEFAULT_EVENT, undefined, undefined, { showMeta: false })
  const { stage } = readServerState()
  assert.equal(stage.checker, 10)
  assert.equal(stage.endTitle, "Bye")
  assert.equal(stage.showMeta, false)
})

test("corrupt event.json falls back to event.json.bak (F)", () => {
  writeServerEvent({ ...DEFAULT_EVENT, name: "Good one" })
  writeServerEvent({ ...DEFAULT_EVENT, name: "Second" })
  fs.writeFileSync(file, "{ broken")
  const state = readServerState()
  assert.equal(state.recovered, "backup")
  assert.equal(state.event.name, "Good one")
  // Saving while recovered must not overwrite the good backup with the broken file.
  writeServerEvent({ ...DEFAULT_EVENT, name: "Fixed" })
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).event.name, "Good one")
  assert.equal(readServerState().recovered, undefined)
})

test("both files bad -> defaults, flagged", () => {
  fs.writeFileSync(file, "x")
  fs.writeFileSync(`${file}.bak`, "y")
  const state = readServerState()
  assert.equal(state.recovered, "defaults")
  assert.equal(state.event.name, DEFAULT_EVENT.name)
})

test("testSetAt tracks the test clock and /stream drops it after 2h (A)", () => {
  const t0 = Date.now()
  writeServerEvent(DEFAULT_EVENT, t0 + 60_000, null, undefined, undefined, t0)
  assert.equal(readServerState().testSetAt, t0)
  // Same clock re-saved later: setAt unchanged.
  writeServerEvent(DEFAULT_EVENT, t0 + 60_000, null, undefined, undefined, t0 + 5000)
  assert.equal(readServerState().testSetAt, t0)
  const state = readServerState()
  assert.equal(publicState(state, t0 + 1000).testUntil, t0 + 60_000)
  assert.equal(publicState(state, t0 + TEST_CLOCK_TTL_MS + 1000).testUntil, null)
  writeServerEvent(DEFAULT_EVENT, null, null)
  assert.equal(readServerState().testSetAt, null)
})

test("clock range (Q)", () => {
  const now = Date.now()
  assert.equal(validClockValue(now, now), true)
  assert.equal(validClockValue(0, now), false)
  assert.equal(validClockValue(now + 1000 * 24 * 3600_000, now), false)
})

test("stage without speakers keeps the published speakers (draft not sent)", () => {
  const speakers = [{ image: "/s.png", name: "Sam", description: "" }]
  writeServerEvent(DEFAULT_EVENT, undefined, undefined, { speakers })
  writeServerEvent(DEFAULT_EVENT, undefined, undefined, { checker: 8 })
  assert.deepEqual(readServerState().stage.speakers, speakers)
})
