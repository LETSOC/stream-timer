import { stageScreen } from "@/lib/stage"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, test } from "node:test"

import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import { DEFAULT_STAGE } from "@/lib/stage"
import { addMinutes, applyTransport, endCardAt, endsLabel, formatOffset, endSoonAt, formatEndWhen, deckScreen, deckState, effectiveNow, endInstant, eventTarget, isRisky, parseAction, type TransportState } from "@/lib/transport"
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

test("program: cards sit on top of it, countdown/end switch it off; precedence", () => {
  const prog = ok(applyTransport(base(), { type: "screen", screen: "program" }, NOW))
  assert.deepEqual([prog.stage.program, prog.stage.overlay, prog.stage.forceEnd], [true, "none", false])
  const brk = ok(applyTransport(prog, { type: "screen", screen: "break" }, NOW))
  assert.deepEqual([brk.stage.program, brk.stage.overlay], [true, "break"])
  const s = (st: TransportState) => deckScreen(deckState({ ...st, rev: 1, testSetAt: null }, NOW), NOW)
  assert.equal(s(brk), "break")
  assert.equal(s(ok(applyTransport(brk, { type: "screen", screen: "program" }, NOW))), "program")
  // a forced end card beats program (end card override); a past Event › End time alone does not
  assert.equal(s({ ...prog, stage: { ...prog.stage, forceEnd: true } }), "end")
  assert.equal(ok(applyTransport(prog, { type: "screen", screen: "end" }, NOW)).stage.program, false)
  assert.equal(ok(applyTransport(prog, { type: "screen", screen: "countdown" }, NOW)).stage.program, false)
  assert.deepEqual(parseAction({ type: "screen", screen: "program" }), { type: "screen", screen: "program" })
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
  assert.equal(isRisky({ type: "goLive" }) && isRisky({ type: "reset" }) && isRisky({ type: "restore" }) && isRisky({ type: "screen", screen: "end" }) && isRisky({ type: "screen", screen: "program" }), true)
  for (const screen of ["countdown", "break", "hold", "welcome"] as const) assert.equal(isRisky({ type: "screen", screen }), true, screen)
  assert.equal(isRisky({ type: "pause" }) || isRisky({ type: "jump", seconds: 15 }) || isRisky({ type: "setEnd", endTime: "20:00", endOffsetMin: -2 }), false)
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

test("extendEnd: +5/+10 on Event end time, or on the end card override when set; Live allowed", () => {
  const ok = (r: ReturnType<typeof applyTransport>) => (assert.ok(r.ok), r.ok ? r.next : base())
  const e = ok(applyTransport(base({ event: { ...DEFAULT_EVENT, endTime: "16:15" } as EventConfig, stage: { ...DEFAULT_STAGE, deskLive: true } }), { type: "extendEnd", minutes: 10 }, NOW))
  assert.equal(e.event.endTime, "16:25")
  assert.equal(e.stage.endOffsetMin, 0)
  // extendEnd moves the planned end; an adjustment rides on top unchanged.
  const o = ok(applyTransport(base({ event: { ...DEFAULT_EVENT, endTime: "16:15" } as EventConfig, stage: { ...DEFAULT_STAGE, endOffsetMin: -2 } }), { type: "extendEnd", minutes: 5 }, NOW))
  assert.equal(o.event.endTime, "16:20")
  assert.equal(o.stage.endOffsetMin, -2)
  // forceEnd is the operator's choice and stays.
  const f = ok(applyTransport(base({ stage: { ...DEFAULT_STAGE, forceEnd: true } }), { type: "extendEnd", minutes: 5 }, NOW))
  assert.equal(f.stage.forceEnd, true)
  const u = ok(applyTransport(o, { type: "setEnd", endTime: "16:15", endOffsetMin: 0 }, NOW))
  assert.equal(u.stage.endOffsetMin, 0)
  assert.equal(u.event.endTime, "16:15")
  assert.deepEqual(parseAction({ type: "extendEnd", minutes: 5 }), { type: "extendEnd", minutes: 5 })
  assert.equal(parseAction({ type: "extendEnd", minutes: 7 }), null)
  assert.equal(parseAction({ type: "setEnd", endTime: "25:00", endOffsetMin: 0 }), null)
  assert.equal(isRisky({ type: "extendEnd", minutes: 5 }), false)
})

test("End in N min / setEnd clear a Countdown hold; Show end forces end and clears hold", () => {
  const held = { ...DEFAULT_STAGE, holdCountdown: true }
  assert.equal(ok(applyTransport(base({ stage: held }), { type: "extendEnd", minutes: 5 }, NOW)).stage.holdCountdown, false)
  assert.equal(ok(applyTransport(base({ stage: held }), { type: "setEnd", endTime: "16:15", endOffsetMin: 0 }, NOW)).stage.holdCountdown, false)
  const e = ok(applyTransport(base({ stage: held }), { type: "screen", screen: "end" }, NOW)).stage
  assert.equal(e.forceEnd, true); assert.equal(e.holdCountdown, false)
  const c = ok(applyTransport(base(), { type: "screen", screen: "countdown" }, NOW)).stage
  assert.equal(c.holdCountdown, true); assert.equal(c.forceEnd, false)
})

test("end time across midnight lands on the next day; past-end end card comes back to countdown", () => {
  assert.equal(addMinutes("23:55", 10), "00:05")
  const late = endInstant("2026-10-14", "22:00", "00:05", "Europe/London")
  assert.equal(late.toISOString(), "2026-10-14T23:05:00.000Z")
  assert.equal(endInstant("2026-10-14", "10:00", "16:15", "Europe/London").toISOString(), "2026-10-14T15:15:00.000Z")
  const s = deckState({ ...base({ event: { ...DEFAULT_EVENT, date: "2026-10-14", time: "08:00", endTime: "09:55", timeZone: "Europe/London" } as EventConfig }), rev: 1, testSetAt: null }, NOW)
  assert.equal(deckScreen(s, NOW), "end") // 10:00 London > 09:55
  const ext = applyTransport(base({ event: { ...DEFAULT_EVENT, date: "2026-10-14", time: "08:00", endTime: "09:55", timeZone: "Europe/London" } as EventConfig }), { type: "extendEnd", minutes: 10 }, NOW)
  assert.ok(ext.ok)
  if (ext.ok) assert.equal(deckScreen(deckState({ ...ext.next, rev: 2, testSetAt: null }, NOW), NOW), "countdown")
  const forced = applyTransport(base({ event: { ...DEFAULT_EVENT, date: "2026-10-14", time: "08:00", endTime: "09:55", timeZone: "Europe/London" } as EventConfig, stage: { ...DEFAULT_STAGE, forceEnd: true } }), { type: "extendEnd", minutes: 10 }, NOW)
  if (forced.ok) assert.equal(deckScreen(deckState({ ...forced.next, rev: 2, testSetAt: null }, NOW), NOW), "end")
})

test("extendEnd −5/−10: shortens, rolls back across midnight, refuses before start/now", () => {
  const ev = (time: string, endTime: string) => ({ ...DEFAULT_EVENT, date: "2026-10-14", time, endTime, timeZone: "Europe/London" }) as EventConfig
  // NOW = 10:00 London. Start 08:00, end 16:15 → 16:05
  const a = applyTransport(base({ event: ev("08:00", "16:15") }), { type: "extendEnd", minutes: -10 }, NOW)
  assert.ok(a.ok && a.next.event.endTime === "16:05")
  // Late show: start 22:00, end 00:05 (next day) → 23:55 same day
  const b = applyTransport(base({ event: ev("22:00", "00:05") }), { type: "extendEnd", minutes: -10 }, NOW)
  assert.ok(b.ok && b.next.event.endTime === "23:55")
  // Would end before the start
  const c = applyTransport(base({ event: ev("22:00", "22:05") }), { type: "extendEnd", minutes: -10 }, NOW)
  assert.ok(!c.ok && /before the start/.test(c.error))
  // Would end in the past (10:03 − 5 = 09:58 < 10:00)
  const d = applyTransport(base({ event: ev("08:00", "10:03") }), { type: "extendEnd", minutes: -5 }, NOW)
  assert.ok(!d.ok && /already past/.test(d.error))
  assert.deepEqual(parseAction({ type: "extendEnd", minutes: -10 }), { type: "extendEnd", minutes: -10 })
  assert.equal(parseAction({ type: "extendEnd", minutes: -7 }), null)
})

test("adjusted end: due offset cuts over Program; Program/Countdown tap holds; plain planned end never cuts Program", () => {
  const base = { overlay: "none" as const, forceEnd: false, holdCountdown: false, program: true }
  assert.equal(stageScreen({ ...base, endOffsetMin: -2 }, true), "end")
  assert.equal(stageScreen({ ...base, endOffsetMin: 10 }, false), "program")
  assert.equal(stageScreen({ ...base, endOffsetMin: 0 }, true), "program")
  assert.equal(stageScreen({ ...base, endOffsetMin: -2, holdCountdown: true }, true), "program")
  assert.equal(stageScreen({ ...base, overlay: "hold", endOffsetMin: -2 }, true), "hold")
  assert.equal(stageScreen({ ...base, program: false, endOffsetMin: 0 }, true), "end")
})

test("endSoonAt follows the test clock in the event zone", () => {
  const event = { date: "2026-10-15", time: "19:00", timeZone: "Europe/London" }
  const target = endInstant(event.date, event.time, event.time, event.timeZone).getTime()
  // test clock: 10 min before start
  assert.equal(endSoonAt({ event, testUntil: target + 600_000, pausedAt: null } as never, target, 2), "18:52")
  assert.equal(endSoonAt({ event, testUntil: null, pausedAt: target } as never, 0, 5), "19:05")
})

test("formatEndWhen: date + time in the event zone, next day when the end is before the start", () => {
  assert.equal(formatEndWhen("2026-11-04", "09:30", "09:32", "Europe/London"), "4 Nov 09:32")
  assert.equal(formatEndWhen("2026-11-04", "23:30", "00:15", "Europe/London"), "5 Nov 00:15 · next day")
})

const EV = { ...DEFAULT_EVENT, date: "2026-11-04", time: "09:30", endTime: "16:15", timeZone: "Europe/London" } as EventConfig
const PLANNED = Date.parse("2026-11-04T16:15:00Z")

test("end offset: effective end = planned end on the event date + offset; label", () => {
  assert.equal(endCardAt(EV.date, EV.time, EV.endTime, EV.timeZone, -2), PLANNED - 120_000)
  assert.equal(endCardAt(EV.date, EV.time, EV.endTime, EV.timeZone, 10), PLANNED + 600_000)
  assert.equal(endsLabel(EV.date, EV.time, EV.endTime, EV.timeZone, -2), "Ends 16:13 (−2m)")
  assert.equal(endsLabel(EV.date, EV.time, EV.endTime, EV.timeZone, 0), "Ends 16:15")
  assert.equal(formatOffset(10), "+10m")
  const s = deckState(base({ event: EV, stage: { ...DEFAULT_STAGE, endOffsetMin: -2 } }), NOW)
  assert.equal(deckScreen({ ...s, program: true }, PLANNED - 119_000), "end")
  assert.equal(deckScreen({ ...s, program: true }, PLANNED - 121_000), "program")
})

test("endOffset steps, clear, refuse before the doors/past, two taps", () => {
  const st = base({ event: EV })
  const a = applyTransport(st, { type: "endOffset", minutes: -1 }, NOW)
  assert.ok(a.ok)
  if (!a.ok) return
  assert.equal(a.next.stage.endOffsetMin, -1)
  const b = applyTransport(a.next, { type: "endOffset", minutes: 5 }, NOW)
  assert.ok(b.ok && b.next.stage.endOffsetMin === 4)
  const c = applyTransport(b.ok ? b.next : st, { type: "endOffset", clear: true }, NOW)
  assert.ok(c.ok && c.next.stage.endOffsetMin === 0)
  // Before the doors: −7h would end at 09:15 < doors 09:30.
  const far = base({ event: EV, stage: { ...DEFAULT_STAGE, endOffsetMin: -415 } })
  assert.equal(applyTransport(far, { type: "endOffset", minutes: -5 }, NOW).ok, false)
  // Already past (shown clock 16:12): −5 → 16:10 refused.
  const late = base({ event: EV, pausedAt: PLANNED - 3 * 60_000 })
  assert.equal(applyTransport(late, { type: "endOffset", minutes: -5 }, NOW).ok, false)
  assert.ok(applyTransport(late, { type: "endOffset", minutes: -1 }, NOW).ok)
  assert.equal(isRisky({ type: "endOffset", minutes: 1 }), true)
  assert.deepEqual(parseAction({ type: "endOffset", minutes: -5 }), { type: "endOffset", minutes: -5 })
  assert.deepEqual(parseAction({ type: "endOffset", clear: true }), { type: "endOffset", clear: true })
  assert.equal(parseAction({ type: "endOffset", minutes: 3 }), null)
  assert.equal(parseAction({ type: "setEnd", endTime: "16:15", endOffsetMin: 1.5 }), null)
})

test("reset/restore after a test clock clear the offset; a real offset survives reset", () => {
  const t = base({ event: EV, testUntil: NOW + 60_000, stage: { ...DEFAULT_STAGE, endOffsetMin: -2 } })
  for (const type of ["reset", "restore"] as const) {
    const r = applyTransport(t, { type }, NOW)
    assert.ok(r.ok && r.next.stage.endOffsetMin === 0, type)
  }
  const real = applyTransport(base({ event: EV, stage: { ...DEFAULT_STAGE, endOffsetMin: 10 } }), { type: "reset" }, NOW)
  assert.ok(real.ok && real.next.stage.endOffsetMin === 10)
})
