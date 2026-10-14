import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, test } from "node:test"

import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import { DEFAULT_STAGE } from "@/lib/stage"
import { applyTransport, deckScreen, deckState, effectiveNow, eventTarget, isRisky, parseAction, type TransportState } from "@/lib/transport"
import { readServerState, writeServerEvent } from "@/lib/event-server"
import { runServerTransport } from "@/lib/transport-server"
import { onSaved } from "@/lib/event-bus"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transport-test-"))
process.env.STREAM_DATA_DIR = dir
beforeEach(() => {
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name))
})

const NOW = Date.parse("2026-10-14T09:00:00Z")
const base = (patch: Partial<TransportState> = {}): TransportState => ({ event: { ...DEFAULT_EVENT } as EventConfig, testUntil: null, pausedAt: null, stage: { ...DEFAULT_STAGE }, ...patch })
const ok = (r: ReturnType<typeof applyTransport>) => {
  assert.equal(r.ok, true, r.ok ? "" : r.error)
  return (r as { next: TransportState }).next
}

test("jump / go live set the test clock like the desk did", () => {
  assert.equal(ok(applyTransport(base(), { type: "jump", seconds: 600 }, NOW)).testUntil, NOW + 600_000)
  const live = ok(applyTransport(base({ pausedAt: NOW - 5 }), { type: "goLive" }, NOW))
  assert.deepEqual([live.testUntil, live.pausedAt], [NOW - 1000, null])
})

test("pause freezes the shown time, resume carries on from it", () => {
  const jumped = ok(applyTransport(base(), { type: "jump", seconds: 600 }, NOW))
  const paused = ok(applyTransport(jumped, { type: "pause" }, NOW + 60_000))
  const target = eventTarget(paused.event).getTime()
  // 9 minutes left when paused
  assert.equal(target - paused.pausedAt!, 540_000)
  const resumed = ok(applyTransport(paused, { type: "resume" }, NOW + 600_000))
  assert.equal(resumed.pausedAt, null)
  assert.equal(target - effectiveNow(resumed, NOW + 600_000), 540_000)
  // Pausing twice is a no-op
  assert.equal(ok(applyTransport(paused, { type: "pause" }, NOW + 999_000)).pausedAt, paused.pausedAt)
})

test("reset clears the clock; restore puts the festival date back", () => {
  const changed = base({ event: { ...DEFAULT_EVENT, date: "2026-10-20", time: "10:00", name: "Rehearsal" } as EventConfig, testUntil: NOW, pausedAt: NOW })
  assert.deepEqual([ok(applyTransport(changed, { type: "reset" }, NOW)).testUntil, ok(applyTransport(changed, { type: "reset" }, NOW)).pausedAt], [null, null])
  const restored = ok(applyTransport(changed, { type: "restore" }, NOW))
  assert.deepEqual([restored.event.date, restored.event.time, restored.event.name, restored.testUntil], [DEFAULT_EVENT.date, DEFAULT_EVENT.time, "Rehearsal", null])
})

test("screens are mutually exclusive; same overlay keeps its start time", () => {
  const brk = ok(applyTransport(base(), { type: "screen", screen: "break" }, NOW))
  assert.deepEqual([brk.stage.overlay, brk.stage.overlayAt, brk.stage.forceEnd], ["break", NOW, false])
  assert.equal(ok(applyTransport(brk, { type: "screen", screen: "break" }, NOW + 5000)).stage.overlayAt, NOW)
  const end = ok(applyTransport(brk, { type: "screen", screen: "end" }, NOW))
  assert.deepEqual([end.stage.overlay, end.stage.overlayAt, end.stage.forceEnd, end.stage.holdCountdown], ["none", null, true, false])
  const cd = ok(applyTransport(end, { type: "screen", screen: "countdown" }, NOW))
  assert.deepEqual([cd.stage.forceEnd, cd.stage.holdCountdown], [false, true])
})

test("Live mode locks rehearsal-only actions but not go live / screens / mode", () => {
  const live = ok(applyTransport(base(), { type: "mode", live: true }, NOW))
  assert.equal(live.stage.deskLive, true)
  for (const action of [{ type: "jump", seconds: 15 }, { type: "pause" }, { type: "resume" }, { type: "reset" }, { type: "restore" }] as const) {
    assert.equal(applyTransport(live, action, NOW).ok, false, action.type)
  }
  assert.equal(applyTransport(live, { type: "goLive" }, NOW).ok, true)
  assert.equal(applyTransport(live, { type: "screen", screen: "hold" }, NOW).ok, true)
  assert.equal(ok(applyTransport(live, { type: "mode", live: false }, NOW)).stage.deskLive, false)
})

test("parseAction accepts only known shapes; risky actions flagged", () => {
  assert.deepEqual(parseAction({ type: "jump", seconds: 600 }), { type: "jump", seconds: 600 })
  assert.equal(parseAction({ type: "jump", seconds: 7 }), null)
  assert.equal(parseAction({ type: "screen", screen: "evil" }), null)
  assert.equal(parseAction({ type: "mode", live: "yes" }), null)
  assert.equal(parseAction({ type: "__proto__" }), null)
  assert.equal(parseAction(null), null)
  assert.deepEqual(parseAction({ type: "pause", extra: 1 }), { type: "pause" })
  assert.equal(isRisky({ type: "goLive" }) && isRisky({ type: "reset" }) && isRisky({ type: "restore" }) && isRisky({ type: "screen", screen: "end" }), true)
  assert.equal(isRisky({ type: "pause" }) || isRisky({ type: "screen", screen: "break" }) || isRisky({ type: "jump", seconds: 15 }), false)
})

test("deck state is compact and deckScreen matches /stream precedence", () => {
  const s = deckState({ ...base({ stage: { ...DEFAULT_STAGE, speakers: [{ image: "data:image/png;base64,AAAA", name: "x", description: "" }] } }), rev: 3, testSetAt: null }, NOW)
  assert.equal(JSON.stringify(s).includes("data:image"), false)
  assert.equal(deckScreen(s, NOW), "countdown")
  assert.equal(deckScreen({ ...s, forceEnd: true }, NOW), "end")
  assert.equal(deckScreen({ ...s, forceEnd: true, overlay: "hold" }, NOW), "hold")
  assert.equal(deckScreen(s, Date.parse("2026-11-04T18:00:00Z")), "end")
})

test("server transport: same write path, rev conflict, bus fires on save", () => {
  writeServerEvent(DEFAULT_EVENT)
  const revs: number[] = []
  const off = onSaved((rev) => revs.push(rev))
  const first = runServerTransport({ type: "screen", screen: "break" }, 1, NOW)
  assert.equal(first.ok, true)
  assert.equal(readServerState().stage.overlay, "break")
  assert.equal(first.state.rev, 2)
  const stale = runServerTransport({ type: "screen", screen: "hold" }, 1, NOW)
  assert.equal(stale.ok, false)
  assert.equal(!stale.ok && stale.status, 409)
  assert.equal(stale.state.overlay, "break")
  assert.equal(readServerState().stage.overlay, "break")
  runServerTransport({ type: "mode", live: true }, 2, NOW)
  const locked = runServerTransport({ type: "reset" }, 3, NOW)
  assert.equal(!locked.ok && locked.status, 423)
  off()
  assert.deepEqual(revs, [2, 3])
  assert.ok(fs.existsSync(path.join(dir, "event.json.bak")))
})
