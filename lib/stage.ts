/**
 * One stage parser for the server (event.json, PUT /api/event) and the browser (/stream),
 * so both always agree on defaults and ranges. Pure: safe to import from client components.
 */
import { CLOCK_SCALE_RANGE, CLOCK_TEXT_RANGE, clampSize } from "@/lib/countdown-size"
import { isValidTime, safeUrl, sanitizeSpeakers, type SpeakerCard } from "@/lib/event"

export type StageOptions = {
  /** /stream audio routing (what plays in the page itself: interactive viewers and OBS browser source) */
  streamProgramAudio: boolean
  streamBedAudio: boolean
  /** Social circles (ported from the Hyphen "Social Circles" design): spotlight one circle at a time. */
  socialSpotlight: boolean
  socialDwellMs: number
  socialCooldownMs: number
  /** White ring stroke around each circle, px @1080p */
  socialStrokePx: number
  socialShowHandle: boolean
  /** Countdown unit boxes: stroke px @1080p and colour */
  countdownStrokePx: number
  countdownStrokeColor: string
  checker: number
  showMeta: boolean
  showLink: boolean
  transparent: boolean
  lineSpacing: number
  blockGap: number
  clockScale: number
  clockText: number
  logoUrl: string
  speakers: SpeakerCard[]
  gallerySeconds: number
  galleryPause: number
  galleryOffset: number
  galleryScale: number
  endTitle: string
  endSubtitle: string
  endDate: string
  endBody: string
  endQrUrl: string
  endButton: string
  /** Optional HH:MM override for when the end card shows. Empty = use the event end time. */
  endAt: string
  forceEnd: boolean
  holdCountdown: boolean
  /** Break / hold overlay cards. `overlay` is the live switch; it beats the end card and countdown. */
  breakTitle: string
  breakMessage: string
  breakImage: string
  breakFit: ImageFit
  holdTitle: string
  holdMessage: string
  holdImage: string
  holdFit: ImageFit
  welcomeTitle: string
  welcomeMessage: string
  welcomeImage: string
  welcomeFit: ImageFit
  /** Desk Rehearsal/Live switch, shared so every desk agrees. Not used by /stream. */
  deskLive: boolean
  overlay: Overlay
  /** Live switch: show the external OBS program feed (relay path /program). Beaten by break/hold/welcome; beats end card and countdown. */
  program: boolean
  /** Which input the program feed shows: Main (/program) or Backup (/program-backup). Live switch. */
  programSource: "main" | "backup"
  /** When the current overlay went up (ms), for the "on break" timer. */
  overlayAt: number | null
}

export type ImageFit = "cover" | "contain"
export type Overlay = "none" | "break" | "hold" | "welcome"

export const DEFAULT_STAGE: StageOptions = {
  checker: 6,
  showMeta: true,
  showLink: true,
  transparent: false,
  streamProgramAudio: true,
  streamBedAudio: false,
  socialSpotlight: true,
  socialDwellMs: 2800,
  socialCooldownMs: 4000,
  socialStrokePx: 3,
  socialShowHandle: true,
  countdownStrokePx: 2,
  countdownStrokeColor: "#ffffff",
  lineSpacing: 1.14,
  blockGap: 1.2,
  clockScale: 1,
  clockText: 1,
  logoUrl: "",
  speakers: [],
  gallerySeconds: 4,
  galleryPause: 6,
  galleryOffset: -86,
  galleryScale: 80,
  endTitle: "Thank you for joining",
  endSubtitle: "Hyphen Festival 2026",
  endDate: "Wed, 04 Nov, 2026",
  endBody: "The stream has ended. Thank you to all speakers, partners and attendees. Recordings will be available shortly.",
  endQrUrl: "https://linktr.ee/onlinehyphen",
  endButton: "Watch replay — coming soon",
  endAt: "",
  forceEnd: false,
  holdCountdown: false,
  breakTitle: "We'll be right back",
  breakMessage: "",
  breakImage: "",
  breakFit: "cover",
  holdTitle: "Please stand by",
  holdMessage: "",
  holdImage: "",
  holdFit: "cover",
  welcomeTitle: "Welcome back",
  welcomeMessage: "",
  welcomeImage: "",
  welcomeFit: "cover",
  deskLive: false,
  overlay: "none",
  program: false,
  programSource: "main",
  overlayAt: null,
}

export const TEXT_MAX = 200
export const BODY_MAX = 1000

/** A real number from a number or numeric string; null, "" and junk are not numbers (Number(null) is 0). */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function clamp(value: unknown, min: number, max: number, fallback: number, round = false) {
  const n = num(value)
  if (n === null) return fallback
  const v = Math.min(max, Math.max(min, n))
  return round ? Math.round(v) : v
}

export function clampChecker(value: unknown, fallback = DEFAULT_STAGE.checker) {
  return clamp(value, 4, 12, fallback, true)
}

