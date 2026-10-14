/**
 * Transport actions (desk Transport panel and the phone deck): one pure implementation, so the
 * desk (applies it locally, then saves) and the server (deck WebSocket / POST /api/deck/action)
 * always compute the same next state. Safe to import from client components.
 */
import { wallTimeInZone } from "@/lib/countdown"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import { stageScreen, testClockStale, type StageOptions } from "@/lib/stage"

export const JUMPS = [
  { label: "15s", seconds: 15 },
  { label: "10m", seconds: 600 },
  { label: "30m", seconds: 1800 },
  { label: "1h", seconds: 3600 },
] as const

export type Screen = "break" | "hold" | "welcome" | "end" | "countdown"
export const SCREENS: readonly Screen[] = ["countdown", "break", "hold", "welcome", "end"]

export type TransportAction =
  | { type: "jump"; seconds: number }
  | { type: "goLive" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "reset" }
  | { type: "restore" }
  | { type: "screen"; screen: Screen }
  | { type: "mode"; live: boolean }

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
      return next({}, { overlay, overlayAt, forceEnd: action.screen === "end", holdCountdown: action.screen === "countdown" })
    }
    case "mode":
      return next({}, { deskLive: action.live })
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
  overlayAt: number | null
  forceEnd: boolean
  holdCountdown: boolean
  endAt: string
  serverNow: number
}

export function deckState(
  state: TransportState & { rev: number; testSetAt: number | null },
  now = Date.now(),
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
  const end = wallTimeInZone(s.date, s.endAt || s.endTime, s.timeZone).getTime()
  return stageScreen(s, Number.isFinite(end) && end <= at)
}
