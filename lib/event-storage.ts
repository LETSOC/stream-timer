"use client"

import { useCallback, useSyncExternalStore } from "react"
import { DEFAULT_EVENT, TIME_ZONES, type EventConfig } from "@/lib/event"

const STORAGE_KEY = "hyphen-countdown-event"

const ZONE_IDS = new Set<string>(TIME_ZONES.map((zone) => zone.id))
const listeners = new Set<() => void>()
let memory: EventConfig | null = null

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function asConfig(value: unknown): EventConfig | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const name = readString(record, "name")
  const date = readString(record, "date")
  const time = readString(record, "time")
  const timeZone = readString(record, "timeZone")
  if (!name || !date || !time || !timeZone || !ZONE_IDS.has(timeZone)) return null

  return {
    name,
    date,
    time,
    timeZone,
    endTime: readString(record, "endTime") || DEFAULT_EVENT.endTime,
    venue: readString(record, "venue") || DEFAULT_EVENT.venue,
    rsvpUrl: readString(record, "rsvpUrl") || DEFAULT_EVENT.rsvpUrl,
  }
}

function migrateEvent(event: EventConfig): EventConfig {
  const stillStockBerlinDefault =
    event.name === DEFAULT_EVENT.name &&
    event.date === DEFAULT_EVENT.date &&
    event.time === DEFAULT_EVENT.time &&
    event.timeZone === "Europe/Berlin"

  if (!stillStockBerlinDefault) return event
  return { ...event, timeZone: DEFAULT_EVENT.timeZone }
}

export function readStoredEvent(): EventConfig | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    const config = asConfig(parsed)
    return config ? migrateEvent(config) : null
  } catch {
    return null
  }
}

export function writeStoredEvent(event: EventConfig): void {
  memory = event
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(event))
  listeners.forEach((listener) => listener())
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange)
  return () => listeners.delete(onStoreChange)
}

function getClientSnapshot(): EventConfig {
  if (!memory) memory = readStoredEvent() ?? { ...DEFAULT_EVENT }
  return memory
}

function getServerSnapshot(): EventConfig {
  return DEFAULT_EVENT
}

export function useStoredEvent() {
  const event = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    getServerSnapshot,
  )

  const update = useCallback((partial: Partial<EventConfig>) => {
    writeStoredEvent({ ...getClientSnapshot(), ...partial })
  }, [])

  return [event, update] as const
}

export function resolveEvent(
  overrides: Partial<EventConfig> = {},
): EventConfig {
  const stored = readStoredEvent()
  return {
    name: overrides.name?.trim() || stored?.name || DEFAULT_EVENT.name,
    date: overrides.date || stored?.date || DEFAULT_EVENT.date,
    time: overrides.time || stored?.time || DEFAULT_EVENT.time,
    timeZone: overrides.timeZone || stored?.timeZone || DEFAULT_EVENT.timeZone,
    endTime: overrides.endTime || stored?.endTime || DEFAULT_EVENT.endTime,
    venue: overrides.venue?.trim() || stored?.venue || DEFAULT_EVENT.venue,
    rsvpUrl: overrides.rsvpUrl?.trim() || stored?.rsvpUrl || DEFAULT_EVENT.rsvpUrl,
  }
}
