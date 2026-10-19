/**
 * Dropout diagnostics: one timestamped line per event that can explain a black / frozen / stuttering
 * YouTube output, to the terminal and to logs/dropouts-YYYY-MM-DD.log (London time, one file a day,
 * 14 days kept, 20 MB cap per file). Read it with `npm run dropouts` (incidents with everything ±5s).
 *
 * Line: "2026-10-19 10:59:01.234 ! [relay] Main /program publisher gone (closed: EOF)"
 *   level  "!" = a problem (an incident), "+" = recovered, "·" = context (switches, info)
 * Never writes secrets: callers pass plain text without URLs/keys; redact() strips any that slip in.
 */
import fs from "node:fs"
import path from "node:path"

export type DropLevel = "!" | "+" | "·"
export type DropCategory = "relay" | "ingest" | "player" | "switch" | "rearm" | "capture" | "push" | "srt" | "server" | "operator"
export const DROP_ZONE = "Europe/London"
const MAX_BYTES = 20_000_000
const KEEP_DAYS = 14

export const dropoutDir = () => process.env.DROPOUT_LOG_DIR || path.join(process.cwd(), "logs")

/** London wall time parts (the log's zone, whatever the machine's TZ). */
export function londonParts(ms: number): { date: string; time: string } {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: DROP_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}.${String(ms % 1000).padStart(3, "0")}` }
}

/** rtmp://host/app/KEY → rtmp://host/••••, user/pass query strings, passphrases. */
export function redact(text: string): string {
  return text
    .replace(/((?:rtmps?|srt|https?):\/\/[^\s/'"?]+)[^\s'"]*/gi, "$1/••••")
    .replace(/\b(pass(?:word|phrase)?|key|streamid|user)=([^\s&'"]+)/gi, "$1=••••")
}

export function dropoutLine(ms: number, level: DropLevel, cat: DropCategory, msg: string): string {
  const { date, time } = londonParts(ms)
  return `${date} ${time} ${level} [${cat}] ${redact(msg).replace(/[\r\n]+/g, " ")}`
}

export type DropEvent = { at: number; level: DropLevel; cat: string; msg: string; line: string }
const LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) ([!+·]) \[([a-z]+)\] (.*)$/

/** London wall time → epoch ms (DST-aware: tries both UTC+0 and UTC+1). */
export function londonToMs(date: string, h: number, m: number, s: number, ms: number): number {
  const [y, mo, d] = date.split("-").map(Number)
  for (const off of [0, 1]) {
    const guess = Date.UTC(y, mo - 1, d, h - off, m, s, ms)
    const back = londonParts(guess)
    if (back.date === date && back.time.startsWith(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`)) return guess
  }
  return Date.UTC(y, mo - 1, d, h, m, s, ms)
}

export function parseDropoutLog(text: string): DropEvent[] {
  const out: DropEvent[] = []
  for (const line of text.split("\n")) {
    const m = LINE.exec(line.trim())
    if (!m) continue
    out.push({ at: londonToMs(m[1], +m[2], +m[3], +m[4], +m[5]), level: m[6] as DropLevel, cat: m[7], msg: m[8], line: line.trim() })
  }
  return out.sort((a, b) => a.at - b.at)
}

export type Incident = { from: number; to: number; problems: DropEvent[]; context: DropEvent[] }
/**
 * Pure: problems ("!") within `windowMs` of each other form one incident; each incident lists every
 * event (any level, any source) from windowMs before its first problem to windowMs after its last.
 */
export function correlate(events: DropEvent[], windowMs = 5000): Incident[] {
  const sorted = [...events].sort((a, b) => a.at - b.at)
  const incidents: Incident[] = []
  for (const e of sorted) {
    if (e.level !== "!") continue
    const cur = incidents.at(-1)
    if (cur && e.at - cur.to <= windowMs) { cur.to = e.at; cur.problems.push(e) }
    else incidents.push({ from: e.at, to: e.at, problems: [e], context: [] })
  }
  for (const inc of incidents) inc.context = sorted.filter((e) => e.at >= inc.from - windowMs && e.at <= inc.to + windowMs)
  return incidents
}

