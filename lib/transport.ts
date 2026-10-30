/**
 * Transport actions (desk Transport panel and the phone deck): one pure implementation, so the
 * desk (applies it locally, then saves) and the server (deck WebSocket / POST /api/deck/action)
 * always compute the same next state. Safe to import from client components.
 */
import { wallTimeInZone } from "@/lib/countdown"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import type { FailoverEvent, FailoverSettings, ReturnStatus, SourceHealth } from "@/lib/program-source"
import type { InputReadout } from "@/lib/input-state"
import { CARD_OVERLAYS, END_OFFSET_MAX, isCardOverlay, stageScreen, testClockStale, type CardOverlay, type StageOptions } from "@/lib/stage"
import { LOGO_IDS, type LogoId, type SceneId } from "@/lib/visuals-assets"
import { clampHold, CORNERS, parseTalkTimer, sanitizeTickerItems, talkAdjust, talkPause, talkResume, talkStart, TALK_MAX_SEC, TALK_MODES, TALK_STOPPED, TICKER_TYPES, visualText, type TalkMode, type TickerType, STRAP_MODES, STRAP_MOTIONS, STRAP_STYLES, type Corner, type StrapMode, type StrapMotion, type StrapPreset, type StrapStyle } from "@/lib/visuals"

export const JUMPS = [
  { label: "15s", seconds: 15 },
  { label: "10m", seconds: 600 },
  { label: "30m", seconds: 1800 },
  { label: "1h", seconds: 3600 },
] as const

export type Screen = "break" | "hold" | "welcome" | SceneId | "program" | "end" | "countdown"
export const SCREENS: readonly Screen[] = ["countdown", ...CARD_OVERLAYS, "program", "end"]
/** Full-screen cards (they cover program): break / hold / welcome and the extra scene cards. */
export const isCard = (s: unknown): s is CardOverlay => isCardOverlay(s)

export type TransportAction =
  | { type: "jump"; seconds: number }
  | { type: "goLive" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "reset" }
  | { type: "restore" }
  | { type: "screen"; screen: Screen }
  | { type: "mode"; live: boolean }
  /** Quick action: move the planned Event › End time. */
  | { type: "extendEnd"; minutes: number }
  /** End card adjustment from the planned end: step by ±minutes (deck −5/−1/+1/+5), or clear back to planned. Two taps. */
  | { type: "endOffset"; minutes: number }
  | { type: "endOffset"; clear: true }
  /** Undo: put the planned end and the adjustment back exactly as they were. */
  | { type: "setEnd"; endTime: string; endOffsetMin: number }
  /** Program feed input: Main (OBS) or Backup. Doesn't change the screen. */
  | { type: "programSource"; source: "main" | "backup" }
  | { type: "resyncPlayers" }
  /** /stream in-page audio routing: raw program audio and/or the bed (applied at once, synced). */
  | { type: "streamAudio"; program?: boolean; bed?: boolean }
  /** Visuals: name strap IN / OUT / LOOP and its live look. Applied at once (no Save). */
  | { type: "strap"; mode?: StrapMode; id?: string; holdSec?: number; motion?: StrapMotion; style?: StrapStyle | ""; corner?: Corner }
  /** Visuals: social circles overlay show/hide + corner. */
  | { type: "socials"; show?: boolean; corner?: Corner }
  /** A/V diagnostics: STREAM timecode on /stream (diagnostic only). */
  | { type: "timecode"; show?: boolean; fps?: number }
  /** Visuals layer: talk-ends pill (timer start/add/pause/resume/stop, Session/Festival), ticker, Q&A, Sponsored, and the /stream master switch. Applied at once. */
  | { type: "visual"; target: VisualTarget; show?: boolean; op?: TalkOp; sec?: number; mode?: TalkMode; tickerType?: TickerType; items?: string[]; text?: string; prefix?: string; talkPrefix?: string; festivalPrefix?: string; logo?: LogoId; /** ticker: which list `items` replaces (default: the type now showing) */ list?: TickerType }

export const VISUAL_TARGETS = ["talk", "ticker", "qa", "sponsor", "stream", "clear", "logo", "qr", "qrLogo"] as const
export type VisualTarget = (typeof VISUAL_TARGETS)[number]
export const TALK_OPS = ["start", "add", "pause", "resume", "stop"] as const
export type TalkOp = (typeof TALK_OPS)[number]

