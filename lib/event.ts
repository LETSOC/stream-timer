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

  return {
    name,
    date,
    time,
    timeZone,
    endTime: readString(record, "endTime") || DEFAULT_EVENT.endTime,
    venue: readString(record, "venue") || DEFAULT_EVENT.venue,
    rsvpUrl: readString(record, "rsvpUrl") || DEFAULT_EVENT.rsvpUrl,
    badge: readString(record, "badge") || DEFAULT_EVENT.badge,
    rsvpLabel: readString(record, "rsvpLabel") || DEFAULT_EVENT.rsvpLabel,
    scanLabel: readString(record, "scanLabel") || DEFAULT_EVENT.scanLabel,
    joinLabel: readString(record, "joinLabel") || DEFAULT_EVENT.joinLabel,
    eventLink: readString(record, "eventLink") || DEFAULT_EVENT.eventLink,
    eventLinkLabel: readString(record, "eventLinkLabel") || DEFAULT_EVENT.eventLinkLabel,
    xUrl: readString(record, "xUrl") || DEFAULT_EVENT.xUrl,
    facebookUrl: readString(record, "facebookUrl") || DEFAULT_EVENT.facebookUrl,
    linkedinUrl: readString(record, "linkedinUrl") || DEFAULT_EVENT.linkedinUrl,
    instagramUrl: readString(record, "instagramUrl") || DEFAULT_EVENT.instagramUrl,
    youtubeUrl: readString(record, "youtubeUrl") || DEFAULT_EVENT.youtubeUrl,
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
