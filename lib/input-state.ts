/**
 * Per-input state (HEALTHY / SUSPECT / FAILED) and the READY checklist. Pure, client-safe.
 * FAILED = not publishing or no data for the stall threshold (only that fails over).
 * SUSPECT = a brief hiccup: data gap shorter than the stall, bitrate collapse, or fps drop.
 */
import type { SourceHealth } from "@/lib/program-source"

export type InputStats = {
  /** measured video fps over the last second, and the lowest over the last 10s */
  fps: number | null
  fpsMin: number | null
  /** frame rate the stream declares */
  fpsNominal: number | null
  video: boolean
  audio: { hz: number; channels: string; codec: string } | null
}
export const EMPTY_STATS: InputStats = { fps: null, fpsMin: null, fpsNominal: null, video: false, audio: null }
export type InputState = "healthy" | "suspect" | "failed"
export type InputReadout = SourceHealth & { state: InputState; stateReason: string | null; stats?: InputStats; ready48?: boolean; readyOk: boolean; issues: string[]; kbpsBaseline?: number | null; jitterMs?: number | null; audioDelayMs?: number | null; offsetMs?: number | null }

export const GAP_SUSPECT_MS = 1000

export function inputState(h: SourceHealth, stats: InputStats | null, kbpsBaseline: number | null, stallMs: number): { state: InputState; reason: string | null } {
  if (!h.ready) return { state: "failed", reason: "not publishing" }
  if (h.dataAgeMs !== null && h.dataAgeMs >= stallMs) return { state: "failed", reason: `no data ${Math.round(h.dataAgeMs / 1000)}s` }
  if (h.dataAgeMs !== null && h.dataAgeMs >= GAP_SUSPECT_MS) return { state: "suspect", reason: `data gap ${(h.dataAgeMs / 1000).toFixed(1)}s` }
  if (kbpsBaseline && kbpsBaseline > 200 && h.kbps !== null && h.kbps < kbpsBaseline * 0.3) return { state: "suspect", reason: `bitrate dropped to ${h.kbps} kb/s (usual ${Math.round(kbpsBaseline)})` }
  const nominal = stats?.fpsNominal ?? null
  if (nominal && stats?.fps !== null && stats?.fps !== undefined && stats.fps < nominal * 0.8) return { state: "suspect", reason: `fps ${stats.fps} (expected ${nominal})` }
  return { state: "healthy", reason: null }
}

/** Green READY only with video + audio, fps stable, data fresh, audio 48 kHz. */
export function readiness(h: SourceHealth, stats: InputStats | null): { ok: boolean; issues: string[] } {
  const issues: string[] = []
  if (!h.ready) return { ok: false, issues: ["no signal"] }
  if (h.dataAgeMs === null || h.dataAgeMs >= GAP_SUSPECT_MS) issues.push("data not fresh")
  if (!stats?.video) issues.push("no video")
  if (!stats?.audio) issues.push("no audio")
  else if (stats.audio.hz !== 48000) issues.push(`audio ${stats.audio.hz / 1000} kHz (need 48)`)
  const nominal = stats?.fpsNominal ?? null
  if (stats?.video && (stats.fps === null || stats.fpsMin === null || (nominal && stats.fpsMin < nominal * 0.8))) issues.push("fps not stable")
  return { ok: issues.length === 0, issues }
}

/** Kb/s baseline: slow EMA over healthy seconds only. */
export function nextBaseline(prev: number | null, kbps: number | null, state: InputState): number | null {
  if (kbps === null || state !== "healthy") return prev
  return prev === null ? kbps : prev * 0.95 + kbps * 0.05
}

/** Parse ffmpeg's stream lines. */
export function parseStreamInfo(line: string): Partial<Pick<InputStats, "fpsNominal" | "audio">> & { video?: boolean } {
  const out: Partial<Pick<InputStats, "fpsNominal" | "audio">> & { video?: boolean } = {}
  if (/Stream #\d+:\d+.*: Video:/.test(line)) {
    out.video = true
    const m = /([\d.]+) fps/.exec(line) ?? /([\d.]+) tbr/.exec(line)
    if (m) out.fpsNominal = Math.round(Number(m[1]) * 100) / 100
  }
  const a = /Stream #\d+:\d+.*: Audio: (\w+).*?, (\d+) Hz, ([\w.()]+)/.exec(line)
  if (a) out.audio = { codec: a[1], hz: Number(a[2]), channels: a[3] }
  return out
}
