/**
 * Transport actions (desk Transport panel and the phone deck): one pure implementation, so the
 * desk (applies it locally, then saves) and the server (deck WebSocket / POST /api/deck/action)
 * always compute the same next state. Safe to import from client components.
 */
import { wallTimeInZone } from "@/lib/countdown"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import type { FailoverEvent, FailoverSettings, SourceHealth } from "@/lib/program-source"
import { stageScreen, testClockStale, type StageOptions } from "@/lib/stage"

export const JUMPS = [
  { label: "15s", seconds: 15 },
  { label: "10m", seconds: 600 },
  { label: "30m", seconds: 1800 },
  { label: "1h", seconds: 3600 },
] as const

export type Screen = "break" | "hold" | "welcome" | "program" | "end" | "countdown"
export const SCREENS: readonly Screen[] = ["countdown", "break", "hold", "welcome", "program", "end"]

export type TransportAction =
  | { type: "jump"; seconds: number }
  | { type: "goLive" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "reset" }
  | { type: "restore" }
  | { type: "screen"; screen: Screen }
  | { type: "mode"; live: boolean }
  /** Quick action: push the end time later. Extends the end card override if one is set, else Event › End time. */
  | { type: "extendEnd"; minutes: number }
  /** Undo for extendEnd: put both end times back exactly as they were. */
  | { type: "setEnd"; endTime: string; endAt: string }
  /** Program feed input: Main (OBS) or Backup. Doesn't change the screen. */
  | { type: "programSource"; source: "main" | "backup" }

export type ProgramSourcesView = {
  main: SourceHealth
  backup: SourceHealth & { pull: boolean }
  failover: FailoverSettings
  last: FailoverEvent | null
}

export const EXTENDS = [-10, -5, 5, 10] as const
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/** HH:MM + minutes, wrapping past midnight (the end instant rolls to the next day, see endInstant). */
export function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number)
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

/**
 * The end card instant. End times are HH:MM on the event date; an end earlier than the start
 * (e.g. start 22:00, end 00:05) means the next day, so extending across midnight works.
 */
export function endInstant(date: string, start: string, end: string, timeZone: string): Date {
  const at = wallTimeInZone(date, end, timeZone)
  if (!HHMM.test(start) || !HHMM.test(end) || end >= start) return at
  const [y, mo, d] = date.split("-").map(Number)
  const next = new Date(Date.UTC(y, mo - 1, d + 1))
  return wallTimeInZone(next.toISOString().slice(0, 10), end, timeZone)
}

/**
 * Shortening must not put the end before the start or before now (the shown clock, incl. test clock);
 * end times before the start roll to the next day (endInstant), so 00:05 − 10 = 23:55 works.
 */
export function endGuard(state: Pick<TransportState, "event" | "testUntil" | "pausedAt">, to: string, now: number): string | null {
  const end = endInstant(state.event.date, state.event.time, to, state.event.timeZone).getTime()
  const start = eventTarget(state.event).getTime()
  if (!Number.isFinite(end)) return "The end time is not valid."
  if (Number.isFinite(start) && end <= start) return `Can't end at ${to}: that's before the start (${state.event.time}).`
  if (end <= effectiveNow(state, now)) return `Can't end at ${to}: that's already past.`
  return null
}

/** Where extendEnd writes, and the time it lands on. */
export function extendTarget(endTime: string, endAt: string, minutes: number): { field: "endAt" | "endTime"; from: string; to: string } {
  const field = endAt ? "endAt" : "endTime"
  const from = endAt || endTime
  return { field, from, to: addMinutes(from, minutes) }
}

export type TransportState = {
  event: EventConfig
  testUntil: number | null
  pausedAt: number | null
  stage: StageOptions
}

/** Actions that touch /stream in a way that's hard to undo: the deck asks for a second tap. */
export const RISKY: ReadonlySet<TransportAction["type"] | `screen:${Screen}`> = new Set(["goLive", "reset", "restore", "screen:end"])
export function isRisky(action: TransportAction): boolean {
  return RISKY.has(action.type) || (action.type === "screen" && RISKY.has(`screen:${action.screen}`))
}

