export type Remaining = {
  totalMs: number
  totalSeconds: number
  days: number
  hours: number
  minutes: number
  seconds: number
  done: boolean
}

export function remainingUntil(target: Date, now: Date): Remaining {
  const totalMs = target.getTime() - now.getTime()
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return {
      totalMs: 0,
      totalSeconds: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      done: true,
    }
  }

  const totalSeconds = Math.floor(totalMs / 1000)
  return {
    totalMs,
    totalSeconds,
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60,
    done: false,
  }
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** FFmpeg filter option separator is `:`. Unescaped colons cause "No option name near …". */
export function escapeDrawtext(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll(",", "\\,")
    .replaceAll("%", "%%")
    .replaceAll("'", "\\'")
}

export function getTimeZoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs))

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)

  const asWallUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  )

  return (asWallUtc - utcMs) / 60_000
}

/** Interpret a wall-clock date/time in an IANA time zone. */
export function wallTimeInZone(
  date: string,
  time: string,
  timeZone: string,
): Date {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time)
  if (!dateMatch || !timeMatch) {
    return new Date(NaN)
  }

  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0)

  let utcMs = wallAsUtc - getTimeZoneOffsetMinutes(wallAsUtc, timeZone) * 60_000
  const adjustedOffset = getTimeZoneOffsetMinutes(utcMs, timeZone)
  utcMs = wallAsUtc - adjustedOffset * 60_000
  return new Date(utcMs)
}

const ZONE_ABBREV: Record<string, { standard: string; dst: string }> = {
  "Europe/Berlin": { standard: "CET", dst: "CEST" },
  "Europe/Bucharest": { standard: "EET", dst: "EEST" },
  "Europe/London": { standard: "GMT", dst: "BST" },
  UTC: { standard: "UTC", dst: "UTC" },
  "America/New_York": { standard: "EST", dst: "EDT" },
  "America/Los_Angeles": { standard: "PST", dst: "PDT" },
}

export function timeZoneAbbreviation(date: Date, timeZone: string): string {
  const known = ZONE_ABBREV[timeZone]
  const current = getTimeZoneOffsetMinutes(date.getTime(), timeZone)
  if (!known) {
    const hours = Math.trunc(current / 60)
    if (hours === 0) return "UTC"
    return `UTC${hours > 0 ? "+" : "-"}${Math.abs(hours)}`
  }

  const year = date.getUTCFullYear()
  const january = getTimeZoneOffsetMinutes(Date.UTC(year, 0, 1), timeZone)
  const july = getTimeZoneOffsetMinutes(Date.UTC(year, 6, 1), timeZone)
  const inDst = january !== july && current === Math.max(january, july)
  return inDst ? known.dst : known.standard
}

export function formatDateLine(date: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date)

  return formatted.replace(",", "  • ")
}

/** Banner date as on the Hyphen site: "Wed, 04 Nov, 2026". */
export function formatBannerDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).formatToParts(date)
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ""
  return `${read("weekday")}, ${read("day")} ${read("month")}, ${read("year")}`
}

export function formatTimeRange(start: string, end: string): string {
  const cleanEnd = end.trim()
  if (!cleanEnd) return start
  return `${start} – ${cleanEnd}`
}

export function splitEventTitle(name: string): { lead: string; year: string | null } {
  const match = /^(.*?)(?:\s+)(\d{4})$/.exec(name.trim())
  if (!match) return { lead: name.trim() || "Untitled event", year: null }
  return { lead: match[1], year: match[2] }
}

export function formatClock(date: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date)

  return `${formatted.replaceAll(",", "")} ${timeZoneAbbreviation(date, timeZone)}`
}