export type ProgramSourcesView = {
  main: SourceHealth & Partial<InputReadout>
  backup: SourceHealth & Partial<InputReadout> & { pull: boolean }
  /** per-feed OBS login on (per-feed Disarm/Arm) */
  armed?: { main: boolean; backup: boolean }
  returnStatus?: ReturnStatus | null
  failover: FailoverSettings
  last: FailoverEvent | null
  /** newest first, up to 20, persisted across restarts */
  history?: FailoverEvent[]
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
export function endGuard(state: Pick<TransportState, "event" | "testUntil" | "pausedAt">, to: string, now: number, offsetMin = 0): string | null {
  const end = endInstant(state.event.date, state.event.time, to, state.event.timeZone).getTime() + offsetMin * 60_000
  if (offsetMin) to = hhmmAt(end, state.event.timeZone)
  const start = eventTarget(state.event).getTime()
  if (!Number.isFinite(end)) return "The end time is not valid."
  if (Number.isFinite(start) && end <= start) return `Can't end at ${to}: that's before the start (${state.event.time}).`
  if (end <= effectiveNow(state, now)) return `Can't end at ${to}: that's already past.`
  return null
}

/** Where extendEnd writes, and the time it lands on. */
export function extendTarget(endTime: string, minutes: number): { field: "endTime"; from: string; to: string } {
  return { field: "endTime", from: endTime, to: addMinutes(endTime, minutes) }
}

/** Deck steps for the end card adjustment (minutes). */
export const END_STEPS = [-5, -1, 1, 5] as const

/** When the end card shows: planned Event › End time on the event date, plus the signed adjustment. */
export function endCardAt(date: string, start: string, endTime: string, timeZone: string, offsetMin = 0): number {
  return endInstant(date, start, endTime, timeZone).getTime() + (offsetMin || 0) * 60_000
}

/** "−2m" / "+10m" / "" (as planned). */
export function formatOffset(min: number): string {
  if (!min) return ""
  return `${min < 0 ? "−" : "+"}${Math.abs(min)}m`
}

/** HH:MM of an instant in the event zone. */
export function hhmmAt(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
  return `${get("hour")}:${get("minute")}`
}

/** "Ends 16:13 (−2m)" or "Ends 16:15" (planned). */
export function endsLabel(date: string, start: string, endTime: string, timeZone: string, offsetMin: number): string {
  const at = endCardAt(date, start, endTime, timeZone, offsetMin)
  if (!Number.isFinite(at)) return `Ends ${endTime}`
  return `Ends ${hhmmAt(at, timeZone)}${offsetMin ? ` (${formatOffset(offsetMin)})` : ""}`
}

export type TransportState = {
  event: EventConfig
  testUntil: number | null
  pausedAt: number | null
  stage: StageOptions
}

/** Actions that touch /stream in a way that's hard to undo: the deck asks for a second tap.
 * Every screen/card switch (scene cards and back to LIVE too), on every device, live or not. */
export const RISKY: ReadonlySet<TransportAction["type"] | `screen:${Screen}`> = new Set(["goLive", "reset", "restore", "endOffset", ...SCREENS.map((s) => `screen:${s}` as const)])
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
const testClockOn = (s: Pick<TransportState, "testUntil" | "pausedAt">) => s.testUntil !== null || s.pausedAt !== null

export function effectiveNow(state: Pick<TransportState, "event" | "testUntil" | "pausedAt">, now: number): number {
  if (state.pausedAt !== null) return state.pausedAt
  const target = eventTarget(state.event).getTime()
  if (state.testUntil !== null && Number.isFinite(target)) return now + (target - state.testUntil)
  return now
}

/** "4 Nov 09:32" for the end card instant (adds " · next day" when the end rolls past midnight). */
export function formatEndWhen(date: string, start: string, end: string, timeZone: string): string {
  const instant = endInstant(date, start, end, timeZone)
  if (!Number.isFinite(instant.getTime())) return end
  const label = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant).replace(",", "")
  return end < start ? `${label} · next day` : label
}