/** Rehearsal-only actions, locked while the desk is in Live mode. */
const REHEARSAL_ONLY = new Set<TransportAction["type"]>(["jump", "pause", "resume", "reset", "restore"])
export function lockedInLive(action: TransportAction): boolean {
  return REHEARSAL_ONLY.has(action.type)
}

export function eventTarget(event: Pick<EventConfig, "date" | "time" | "timeZone">): Date {
  return wallTimeInZone(event.date, event.time, event.timeZone)
}

/** The time /stream counts against: the paused moment, else now shifted by the test clock. */
export function effectiveNow(state: Pick<TransportState, "event" | "testUntil" | "pausedAt">, now: number): number {
  if (state.pausedAt !== null) return state.pausedAt
  const target = eventTarget(state.event).getTime()
  if (state.testUntil !== null && Number.isFinite(target)) return now + (target - state.testUntil)
  return now
}

/** Validate untrusted JSON (WebSocket / POST body) into an action. */
export function parseAction(value: unknown): TransportAction | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  switch (v.type) {
    case "jump":
      return JUMPS.some((j) => j.seconds === v.seconds) ? { type: "jump", seconds: v.seconds as number } : null
    case "goLive":
    case "pause":
    case "resume":
    case "reset":
    case "restore":
      return { type: v.type }
    case "screen":
      return SCREENS.includes(v.screen as Screen) ? { type: "screen", screen: v.screen as Screen } : null
    case "mode":
      return typeof v.live === "boolean" ? { type: "mode", live: v.live } : null
    case "extendEnd":
      return EXTENDS.includes(v.minutes as (typeof EXTENDS)[number]) ? { type: "extendEnd", minutes: v.minutes as number } : null
    case "setEnd":
      return typeof v.endTime === "string" && HHMM.test(v.endTime) && typeof v.endAt === "string" && (v.endAt === "" || HHMM.test(v.endAt))
        ? { type: "setEnd", endTime: v.endTime, endAt: v.endAt }
        : null
    case "programSource":
      return v.source === "main" || v.source === "backup" ? { type: "programSource", source: v.source } : null
    default:
      return null
  }
}

export type TransportResult = { ok: true; next: TransportState } | { ok: false; error: string }