/** Operator "Mark blackout" taps (seen on YouTube, which runs behind the local output). */
export const isMark = (e: DropEvent) => e.cat === "operator" && /blackout marked/.test(e.msg)
/** YouTube shows things later than they happen here, so a mark looks back further than forward. */
export const MARK_BEFORE_MS = 15_000
export const MARK_AFTER_MS = 5_000
export type MarkIncident = { mark: DropEvent; context: DropEvent[] }
/** Pure: each operator mark with every event from `beforeMs` before to `afterMs` after it (newest last). */
export function markIncidents(events: DropEvent[], beforeMs = MARK_BEFORE_MS, afterMs = MARK_AFTER_MS): MarkIncident[] {
  const sorted = [...events].sort((a, b) => a.at - b.at)
  return sorted.filter(isMark).map((mark) => ({ mark, context: sorted.filter((e) => e.at >= mark.at - beforeMs && e.at <= mark.at + afterMs) }))
}
/** Plain text for one marked incident (desk copy button and `npm run dropouts`). */
export function formatMark(inc: MarkIncident, indent = ""): string {
  const head = `${indent}Blackout marked ${londonParts(inc.mark.at).time.slice(0, 8)} (London) · ${inc.mark.msg.replace(/^blackout marked /, "")} · events −${MARK_BEFORE_MS / 1000}s…+${MARK_AFTER_MS / 1000}s (YouTube runs several seconds behind the local output, so the cause is usually before the mark)`
  const rows = inc.context.map((e) => {
    const rel = (e.at - inc.mark.at) / 1000
    return `${indent}  ${londonParts(e.at).time} ${rel >= 0 ? "+" : "−"}${Math.abs(rel).toFixed(1).padStart(4)}s ${e.level} [${e.cat}] ${e.msg}`
  })
  return [head, ...rows].join("\n")
}
/** Server: today's (and yesterday's, around midnight) events since `sinceMs`. */
export function readDropoutEvents(sinceMs: number, now = Date.now()): DropEvent[] {
  const dir = dropoutDir()
  const days = new Set([londonParts(now).date, londonParts(sinceMs).date])
  let text = ""
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      const m = /^dropouts-(\d{4}-\d{2}-\d{2})/.exec(name)
      if (m && days.has(m[1])) text += `${fs.readFileSync(path.join(dir, name), "utf8")}\n`
    }
  } catch { return [] }
  return parseDropoutLog(text).filter((e) => e.at >= sinceMs)
}

const KEY = Symbol.for("stream-timer.dropout-log")
type Holder = { [KEY]?: { prunedFor: string | null } }

/** Write one event: terminal + today's file. Best effort (diagnostics never break the show). */
export function dlog(level: DropLevel, cat: DropCategory, msg: string, at = Date.now()) {
  const line = dropoutLine(at, level, cat, msg)
  console.log(`${londonParts(at).time.slice(0, 8)} [dropout] ${line.slice(24)}`)
  try {
    const dir = dropoutDir()
    fs.mkdirSync(dir, { recursive: true })
    const day = londonParts(at).date
    const file = path.join(dir, `dropouts-${day}.log`)
    try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file.replace(/\.log$/, `.${Date.now()}.log`)) } catch { /* new file */ }
    fs.appendFileSync(file, `${line}\n`)
    const h = globalThis as Holder
    h[KEY] ??= { prunedFor: null }
    if (h[KEY].prunedFor !== day) {
      h[KEY].prunedFor = day
      for (const name of fs.readdirSync(dir)) {
        const m = /^dropouts-(\d{4}-\d{2}-\d{2})/.exec(name)
        if (m && Date.parse(m[1]) < at - KEEP_DAYS * 86_400_000) fs.rmSync(path.join(dir, name), { force: true })
      }
    }
  } catch { /* disk full / read-only: terminal only */ }
}
