export const DEFAULT_EVENT = {
  name: "Hyphen Festival 2026",
  date: "2026-11-04",
  time: "09:30",
  endTime: "16:15",
  timeZone: "Europe/London",
  venue: "One Great George Street, London, United Kingdom",
  rsvpUrl: "https://events.hyphenonline.com/HyphenFestival2026#/buyTickets",
  badge: "Live Countdown",
  rsvpLabel: "RSVP - Open",
  scanLabel: "Scan to join",
  joinLabel: "Join Live",
  eventLink: "https://events.hyphenonline.com/HyphenFestival2026",
  eventLinkLabel: "events.hyphenonline.com/HyphenFestival2026",
  xUrl: "https://x.com/onlinehyphen",
  facebookUrl: "https://facebook.com/onlinehyphen",
  linkedinUrl: "https://linkedin.com/company/hyphenonline",
  instagramUrl: "https://instagram.com/onlinehyphen?hl=en",
  youtubeUrl: "https://www.youtube.com/@hyphenonline",
} as const

export const TIME_ZONES = [
  { id: "Europe/Berlin", label: "Central Europe (CET/CEST)" },
  { id: "Europe/Bucharest", label: "Bucharest (EET/EEST)" },
  { id: "Europe/London", label: "London (GMT/BST)" },
  { id: "UTC", label: "UTC" },
  { id: "America/New_York", label: "New York (ET)" },
  { id: "America/Los_Angeles", label: "Los Angeles (PT)" },
] as const

const ZONE_IDS = new Set<string>(TIME_ZONES.map((zone) => zone.id))

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** YYYY-MM-DD that is a real calendar day. */
export function isValidDate(value: string): boolean {
  const match = DATE_RE.exec(value)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/** 24h HH:MM. */
export function isValidTime(value: string): boolean {
  return TIME_RE.test(value)
}

/** Human-readable reasons an event payload would be rejected. Empty when valid. */
export function eventProblems(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["Event payload is missing."]
  const record = value as Record<string, unknown>
  const problems: string[] = []
  if (typeof record.name !== "string" || !record.name.trim()) problems.push("Event name is empty.")
  if (typeof record.date !== "string" || !isValidDate(record.date)) problems.push(`Start date "${String(record.date ?? "")}" is not a valid YYYY-MM-DD date.`)
  if (typeof record.time !== "string" || !isValidTime(record.time)) problems.push(`Start time "${String(record.time ?? "")}" is not a valid HH:MM time.`)
  if (typeof record.endTime === "string" && record.endTime && !isValidTime(record.endTime)) problems.push(`End time "${record.endTime}" is not a valid HH:MM time.`)
  if (typeof record.timeZone !== "string" || !ZONE_IDS.has(record.timeZone)) problems.push(`Time zone "${String(record.timeZone ?? "")}" is not supported.`)
  return problems
}

/**
 * Only http(s) links pass. Relative paths ("/brand/x.png") and raster data:image
 * URLs are allowed when the caller opts in. Anything else (javascript:, data:text,
 * vbscript:, protocol-relative //host) returns the fallback.
 */
export function safeUrl(value: unknown, fallback = "", options: { relative?: boolean; dataImage?: boolean } = {}): string {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  if (options.relative && /^\/(?![\/\\])/.test(trimmed)) return trimmed
  if (options.dataImage && /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : fallback
  } catch {
    return fallback
  }
}

export type SpeakerCard = { image: string; name: string; description: string }

/** Coerce an unknown value into at most 12 well-formed speaker cards with safe images. */
export function sanitizeSpeakers(value: unknown): SpeakerCard[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 12).map((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {}
    return {
      image: safeUrl(record.image, "", { relative: true, dataImage: true }),
      name: typeof record.name === "string" ? record.name : "",
      description: typeof record.description === "string" ? record.description : "",
    }
  }).filter((item) => item.image || item.name || item.description)
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

export function asEventConfig(value: unknown): EventConfig | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const name = readString(record, "name")
  const date = readString(record, "date")
  const time = readString(record, "time")
  const timeZone = readString(record, "timeZone")
  if (!name || !date || !time || !timeZone || !ZONE_IDS.has(timeZone)) return null
  if (!isValidDate(date) || !isValidTime(time)) return null
  const endTime = readString(record, "endTime")
  const link = (key: string, fallback: string) => safeUrl(readString(record, key), fallback)

  return {
    name,
    date,
    time,
    timeZone,
    endTime: endTime && isValidTime(endTime) ? endTime : DEFAULT_EVENT.endTime,
    venue: readString(record, "venue") || DEFAULT_EVENT.venue,
    rsvpUrl: link("rsvpUrl", DEFAULT_EVENT.rsvpUrl),
    badge: readString(record, "badge") || DEFAULT_EVENT.badge,
    rsvpLabel: readString(record, "rsvpLabel") || DEFAULT_EVENT.rsvpLabel,
    scanLabel: readString(record, "scanLabel") || DEFAULT_EVENT.scanLabel,
    joinLabel: readString(record, "joinLabel") || DEFAULT_EVENT.joinLabel,
    eventLink: link("eventLink", DEFAULT_EVENT.eventLink),
    eventLinkLabel: readString(record, "eventLinkLabel") || DEFAULT_EVENT.eventLinkLabel,
    xUrl: link("xUrl", DEFAULT_EVENT.xUrl),
    facebookUrl: link("facebookUrl", DEFAULT_EVENT.facebookUrl),
    linkedinUrl: link("linkedinUrl", DEFAULT_EVENT.linkedinUrl),
    instagramUrl: link("instagramUrl", DEFAULT_EVENT.instagramUrl),
    youtubeUrl: link("youtubeUrl", DEFAULT_EVENT.youtubeUrl),
  }
}

export type EventConfig = {
  name: string
  date: string
  time: string
  endTime: string
  timeZone: string
  venue: string
  rsvpUrl: string
  badge: string
  rsvpLabel: string
  scanLabel: string
  joinLabel: string
  eventLink: string
  eventLinkLabel: string
  xUrl: string
  facebookUrl: string
  linkedinUrl: string
  instagramUrl: string
  youtubeUrl: string
}
