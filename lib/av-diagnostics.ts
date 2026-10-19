/**
 * A/V diagnostics (read-only): frame timecode for TC1, and the drift-test log (data/av-log.jsonl).
 * Pure helpers here; file IO in av-log.ts. Nothing in this module changes sync behaviour.
 */
export const TC_FPS = [25, 30, 50, 60] as const
export type TcFps = (typeof TC_FPS)[number]

export function parseFps(value: unknown, fallback: TcFps = 30): TcFps {
  const n = Number(value)
  return (TC_FPS as readonly number[]).includes(n) ? (n as TcFps) : fallback
}

const p2 = (n: number) => String(n).padStart(2, "0")

/** HH:MM:SS:FF of local wall-clock time `ms` (tzOffsetMin = minutes east of UTC), FF = floor(ms-in-second × fps / 1000). */
export function frameTimecode(ms: number, fps: TcFps, tzOffsetMin = 0): string {
  const local = ms + tzOffsetMin * 60_000
  const day = ((local % 86_400_000) + 86_400_000) % 86_400_000
  const sec = Math.floor(day / 1000)
  const frame = Math.floor(((day % 1000) * fps) / 1000)
  return `${p2(Math.floor(sec / 3600))}:${p2(Math.floor(sec / 60) % 60)}:${p2(sec % 60)}:${p2(frame)}`
}

export type AvLive = {
  /** capture's /stream program player: live latency behind the OBS edge */
  playerLatencyMs: number | null
  /** adaptive program-audio delay target in capture */
  audioDelayMs: number | null
  /** per-input auto offset (capture) */
  autoOffsetMs: number | null
  /** operator offsets (audio settings): A/V offset + per-input program offset */
  avOffsetMs: number
  programOffsetMs: number
  source: "main" | "backup"
  mixing: boolean
  jitterMs: number | null
  /** network RTT to each program publisher (last sample) and loss % over the last minute */
  rttMainMs?: number | null
  rttMainLossPct?: number | null
  rttBackupMs?: number | null
  rttBackupLossPct?: number | null
}

export type AvSample = AvLive & { at: number; iso: string; readingMs: number | null; /** typed: audio marker vs picture at the output, ms (+ = audio late) */ audioOffsetMs?: number | null; note: string }

const typedMs = (v: unknown) => {
  const r = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(r) && Math.abs(r) <= 600_000 ? Math.round(r) : null
}

export function makeSample(live: AvLive, input: { readingMs?: unknown; audioOffsetMs?: unknown; note?: unknown }, now = Date.now()): AvSample {
  return {
    at: now,
    iso: new Date(now).toISOString(),
    ...live,
    readingMs: typedMs(input.readingMs),
    audioOffsetMs: typedMs(input.audioOffsetMs),
    note: typeof input.note === "string" ? input.note.replace(/[\r\n]+/g, " ").slice(0, 200) : "",
  }
}

export const CSV_COLUMNS = ["iso", "at", "playerLatencyMs", "audioDelayMs", "autoOffsetMs", "avOffsetMs", "programOffsetMs", "source", "mixing", "jitterMs", "rttMainMs", "rttMainLossPct", "rttBackupMs", "rttBackupLossPct", "readingMs", "audioOffsetMs", "note"] as const

function cell(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = String(v)
  // quote, and neutralise spreadsheet formulas
  const safe = /^[=+\-@\t]/.test(s) && typeof v === "string" && !/^-?\d/.test(s) ? `'${s}` : s
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function samplesToCsv(samples: AvSample[]): string {
  return [CSV_COLUMNS.join(","), ...samples.map((s) => CSV_COLUMNS.map((c) => cell(s[c])).join(","))].join("\n") + "\n"
}

export function parseJsonl(text: string): AvSample[] {
  const out: AvSample[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line) as AvSample
      if (v && typeof v.at === "number") out.push(v)
    } catch { /* skip a torn line */ }
  }
  return out
}

