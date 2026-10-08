import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "@/lib/encoder"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import { asEventConfig } from "@/lib/event-storage"

const EVENT_FILE = path.join(DATA_DIR, "event.json")

export function readServerEvent(): EventConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(EVENT_FILE, "utf8"))
    return asEventConfig(parsed) ?? { ...DEFAULT_EVENT }
  } catch {
    return { ...DEFAULT_EVENT }
  }
}

export function writeServerEvent(value: unknown): EventConfig | null {
  const event = asEventConfig(value)
  if (!event) return null
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(EVENT_FILE, JSON.stringify(event, null, 2))
  return event
}
