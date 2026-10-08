import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "@/lib/encoder"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import { asEventConfig } from "@/lib/event-storage"

const EVENT_FILE = path.join(DATA_DIR, "event.json")

export function readServerEvent(): EventConfig {
  return readServerState().event
}

export function readServerState(): { event: EventConfig; testUntil: number | null } {
  try {
    const parsed = JSON.parse(fs.readFileSync(EVENT_FILE, "utf8")) as { event?: unknown; testUntil?: unknown }
    const event = asEventConfig(parsed.event ?? parsed) ?? { ...DEFAULT_EVENT }
    const testUntil = typeof parsed.testUntil === "number" ? parsed.testUntil : null
    return { event, testUntil }
  } catch {
    return { event: { ...DEFAULT_EVENT }, testUntil: null }
  }
}

export function writeServerEvent(value: unknown, testUntil?: number | null): EventConfig | null {
  const event = asEventConfig(value)
  if (!event) return null
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const current = readServerState()
  fs.writeFileSync(
    EVENT_FILE,
    JSON.stringify({ event, testUntil: testUntil === undefined ? current.testUntil : testUntil }, null, 2),
  )
  return event
}