/** Pull the capture's programAudio numbers out of relayStatus() (loose: older capture builds miss fields). */
export function liveFromStatus(programAudio: Record<string, unknown> | null | undefined, offsets: { avOffsetMs: number; programOffsetMs: { main: number; backup: number } }, active: "main" | "backup"): AvLive {
  const pa = programAudio ?? {}
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null)
  const source = pa.source === "backup" || pa.source === "main" ? pa.source : active
  const auto = pa.offsetMs && typeof pa.offsetMs === "object" ? num((pa.offsetMs as Record<string, unknown>)[source]) : null
  return {
    playerLatencyMs: num(pa.playerLatencyMs),
    audioDelayMs: num(pa.delayMs),
    autoOffsetMs: auto,
    avOffsetMs: offsets.avOffsetMs,
    programOffsetMs: offsets.programOffsetMs[source] ?? 0,
    source,
    mixing: pa.mixing === true,
    jitterMs: num(pa.jitterMs),
  }
}

// ---------- TC1 audio marker (/overlay/timecode?beep=1) ----------

export const BEEP_EVERY = [1, 5, 10] as const
/** Distinct from the /stream sync beep (1 kHz, 100 ms): short 1.5 kHz, 3 kHz on the minute. */
export const TC_BEEP = { hz: 1500, minuteHz: 3000, ms: 40 } as const
export const TC_FLASH_MS = 100

export function parseBeepEvery(value: unknown): number {
  const n = Number(value)
  return (BEEP_EVERY as readonly number[]).includes(n) ? n : 1
}
export function parseVol(value: unknown, fallback = 0.5): number {
  const n = Number(value)
  return value === null || value === undefined || value === "" || !Number.isFinite(n) ? fallback : Math.min(1, Math.max(0, n))
}

/**
 * Wall-clock instants to beep in (fromMs, toMs]: whole seconds that are multiples of `everyS`,
 * in local time (tzOffsetMin = minutes east of UTC, so "on the minute" matches what TC1 displays).
 */
export function beepTimes(fromMs: number, toMs: number, everyS: number, tzOffsetMin = 0): { at: number; minute: boolean }[] {
  const step = everyS * 1000
  const tz = tzOffsetMin * 60_000
  const out: { at: number; minute: boolean }[] = []
  for (let local = Math.floor((fromMs + tz) / step) * step + step; local <= toMs + tz; local += step) {
    out.push({ at: local - tz, minute: ((local % 60_000) + 60_000) % 60_000 === 0 })
  }
  return out
}

/** AudioContext time at which a wall-clock instant reaches the speaker (anchor sampled together; minus output latency). */
export function ctxTimeFor(atMs: number, anchor: { wallMs: number; ctxTime: number }, outputLatencyS = 0): number {
  return anchor.ctxTime + (atMs - anchor.wallMs) / 1000 - outputLatencyS
}

/** Visual flash window: the first TC_FLASH_MS of each beep instant. */
export function flashOn(nowMs: number, everyS: number, tzOffsetMin = 0): boolean {
  const local = nowMs + tzOffsetMin * 60_000
  const step = everyS * 1000
  return ((local % step) + step) % step < TC_FLASH_MS
}

// ---------- TC1 variants: main (OBS computer 1) / backup (OBS computer 2) ----------

export type TcSrc = "main" | "backup"
export const TC_VARIANT: Record<TcSrc, { label: string; pos: "bottom-right" | "bottom-left"; hz: number; minuteHz: number; border: string }> = {
  main: { label: "OBS SRC", pos: "bottom-right", hz: TC_BEEP.hz, minuteHz: TC_BEEP.minuteHz, border: "rgba(255,255,255,0.9)" },
  backup: { label: "BACKUP SRC", pos: "bottom-left", hz: 1200, minuteHz: 2400, border: "#f5a524" },
}
export function parseTcSrc(value: unknown): TcSrc {
  return value === "backup" ? "backup" : "main"
}
/** ?label= override: printable, max 16 chars, uppercase; else the variant's label. */
export function tcLabel(custom: unknown, src: TcSrc): string {
  const v = typeof custom === "string" ? custom.replace(/[^\p{L}\p{N} ._\-#/]/gu, "").trim().slice(0, 16).toUpperCase() : ""
  return v || TC_VARIANT[src].label
}
