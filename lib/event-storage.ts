"use client"

import { useCallback, useSyncExternalStore } from "react"
import { asEventConfig, DEFAULT_EVENT, TIME_ZONES, type EventConfig } from "@/lib/event"

const STORAGE_KEY = "hyphen-countdown-event"

const listeners = new Set<() => void>()
let memory: EventConfig | null = null

export { asEventConfig }

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
    const config = asEventConfig(parsed)
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
    badge: overrides.badge?.trim() || stored?.badge || DEFAULT_EVENT.badge,
    rsvpLabel: overrides.rsvpLabel?.trim() || stored?.rsvpLabel || DEFAULT_EVENT.rsvpLabel,
    scanLabel: overrides.scanLabel?.trim() || stored?.scanLabel || DEFAULT_EVENT.scanLabel,
    joinLabel: overrides.joinLabel?.trim() || stored?.joinLabel || DEFAULT_EVENT.joinLabel,
    eventLink: overrides.eventLink?.trim() || stored?.eventLink || DEFAULT_EVENT.eventLink,
    eventLinkLabel: overrides.eventLinkLabel?.trim() || stored?.eventLinkLabel || DEFAULT_EVENT.eventLinkLabel,
    xUrl: overrides.xUrl?.trim() || stored?.xUrl || DEFAULT_EVENT.xUrl,
    facebookUrl: overrides.facebookUrl?.trim() || stored?.facebookUrl || DEFAULT_EVENT.facebookUrl,
    linkedinUrl: overrides.linkedinUrl?.trim() || stored?.linkedinUrl || DEFAULT_EVENT.linkedinUrl,
    instagramUrl: overrides.instagramUrl?.trim() || stored?.instagramUrl || DEFAULT_EVENT.instagramUrl,
    youtubeUrl: overrides.youtubeUrl?.trim() || stored?.youtubeUrl || DEFAULT_EVENT.youtubeUrl,
  }
}