function text(value: unknown, fallback: string, max = TEXT_MAX) {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : fallback
}

/** "" (use event end) or a valid HH:MM; anything else falls back. */
export function parseEndAt(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback
  const v = value.trim()
  if (v === "") return ""
  return isValidTime(v) ? v : fallback
}

/**
 * Sanitise a (possibly partial) stage. Fields missing from `raw` keep the `base` value,
 * so a partial PUT never resets the rest of the stage.
 */
export function parseStage(raw: unknown, base: StageOptions = DEFAULT_STAGE): StageOptions {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const has = (key: keyof StageOptions) => key in r && r[key] !== undefined
  const pick = <K extends keyof StageOptions>(key: K, parse: (value: unknown, fallback: StageOptions[K]) => StageOptions[K]): StageOptions[K] =>
    has(key) ? parse(r[key], base[key]) : base[key]
  return {
    checker: pick("checker", (v, f) => clampChecker(v, f)),
    showMeta: pick("showMeta", (v) => v !== false),
    showLink: pick("showLink", (v) => v !== false),
    transparent: pick("transparent", (v) => v === true),
    streamProgramAudio: pick("streamProgramAudio", (v) => v !== false),
    streamBedAudio: pick("streamBedAudio", (v) => v === true),
    socialSpotlight: pick("socialSpotlight", (v) => v !== false),
    socialDwellMs: pick("socialDwellMs", (v, f) => Math.round(clamp(v, 500, 15000, f))),
    socialCooldownMs: pick("socialCooldownMs", (v, f) => Math.round(clamp(v, 0, 15000, f))),
    socialStrokePx: pick("socialStrokePx", (v, f) => Math.round(clamp(v, 0, 12, f) * 2) / 2),
    socialShowHandle: pick("socialShowHandle", (v) => v !== false),
    countdownStrokePx: pick("countdownStrokePx", (v, f) => Math.round(clamp(v, 0, 12, f) * 2) / 2),
    countdownStrokeColor: pick("countdownStrokeColor", (v, f) => hexColor(v, f)),
    lineSpacing: pick("lineSpacing", (v, f) => clamp(v, 0.8, 2.4, f)),
    blockGap: pick("blockGap", (v, f) => clamp(v, 0, 8, f)),
    clockScale: pick("clockScale", (v, f) => clampSize(v, CLOCK_SCALE_RANGE, f)),
    clockText: pick("clockText", (v, f) => clampSize(v, CLOCK_TEXT_RANGE, f)),
    logoUrl: pick("logoUrl", (v) => safeUrl(v, "", { relative: true, dataImage: true })),
    speakers: pick("speakers", (v) => sanitizeSpeakers(v).map((s) => ({ ...s, name: s.name.slice(0, TEXT_MAX), description: s.description.slice(0, BODY_MAX) }))),
    gallerySeconds: pick("gallerySeconds", (v, f) => clamp(v, 2, 30, f, true)),
    galleryPause: pick("galleryPause", (v, f) => clamp(v, 2, 30, f, true)),
    galleryOffset: pick("galleryOffset", (v, f) => clamp(v, -600, 400, f, true)),
    galleryScale: pick("galleryScale", (v, f) => clamp(v, 40, 200, f, true)),
    endTitle: pick("endTitle", (v) => text(v, DEFAULT_STAGE.endTitle)),
    endSubtitle: pick("endSubtitle", (v) => text(v, DEFAULT_STAGE.endSubtitle)),
    endDate: pick("endDate", (v) => text(v, DEFAULT_STAGE.endDate)),
    endBody: pick("endBody", (v) => text(v, DEFAULT_STAGE.endBody, BODY_MAX)),
    endQrUrl: pick("endQrUrl", (v) => safeUrl(v, DEFAULT_STAGE.endQrUrl)),
    endButton: pick("endButton", (v) => text(v, DEFAULT_STAGE.endButton)),
    endAt: pick("endAt", (v, f) => parseEndAt(v, f)),
    forceEnd: pick("forceEnd", (v) => v === true),
    holdCountdown: pick("holdCountdown", (v) => v === true),
    breakTitle: pick("breakTitle", (v) => text(v, DEFAULT_STAGE.breakTitle)),
    breakMessage: pick("breakMessage", (v) => (typeof v === "string" ? v.slice(0, BODY_MAX) : "")),
    breakImage: pick("breakImage", (v) => safeUrl(v, "", { relative: true, dataImage: true })),
    breakFit: pick("breakFit", (v) => (v === "contain" ? "contain" : "cover")),
    holdTitle: pick("holdTitle", (v) => text(v, DEFAULT_STAGE.holdTitle)),
    holdMessage: pick("holdMessage", (v) => (typeof v === "string" ? v.slice(0, BODY_MAX) : "")),
    holdImage: pick("holdImage", (v) => safeUrl(v, "", { relative: true, dataImage: true })),
    holdFit: pick("holdFit", (v) => (v === "contain" ? "contain" : "cover")),
    welcomeTitle: pick("welcomeTitle", (v) => text(v, DEFAULT_STAGE.welcomeTitle)),
    welcomeMessage: pick("welcomeMessage", (v) => (typeof v === "string" ? v.slice(0, BODY_MAX) : "")),
    welcomeImage: pick("welcomeImage", (v) => safeUrl(v, "", { relative: true, dataImage: true })),
    welcomeFit: pick("welcomeFit", (v) => (v === "contain" ? "contain" : "cover")),
    deskLive: pick("deskLive", (v) => v === true),
    overlay: pick("overlay", (v) => (v === "break" || v === "hold" || v === "welcome" ? v : "none")),
    program: pick("program", (v) => v === true),
    programSource: pick("programSource", (v) => (v === "backup" ? "backup" : "main")),
    overlayAt: pick("overlayAt", (v) => (typeof v === "number" && Number.isFinite(v) ? v : null)),
  }
}