/** HH:MM in the event zone, `minutes` after the time /stream counts against (test clock aware). Feeds deck "End in Nm". */
export function endSoonAt(state: Pick<TransportState, "event" | "testUntil" | "pausedAt">, now: number, minutes: number): string {
  const at = new Date(effectiveNow(state, now) + minutes * 60_000)
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: state.event.timeZone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
  return `${get("hour")}:${get("minute")}`
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
      return typeof v.endTime === "string" && HHMM.test(v.endTime) && typeof v.endOffsetMin === "number" && Number.isInteger(v.endOffsetMin) && Math.abs(v.endOffsetMin) <= END_OFFSET_MAX
        ? { type: "setEnd", endTime: v.endTime, endOffsetMin: v.endOffsetMin }
        : null
    case "endOffset":
      if (v.clear === true) return { type: "endOffset", clear: true }
      return END_STEPS.includes(v.minutes as (typeof END_STEPS)[number]) ? { type: "endOffset", minutes: v.minutes as number } : null
    case "resyncPlayers":
      return { type: "resyncPlayers" }
    case "programSource":
      return v.source === "main" || v.source === "backup" ? { type: "programSource", source: v.source } : null
    case "streamAudio": {
      const out: { type: "streamAudio"; program?: boolean; bed?: boolean } = { type: "streamAudio" }
      if (typeof v.program === "boolean") out.program = v.program
      if (typeof v.bed === "boolean") out.bed = v.bed
      return out.program === undefined && out.bed === undefined ? null : out
    }
    case "strap": {
      const out: Extract<TransportAction, { type: "strap" }> = { type: "strap" }
      if (STRAP_MODES.includes(v.mode as StrapMode)) out.mode = v.mode as StrapMode
      if (typeof v.id === "string" && /^[a-z0-9_-]{1,32}$/i.test(v.id)) out.id = v.id
      if (typeof v.holdSec === "number" && Number.isFinite(v.holdSec)) out.holdSec = clampHold(v.holdSec)
      if (STRAP_MOTIONS.includes(v.motion as StrapMotion)) out.motion = v.motion as StrapMotion
      if (v.style === "" || STRAP_STYLES.includes(v.style as StrapStyle)) out.style = v.style as StrapStyle | ""
      if (CORNERS.includes(v.corner as Corner)) out.corner = v.corner as Corner
      return Object.keys(out).length > 1 ? out : null
    }
    case "socials": {
      const out: Extract<TransportAction, { type: "socials" }> = { type: "socials" }
      if (typeof v.show === "boolean") out.show = v.show
      if (CORNERS.includes(v.corner as Corner)) out.corner = v.corner as Corner
      return Object.keys(out).length > 1 ? out : null
    }
    case "visual": {
      if (!VISUAL_TARGETS.includes(v.target as VisualTarget)) return null
      const out: Extract<TransportAction, { type: "visual" }> = { type: "visual", target: v.target as VisualTarget }
      if (typeof v.show === "boolean") out.show = v.show
      if (out.target === "talk") {
        if (TALK_OPS.includes(v.op as TalkOp)) out.op = v.op as TalkOp
        if (typeof v.sec === "number" && Number.isFinite(v.sec) && Math.abs(v.sec) <= TALK_MAX_SEC) out.sec = Math.round(v.sec)
        if ((out.op === "start" || out.op === "add") && out.sec === undefined) return null
        if (TALK_MODES.includes(v.mode as TalkMode)) out.mode = v.mode as TalkMode
        if (typeof v.prefix === "string") out.prefix = v.prefix
        // Separate fields (builder): set either prefix without touching the mode.
        if (typeof v.talkPrefix === "string") out.talkPrefix = v.talkPrefix
        if (typeof v.festivalPrefix === "string") out.festivalPrefix = v.festivalPrefix
      }
      if (out.target === "ticker") {
        if (TICKER_TYPES.includes(v.tickerType as TickerType)) out.tickerType = v.tickerType as TickerType
        if (Array.isArray(v.items) || typeof v.items === "string") out.items = sanitizeTickerItems(v.items)
        if (TICKER_TYPES.includes(v.list as TickerType)) out.list = v.list as TickerType
      }
      if ((out.target === "qa" || out.target === "sponsor") && typeof v.text === "string") out.text = v.text
      if (out.target === "logo") {
        if (!LOGO_IDS.includes(v.logo as LogoId) || out.show === undefined) return null
        out.logo = v.logo as LogoId
      }
      return out.target === "clear" || Object.keys(out).length > 2 ? out : null
    }
    case "timecode": {
      const out: Extract<TransportAction, { type: "timecode" }> = { type: "timecode" }
      if (typeof v.show === "boolean") out.show = v.show
      if ([25, 30, 50, 60].includes(v.fps as number)) out.fps = v.fps as number
      return Object.keys(out).length > 1 ? out : null
    }
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
      // An end card override set while a test clock ran is a test-time HH:MM: it must not stick into the real run.
      return next({ testUntil: null, pausedAt: null }, testClockOn(state) ? { endOffsetMin: 0 } : {})
    case "restore":
      return next({ event: { ...state.event, date: DEFAULT_EVENT.date, time: DEFAULT_EVENT.time, timeZone: DEFAULT_EVENT.timeZone }, testUntil: null, pausedAt: null }, testClockOn(state) ? { endOffsetMin: 0 } : {})
    case "screen": {
      const overlay = isCard(action.screen) ? action.screen : "none"
      const overlayAt = overlay === "none" ? null : overlay === state.stage.overlay ? state.stage.overlayAt ?? now : now
      // Cards sit on top of the program feed (it stays "on" underneath); countdown/end switch it off.
      const program = action.screen === "program" ? true : overlay !== "none" ? state.stage.program : false
      // Program and Countdown both hold past a due end-card override (else End in 2m → end card → Program snaps back to end).
      const holdCountdown = action.screen === "countdown" || action.screen === "program" || (overlay !== "none" && state.stage.holdCountdown)
      return next({}, { overlay, overlayAt, program, forceEnd: action.screen === "end", holdCountdown })
    }
    case "mode":
      return next({}, { deskLive: action.live })
    case "extendEnd": {
      const from = state.event.endTime
      if (!HHMM.test(from)) return { ok: false, error: "The end time is not valid." }
      const { to } = extendTarget(from, action.minutes)
      // The end must move by exactly the minutes (else it wrapped past the start onto another day).
      const at = (t: string) => endInstant(state.event.date, state.event.time, t, state.event.timeZone).getTime()
      if (Math.abs(at(to) - at(from) - action.minutes * 60_000) > 60_000) return { ok: false, error: action.minutes < 0 ? `Can't end at ${to}: that's before the start (${state.event.time}).` : `Can't extend past ${to}: the end would be more than a day after the start.` }
      const guard = endGuard(state, to, now, state.stage.endOffsetMin)
      if (guard) return { ok: false, error: guard }
      // forceEnd (operator chose "end") stays; otherwise the new end time decides countdown/LIVE vs end card.
      // A new end time is a decision about the end: an earlier "Countdown" hold must not keep the end card away.
      return next({ event: { ...state.event, endTime: to } }, { holdCountdown: false })
    }
    case "endOffset": {
      const offset = "clear" in action ? 0 : state.stage.endOffsetMin + action.minutes
      if (Math.abs(offset) > END_OFFSET_MAX) return { ok: false, error: `The end can move at most ${END_OFFSET_MAX / 60} h either way.` }
      // Clearing (back to the planned end) is always allowed; a new adjustment must land after the doors and after now.
      if (offset !== 0) {
        const guard = endGuard(state, state.event.endTime, now, offset)
        if (guard) return { ok: false, error: guard }
      }
      return next({}, { endOffsetMin: offset, holdCountdown: false })
    }
    case "programSource":
      return next({}, { programSource: action.source })
    case "resyncPlayers":
      return next({}, { playerResyncAt: now })
    case "streamAudio":
      return next({}, { ...(action.program === undefined ? {} : { streamProgramAudio: action.program }), ...(action.bed === undefined ? {} : { streamBedAudio: action.bed }) })
    case "setEnd":
      // Undo: exactly as it was before (no guard).
      return next({ event: { ...state.event, endTime: action.endTime } }, { endOffsetMin: action.endOffsetMin, holdCountdown: false })
    case "strap": {
      const id = action.id ?? state.stage.strapId
      if (action.mode && action.mode !== "out" && !state.stage.straps.some((p) => p.id === id)) return { ok: false, error: "Pick a saved strap first." }
      const patch: Partial<StageOptions> = { strapId: id }
      if (action.holdSec !== undefined) patch.strapHoldSec = action.holdSec
      if (action.motion) patch.strapMotion = action.motion
      if (action.style !== undefined) patch.strapStyle = action.style
      if (action.corner) patch.strapCorner = action.corner
      // IN / LOOP restart the motion from now; OUT just takes it off.
      if (action.mode) Object.assign(patch, { strapMode: action.mode, strapAt: action.mode === "out" ? state.stage.strapAt : now })
      return next({}, patch)
    }
    case "timecode":
      return next({}, { ...(action.show === undefined ? {} : { streamTimecode: action.show }), ...(action.fps ? { streamTimecodeFps: action.fps } : {}) })
    case "socials":
      return next({}, { ...(action.show === undefined ? {} : { socialsOverlay: action.show }), ...(action.corner ? { socialsCorner: action.corner } : {}) })
    case "visual":
      return next({}, visualPatch(state.stage, action, now))
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
  streamAudio?: { program: boolean; bed: boolean }
  /** Live health of both inputs (null = relay not armed). */
  programSources: ProgramSourcesView | null
  /** Last known: is OBS publishing to the relay's /program path? null = not known (relay not armed). */
  programReady: boolean | null
  /** ms left of a disarm/arm cycle (auto re-arm or desk buttons): previews hold the last frame, no "Waiting for OBS". */
  rearmHoldMs?: number
  overlayAt: number | null
  forceEnd: boolean
  holdCountdown: boolean
  endOffsetMin: number
  /** Visuals deck: strap presets (text only) and the live overlay state. */
  visuals?: {
    straps: StrapPreset[]
    strapId: string
    strapMode: StrapMode
    strapAt: number | null
    strapHoldSec: number
    strapMotion: StrapMotion
    strapStyle: StrapStyle | ""
    strapCorner: Corner
    socialsOverlay: boolean
    socialsCorner: Corner
    streamVisuals?: boolean
    talkVisible?: boolean
    talkMode?: TalkMode
    talkEndsAt?: number | null
    talkPausedMs?: number | null
    talkPrefix?: string
    festivalPrefix?: string
    tickerVisible?: boolean
    tickerType?: TickerType
    tickerCount?: number
    tickerItems?: string[]
    tickerPlannerItems?: string[]
    tickerSocialItems?: string[]
    qaText?: string
    sponsorText?: string
    qaVisible?: boolean
    sponsorVisible?: boolean
    logosOn?: LogoId[]
    qrOn?: boolean
    qrLogoOn?: boolean
  }
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
    streamAudio: { program: state.stage.streamProgramAudio !== false, bed: state.stage.streamBedAudio === true },
    programSources: sources,
    programReady,
    overlayAt: state.stage.overlayAt,
    forceEnd: state.stage.forceEnd,
    holdCountdown: state.stage.holdCountdown,
    endOffsetMin: state.stage.endOffsetMin,
    visuals: {
      straps: state.stage.straps ?? [],
      strapId: state.stage.strapId ?? "",
      strapMode: state.stage.strapMode ?? "out",
      strapAt: state.stage.strapAt ?? null,
      strapHoldSec: state.stage.strapHoldSec ?? 5,
      strapMotion: state.stage.strapMotion ?? "slide-left",
      strapStyle: state.stage.strapStyle ?? "",
      strapCorner: state.stage.strapCorner ?? "bottom-left",
      socialsOverlay: state.stage.socialsOverlay === true,
      socialsCorner: state.stage.socialsCorner ?? "bottom-left",
      streamVisuals: state.stage.streamVisuals !== false,
      talkVisible: state.stage.talkVisible === true,
      talkMode: state.stage.talkMode ?? "session",
      talkEndsAt: state.stage.talkEndsAt ?? null,
      talkPausedMs: state.stage.talkPausedMs ?? null,
      talkPrefix: state.stage.talkPrefix ?? "",
      festivalPrefix: state.stage.festivalPrefix ?? "",
      tickerVisible: state.stage.tickerVisible === true,
      tickerType: state.stage.tickerType ?? "planner",
      tickerCount: state.stage.tickerItems?.length ?? 0,
      tickerItems: state.stage.tickerItems ?? [],
      tickerPlannerItems: state.stage.tickerPlannerItems ?? [],
      tickerSocialItems: state.stage.tickerSocialItems ?? [],
      qaText: state.stage.qaText ?? "",
      sponsorText: state.stage.sponsorText ?? "",
      qaVisible: state.stage.qaVisible === true,
      sponsorVisible: state.stage.sponsorVisible === true,
      logosOn: state.stage.logosOn ?? [],
      qrOn: state.stage.qrOn === true,
      qrLogoOn: state.stage.qrLogoOn === true,
    },
    serverNow: now,
  }
}