export function applyTransport(state: TransportState, action: TransportAction, now: number): TransportResult {
  if (state.stage.deskLive && lockedInLive(action)) return { ok: false, error: "Locked in Live mode. Switch to Rehearsal first." }
  const target = eventTarget(state.event).getTime()
  const valid = Number.isFinite(target)
  const next = (patch: Partial<TransportState>, stage?: Partial<StageOptions>): TransportResult => ({
    ok: true,
    next: { ...state, ...patch, stage: stage ? { ...state.stage, ...stage } : state.stage },
  })
  switch (action.type) {
    case "jump":
      if (!valid) return { ok: false, error: "The event date/time is not valid." }
      return next({ testUntil: now + action.seconds * 1000, pausedAt: null })
    case "goLive":
      if (!valid) return { ok: false, error: "The event date/time is not valid." }
      return next({ testUntil: now - 1000, pausedAt: null })
    case "pause":
      if (state.pausedAt !== null) return next({})
      return next({ pausedAt: effectiveNow(state, now) })
    case "resume": {
      if (state.pausedAt === null) return next({})
      if (!valid) return next({ pausedAt: null })
      return next({ testUntil: target - state.pausedAt + now, pausedAt: null })
    }
    case "reset":
      return next({ testUntil: null, pausedAt: null })
    case "restore":
      return next({ event: { ...state.event, date: DEFAULT_EVENT.date, time: DEFAULT_EVENT.time, timeZone: DEFAULT_EVENT.timeZone }, testUntil: null, pausedAt: null })
    case "screen": {
      const overlay = action.screen === "break" || action.screen === "hold" || action.screen === "welcome" ? action.screen : "none"
      const overlayAt = overlay === "none" ? null : overlay === state.stage.overlay ? state.stage.overlayAt ?? now : now
      // Cards sit on top of the program feed (it stays "on" underneath); countdown/end switch it off.
      const program = action.screen === "program" ? true : overlay !== "none" ? state.stage.program : false
      return next({}, { overlay, overlayAt, program, forceEnd: action.screen === "end", holdCountdown: action.screen === "countdown" })
    }
    case "mode":
      return next({}, { deskLive: action.live })
    case "extendEnd": {
      const from = state.stage.endAt || state.event.endTime
      if (!HHMM.test(from)) return { ok: false, error: "The end time is not valid." }
      const { field, to } = extendTarget(state.event.endTime, state.stage.endAt, action.minutes)
      // The end must move by exactly the minutes (else it wrapped past the start onto another day).
      const at = (t: string) => endInstant(state.event.date, state.event.time, t, state.event.timeZone).getTime()
      if (Math.abs(at(to) - at(from) - action.minutes * 60_000) > 60_000) return { ok: false, error: action.minutes < 0 ? `Can't end at ${to}: that's before the start (${state.event.time}).` : `Can't extend past ${to}: the end would be more than a day after the start.` }
      const guard = endGuard(state, to, now)
      if (guard) return { ok: false, error: guard }
      // forceEnd (operator chose "end") stays; otherwise the new end time decides countdown/LIVE vs end card.
      return field === "endAt" ? next({}, { endAt: to }) : next({ event: { ...state.event, endTime: to } })
    }
    case "programSource":
      return next({}, { programSource: action.source })
    case "setEnd":
      return next({ event: { ...state.event, endTime: action.endTime } }, { endAt: action.endAt })
  }
}

/** Compact view for the deck and the WebSocket bus (no images, speakers or long text). */
export type DeckState = {
  rev: number
  name: string
  date: string
  time: string
  endTime: string
  timeZone: string
  testUntil: number | null
  pausedAt: number | null
  testSetAt: number | null
  testStale: boolean
  deskLive: boolean
  overlay: StageOptions["overlay"]
  program: boolean
  programSource: "main" | "backup"
  /** Live health of both inputs (null = relay not armed). */
  programSources: ProgramSourcesView | null
  /** Last known: is OBS publishing to the relay's /program path? null = not known (relay not armed). */
  programReady: boolean | null
  overlayAt: number | null
  forceEnd: boolean
  holdCountdown: boolean
  endAt: string
  serverNow: number
}

export function deckState(
  state: TransportState & { rev: number; testSetAt: number | null },
  now = Date.now(),
  programReady: boolean | null = null,
  sources: ProgramSourcesView | null = null,
): DeckState {
  return {
    rev: state.rev,
    name: state.event.name,
    date: state.event.date,
    time: state.event.time,
    endTime: state.event.endTime,
    timeZone: state.event.timeZone,
    testUntil: state.testUntil,
    pausedAt: state.pausedAt,
    testSetAt: state.testSetAt,
    testStale: testClockStale(state.testSetAt, now),
    deskLive: state.stage.deskLive,
    overlay: state.stage.overlay,
    program: state.stage.program,
    programSource: state.stage.programSource,
    programSources: sources,
    programReady,
    overlayAt: state.stage.overlayAt,
    forceEnd: state.stage.forceEnd,
    holdCountdown: state.stage.holdCountdown,
    endAt: state.stage.endAt,
    serverNow: now,
  }
}

/** What /stream shows right now for a deck state (same precedence as /stream). */
export function deckScreen(s: DeckState, now: number): Screen {
  const stale = s.testStale
  const clock = { event: { date: s.date, time: s.time, timeZone: s.timeZone } as EventConfig, testUntil: stale ? null : s.testUntil, pausedAt: stale ? null : s.pausedAt }
  const at = effectiveNow(clock, now)
  const end = endInstant(s.date, s.time, s.endAt || s.endTime, s.timeZone).getTime()
  return stageScreen(s, Number.isFinite(end) && end <= at)
}
