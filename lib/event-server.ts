import fs from "node:fs"
import path from "node:path"
import { CLOCK_SCALE_RANGE, CLOCK_TEXT_RANGE, clampSize } from "@/lib/countdown-size"
import { DATA_DIR } from "@/lib/encoder"
import { asEventConfig, DEFAULT_EVENT, type EventConfig } from "@/lib/event"

const EVENT_FILE = path.join(DATA_DIR, "event.json")

export function readServerEvent(): EventConfig {
  return readServerState().event
}

export type SpeakerCard = { image: string; name: string; description: string }

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
}

const DEFAULT_STAGE: StageOptions = {
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
}

function readStage(value: unknown): StageOptions {
  if (!value || typeof value !== "object") return { ...DEFAULT_STAGE }
  const record = value as Record<string, unknown>
  const checker = Number(record.checker)
  return {
    checker: Number.isFinite(checker) ? Math.min(12, Math.max(4, Math.round(checker))) : 6,
    showMeta: record.showMeta !== false,
    showLink: record.showLink !== false,
    transparent: record.transparent === true,
    lineSpacing: Number.isFinite(Number(record.lineSpacing)) ? Math.min(2.4, Math.max(0.8, Number(record.lineSpacing))) : 1.14,
    blockGap: Number.isFinite(Number(record.blockGap)) ? Math.min(8, Math.max(0, Number(record.blockGap))) : 1.2,
    clockScale: clampSize(record.clockScale, CLOCK_SCALE_RANGE),
    clockText: clampSize(record.clockText, CLOCK_TEXT_RANGE),
    logoUrl: typeof record.logoUrl === "string" ? record.logoUrl : "",
    speakers: readSpeakers(record.speakers),
    gallerySeconds: clampSeconds(record.gallerySeconds, 4),
    galleryPause: clampSeconds(record.galleryPause, 6),
    galleryOffset: clampOffset(record.galleryOffset),
    galleryScale: clampScale(record.galleryScale),
  }
}

function clampScale(value: unknown) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 80
  return Math.min(200, Math.max(40, Math.round(number)))
}

function clampOffset(value: unknown) {
  const number = Number(value)
  if (!Number.isFinite(number)) return -86
  return Math.min(400, Math.max(-600, Math.round(number)))
}

function clampSeconds(value: unknown, fallback: number) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(30, Math.max(2, Math.round(number)))
}

function readSpeakers(value: unknown): SpeakerCard[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 12).map((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {}
    return {
      image: typeof record.image === "string" ? record.image : "",
      name: typeof record.name === "string" ? record.name : "",
      description: typeof record.description === "string" ? record.description : "",
    }
  }).filter((item) => item.image || item.name || item.description)
}

export function readServerState(): { event: EventConfig; testUntil: number | null; pausedAt: number | null; stage: StageOptions } {
  try {
    const parsed = JSON.parse(fs.readFileSync(EVENT_FILE, "utf8")) as {
      event?: unknown
      testUntil?: unknown
      pausedAt?: unknown
      stage?: unknown
    }
    const event = asEventConfig(parsed.event ?? parsed) ?? { ...DEFAULT_EVENT }
    return {
      event,
      testUntil: typeof parsed.testUntil === "number" ? parsed.testUntil : null,
      pausedAt: typeof parsed.pausedAt === "number" ? parsed.pausedAt : null,
      stage: readStage(parsed.stage),
    }
  } catch (error) {
    console.warn("Could not read event.json, using the default event.", error)
    return { event: { ...DEFAULT_EVENT }, testUntil: null, pausedAt: null, stage: { ...DEFAULT_STAGE } }
  }
}

export function writeServerEvent(
  value: unknown,
  testUntil?: number | null,
  pausedAt?: number | null,
  stage?: StageOptions,
): EventConfig | null {
  const event = asEventConfig(value)
  if (!event) return null
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const current = readServerState()
  const payload = JSON.stringify(
    {
      event,
      testUntil: testUntil === undefined ? current.testUntil : testUntil,
      pausedAt: pausedAt === undefined ? current.pausedAt : pausedAt,
      stage: stage ?? current.stage,
    },
    null,
    2,
  )
  const temporary = `${EVENT_FILE}.tmp`
  fs.writeFileSync(temporary, payload)
  fs.renameSync(temporary, EVENT_FILE)
  return event
}