/** What /stream shows right now for a deck state (same precedence as /stream). */
export function deckScreen(s: DeckState, now: number): Screen {
  const stale = s.testStale
  const clock = { event: { date: s.date, time: s.time, timeZone: s.timeZone } as EventConfig, testUntil: stale ? null : s.testUntil, pausedAt: stale ? null : s.pausedAt }
  const at = effectiveNow(clock, now)
  const end = endCardAt(s.date, s.time, s.endTime, s.timeZone, s.endOffsetMin)
  return stageScreen(s, Number.isFinite(end) && end <= at)
}

/** Pure: the stage patch for a Visuals layer action (deck). */
export function visualPatch(stage: StageOptions, action: Extract<TransportAction, { type: "visual" }>, now: number): Partial<StageOptions> {
  const show = action.show
  switch (action.target) {
    case "stream":
      return show === undefined ? {} : { streamVisuals: show }
    case "clear":
      // Clear all overlays: everything off the picture (strap OUT, pills, ticker, socials). Timer keeps running; texts kept.
      return { strapMode: "out", talkVisible: false, tickerVisible: false, qaVisible: false, sponsorVisible: false, socialsOverlay: false, logosOn: [], qrOn: false, qrLogoOn: false }
    case "talk": {
      const patch: Partial<StageOptions> = {}
      if (show !== undefined) patch.talkVisible = show
      if (action.mode) patch.talkMode = action.mode
      if (action.prefix !== undefined) {
        const t = visualText(action.prefix, "")
        if (t) patch[(action.mode ?? stage.talkMode) === "festival" ? "festivalPrefix" : "talkPrefix"] = t
      }
      for (const key of ["talkPrefix", "festivalPrefix"] as const) {
        const t = action[key] === undefined ? "" : visualText(action[key], "")
        if (t) patch[key] = t
      }
      const cur = parseTalkTimer(stage.talkEndsAt, stage.talkPausedMs)
      const t = action.op === "start" ? talkStart(action.sec ?? 0, now)
        : action.op === "add" ? talkAdjust(cur, action.sec ?? 0, now)
        : action.op === "pause" ? talkPause(cur, now)
        : action.op === "resume" ? talkResume(cur, now)
        : action.op === "stop" ? TALK_STOPPED
        : null
      if (t) Object.assign(patch, { talkEndsAt: t.endsAt, talkPausedMs: t.pausedMs })
      // Starting a session timer shows the pill in Session mode.
      if (action.op === "start") Object.assign(patch, { talkVisible: show ?? true, talkMode: action.mode ?? "session" })
      return patch
    }
    case "logo": {
      if (!action.logo || show === undefined) return {}
      const cur = stage.logosOn ?? []
      const next = show ? [...cur.filter((id) => id !== action.logo), action.logo] : cur.filter((id) => id !== action.logo)
      return { logosOn: LOGO_IDS.filter((id) => next.includes(id)) }
    }
    case "qr":
      return show === undefined ? {} : { qrOn: show }
    case "qrLogo":
      return show === undefined ? {} : { qrLogoOn: show }
    case "ticker": {
      // Planner and Social keep their own lists; the bar shows the current type's list.
      const type = action.tickerType ?? stage.tickerType
      const list = action.list ?? type
      const planner = action.items && list === "planner" ? action.items : stage.tickerPlannerItems ?? []
      const social = action.items && list === "social" ? action.items : stage.tickerSocialItems ?? []
      return { ...(show === undefined ? {} : { tickerVisible: show }), tickerType: type, tickerPlannerItems: planner, tickerSocialItems: social, tickerItems: type === "social" ? social : planner }
    }
    case "qa":
    case "sponsor": {
      const key = action.target === "qa" ? ({ v: "qaVisible", t: "qaText" } as const) : ({ v: "sponsorVisible", t: "sponsorText" } as const)
      const text = action.text === undefined ? "" : visualText(action.text, "")
      return { ...(show === undefined ? {} : { [key.v]: show }), ...(text ? { [key.t]: text } : {}) }
    }
  }
}
