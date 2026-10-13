/**
 * One stage parser for the server (event.json, PUT /api/event) and the browser (/stream),
 * so both always agree on defaults and ranges. Pure: safe to import from client components.
 */
import { CLOCK_SCALE_RANGE, CLOCK_TEXT_RANGE, clampSize } from "@/lib/countdown-size"
import { isValidTime, safeUrl, sanitizeSpeakers, type SpeakerCard } from "@/lib/event"

export type StageOptions = {
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
}

export const DEFAULT_STAGE: StageOptions = {
  checker: 6,
  showMeta: true,
  showLink: true,
  transparent: false,
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
