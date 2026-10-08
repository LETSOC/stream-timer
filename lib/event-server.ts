import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "@/lib/encoder"
import { asEventConfig, DEFAULT_EVENT, type EventConfig } from "@/lib/event"

const EVENT_FILE = path.join(DATA_DIR, "event.json")

export function readServerEvent(): EventConfig {
  return readServerState().event
}

export function readServerState(): { event: EventConfig; testUntil: number | null; pausedAt: number | null } {
  try {
    const parsed = JSON.parse(fs.readFileSync(EVENT_FILE, "utf8")) as {
      event?: unknown
      testUntil?: unknown
      pausedAt?: unknown
    }
    const event = asEventConfig(parsed.event ?? parsed) ?? { ...DEFAULT_EVENT }
    return {
      event,
      testUntil: typeof parsed.testUntil === "number" ? parsed.testUntil : null,
      pausedAt: typeof parsed.pausedAt === "number" ? parsed.pausedAt : null,
    }
  } catch {
    return { event: { ...DEFAULT_EVENT }, testUntil: null, pausedAt: null }
  }
}

export function writeServerEvent(
  value: unknown,
  testUntil?: number | null,
  pausedAt?: number | null,
): EventConfig | null {
  const event = asEventConfig(value)
  if (!event) return null
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const current = readServerState()
  fs.writeFileSync(
    EVENT_FILE,
    JSON.stringify(
      {
        event,
        testUntil: testUntil === undefined ? current.testUntil : testUntil,
        pausedAt: pausedAt === undefined ? current.pausedAt : pausedAt,
      },
      null,
      2,
    ),
  )
  return event
}
