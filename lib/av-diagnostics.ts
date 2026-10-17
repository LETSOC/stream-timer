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
}

export type AvSample = AvLive & { at: number; iso: string; readingMs: number | null; note: string }

export function makeSample(live: AvLive, input: { readingMs?: unknown; note?: unknown }, now = Date.now()): AvSample {
  const r = typeof input.readingMs === "number" ? input.readingMs : typeof input.readingMs === "string" && input.readingMs.trim() ? Number(input.readingMs) : NaN
  return {
    at: now,
    iso: new Date(now).toISOString(),
    ...live,
    readingMs: Number.isFinite(r) && Math.abs(r) <= 600_000 ? Math.round(r) : null,
    note: typeof input.note === "string" ? input.note.replace(/[\r\n]+/g, " ").slice(0, 200) : "",
  }
}

export const CSV_COLUMNS = ["iso", "at", "playerLatencyMs", "audioDelayMs", "autoOffsetMs", "avOffsetMs", "programOffsetMs", "source", "mixing", "jitterMs", "readingMs", "note"] as const

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