/** When the end card should show: the override if set, else the event's end time. */
export function effectiveEndTime(stage: Pick<StageOptions, "endAt">, eventEndTime: string): string {
  return stage.endAt || eventEndTime
}

// ---------- test clock ----------

/** A test clock older than this is ignored by /stream, so a forgotten rehearsal can't go out live. */
export const TEST_CLOCK_TTL_MS = 2 * 60 * 60 * 1000

export function testClockStale(testSetAt: number | null, now = Date.now()): boolean {
  return testSetAt !== null && now - testSetAt > TEST_CLOCK_TTL_MS
}

/** Same speakers in the same order (used to tell a desk draft from the published list). */
export function sameSpeakers(a: readonly SpeakerCard[], b: readonly SpeakerCard[]): boolean {
  return a.length === b.length && a.every((item, i) => item.image === b[i].image && item.name === b[i].name && item.description === b[i].description)
}

/**
 * What /stream shows, in order of precedence:
 * break/hold/welcome overlay  >  forced end / due end-card override  >  OBS program feed  >  end card (past Event › End time unless held)  >  countdown.
 *
 * End card override (ported from agent-forge): when an override time (`endAt`, e.g. deck "End in 2m") is due, or End is
 * forced, the end card cuts over Program. The plain Event › End time does NOT pre-empt Program (a running show is never
 * cut by the schedule alone). After it fires, tap Program or Countdown to stay past the end: that sets holdCountdown.
 */
export function stageScreen(stage: Pick<StageOptions, "overlay" | "forceEnd" | "holdCountdown"> & { program?: boolean; endAt?: string }, pastEnd: boolean): "break" | "hold" | "welcome" | "program" | "end" | "countdown" {
  if (stage.overlay !== "none") return stage.overlay
  if (stage.forceEnd) return "end"
  if (stage.endAt && pastEnd && !stage.holdCountdown) return "end"
  if (stage.program) return "program"
  if (!stage.holdCountdown && pastEnd) return "end"
  return "countdown"
}

/** The test clock a desk should use from a server body: none once it is stale (same TTL as /stream). */
export function serverClock(body: { testUntil?: unknown; pausedAt?: unknown; testSetAt?: unknown; testStale?: unknown }, now = Date.now()): { testUntil: number | null; pausedAt: number | null; testSetAt: number | null } {
  const setAt = typeof body.testSetAt === "number" ? body.testSetAt : null
  if (body.testStale === true || testClockStale(setAt, now)) return { testUntil: null, pausedAt: null, testSetAt: null }
  return { testUntil: typeof body.testUntil === "number" ? body.testUntil : null, pausedAt: typeof body.pausedAt === "number" ? body.pausedAt : null, testSetAt: setAt }
}
/** The desk's localStorage clock fallback: dropped when it was saved longer ago than the TTL (or undated). */
export function localClock(raw: string | null, now = Date.now()): { testUntil: number | null; pausedAt: number | null } {
  try {
    const c = raw ? (JSON.parse(raw) as { testUntil?: unknown; pausedAt?: unknown; savedAt?: unknown }) : null
    if (!c || typeof c.savedAt !== "number" || testClockStale(c.savedAt, now)) return { testUntil: null, pausedAt: null }
    return { testUntil: typeof c.testUntil === "number" ? c.testUntil : null, pausedAt: typeof c.pausedAt === "number" ? c.pausedAt : null }
  } catch { return { testUntil: null, pausedAt: null } }
}

/** #rgb / #rrggbb only (goes into inline styles). */
export function hexColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback
}

/** The SocialCircles look from stage options. */
export function socialLook(stage: StageOptions) {
  return {
    spotlight: stage.socialSpotlight,
    dwellMs: stage.socialDwellMs,
    cooldownMs: stage.socialCooldownMs,
    strokePx: stage.socialStrokePx,
    showHandle: stage.socialShowHandle,
  }
}
