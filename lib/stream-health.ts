/**
 * Live stream health: parses ffmpeg progress (forwards: `-progress pipe:1` blocks; slate and
 * capture: the stats line), turns it into fps / kbps / speed over the last few seconds, flags
 * green / amber / red, and writes a one-line diagnosis of where a problem most likely is.
 * Pure functions only; the callers read logs / stats files.
 */

export type Level = "ok" | "warn" | "bad" | "idle"
export type HealthStats = {
  fps: number | null
  kbps: number | null
  speed: number | null
  dup: number | null
  drop: number | null
  bytes: number | null
  /** ms since ffmpeg last reported. */
  ageMs: number | null
  level: Level
  warnings: string[]
}
export const EMPTY_HEALTH: HealthStats = { fps: null, kbps: null, speed: null, dup: null, drop: null, bytes: null, ageMs: null, level: "idle", warnings: [] }

type Sample = { frame: number; bytes: number; outUs: number; dup: number; drop: number; fps: number | null; speed: number | null }

const num = (value: string | undefined) => {
  if (value === undefined) return null
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : null
}

/** `-progress` key=value blocks, each ending in progress=continue|end. */
export function parseProgressBlocks(text: string): Sample[] {
  const out: Sample[] = []
  let cur: Record<string, string> = {}
  for (const raw of text.split(/[\r\n]+/)) {
    const m = /^([a-z_0-9]+)=(.*)$/.exec(raw.trim())
    if (!m) continue
    cur[m[1]] = m[2].trim()
    if (m[1] === "progress") {
      const frame = num(cur.frame)
      const bytes = num(cur.total_size)
      const outUs = num(cur.out_time_us) ?? num(cur.out_time_ms)
      if (frame !== null && bytes !== null && outUs !== null) out.push({ frame, bytes, outUs, dup: num(cur.dup_frames) ?? 0, drop: num(cur.drop_frames) ?? 0, fps: num(cur.fps), speed: num(cur.speed?.replace("x", "")) })
      cur = {}
    }
  }
  return out
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1000, kib: 1024, mb: 1e6, mib: 1048576, gb: 1e9, gib: 1073741824 }
/** ffmpeg's stats line: "frame= 300 fps= 30 q=… size= 1234KiB time=00:00:10.00 bitrate=2500.0kbits/s dup=0 drop=0 speed=1.0x". */
export function parseStatsLines(text: string): Sample[] {
  const out: Sample[] = []
  for (const line of text.split(/[\r\n]+/)) {
    const frame = /frame=\s*(\d+)/.exec(line)
    const time = /time=\s*(-?\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
    const size = /size=\s*(\d+(?:\.\d+)?)\s*([kKmMgG]i?B|B)/.exec(line)
    if (!frame || !time || !size) continue
    const outUs = ((Number(time[1]) * 60 + Number(time[2])) * 60 + Number(time[3])) * 1e6
    out.push({
      frame: Number(frame[1]),
      bytes: Number(size[1]) * (SIZE_UNITS[size[2].toLowerCase()] ?? 1),
      outUs,
      dup: num(/dup=\s*(\d+)/.exec(line)?.[1]) ?? 0,
      drop: num(/drop=\s*(\d+)/.exec(line)?.[1]) ?? 0,
      fps: num(/fps=\s*([\d.]+)/.exec(line)?.[1]),
      speed: num(/speed=\s*([\d.]+)x/.exec(line)?.[1]),
    })
  }
  return out
}

export type Expect = { fps: number; kbps: number | null }

/**
 * Rates over the last `window` report periods (each `periodSec` of wall time apart, ffmpeg's
 * -stats_period), and the flags: speed < 0.97, fps < target − 2, bitrate falling (below 75% of the
 * longer-run average, or below 70% of what the encoder is set to send), no report for 3 periods.
 */
export function healthFromSamples(samples: Sample[], periodSec: number, ageMs: number | null, expect: Expect, window = 2): HealthStats {
  if (samples.length === 0) return { ...EMPTY_HEALTH, ageMs }
  const last = samples[samples.length - 1]
  const base = { dup: last.dup, drop: last.drop, bytes: last.bytes, ageMs: ageMs === null ? null : Math.round(ageMs) }
  let fps: number | null = last.fps
  let kbps: number | null = null
  let speed: number | null = last.speed
  let longKbps: number | null = null
  // Restarted ffmpeg = counters went back: only use the run since then.
  let start = samples.length - 1
  while (start > 0 && samples[start - 1].frame <= samples[start].frame && samples[start - 1].bytes <= samples[start].bytes) start--
  const run = samples.slice(start)
  if (run.length >= 2) {
    const from = run[Math.max(0, run.length - 1 - window)]
    const secs = (run.length - 1 - run.indexOf(from)) * periodSec
    fps = (last.frame - from.frame) / secs
    kbps = ((last.bytes - from.bytes) * 8) / secs / 1000
    speed = (last.outUs - from.outUs) / 1e6 / secs
    if (run.length >= window + 3) {
      const first = run[0]
      longKbps = ((last.bytes - first.bytes) * 8) / ((run.length - 1) * periodSec) / 1000
    }
  }
  const warnings: string[] = []
  let level: Level = "ok"
  const flag = (bad: boolean, text: string) => {
    warnings.push(text)
    if (bad) level = "bad"
    else if (level === "ok") level = "warn"
  }
  if (ageMs !== null && ageMs > periodSec * 3000 + 2000) flag(true, `no report for ${Math.round(ageMs / 1000)}s`)
  if (speed !== null && speed < 0.97) flag(speed < 0.9, `speed ${speed.toFixed(2)}x`)
  if (fps !== null && fps < expect.fps - 2) flag(fps < expect.fps * 0.8, `${fps.toFixed(1)} fps (want ${expect.fps})`)
  if (kbps !== null && longKbps !== null && kbps < longKbps * 0.75) flag(kbps < longKbps * 0.5, `bitrate falling (${Math.round(kbps)}k vs ${Math.round(longKbps)}k avg)`)
  else if (kbps !== null && expect.kbps && run.length >= 3 && kbps < expect.kbps * 0.7) flag(kbps < expect.kbps * 0.5, `bitrate ${Math.round(kbps)}k (set ${expect.kbps}k)`)
  return { ...base, fps: round(fps, 1), kbps: kbps === null ? null : Math.round(kbps), speed: round(speed, 2), level, warnings }
}

function round(value: number | null, digits: number) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits))
}

/** What the capture process reports about itself (scripts/capture-stream.mjs → CAPTURE_STATS_FILE). */
export type CaptureSourceStats = {
  at: number
  /** JPEG frames Chrome pushed per second (only on repaint; 0 is normal on a static LIVE/end/hold screen). */
  screencastFps: number
  /** hash of the capture code it started with (scripts/code-version.mjs) */
  codeVersion?: string
  /** ms since /stream's window.__hb last advanced (page JS alive). Missing on older capture processes. */
  heartbeatAgeMs?: number | null
  /** Frames written into ffmpeg per second (should equal the target fps). */
  writtenFps: number
  /** Share of written frames that repeated the previous screencast frame. */
  repeatPct: number
  /** Frames skipped because ffmpeg's input was backed up (the encoder can't keep up). */
  backpressurePct: number
  /** Worst timer lateness in the last window (ms): the Node event loop / CPU is starved. */
  maxLagMs: number
  fps: number
  encoder: string
  bitrateK: number
  size: string
  /** OBS program audio mixed into the capture (screen=program). peakDb: loudest program sample this window (dBFS), null = silence/none. */
  programAudio?: { on: boolean; reading: boolean; mixing?: boolean; peakDb?: number | null; bufferedMs: number; underruns: number; delayMs: number; queuedMs?: number | null; playerLatencyMs?: number | null; corrections?: number; jumps?: number; jitterMs?: number | null; source?: "main" | "backup"; via?: "page" | "reader" | null; arrivalExcessMs?: Partial<Record<"main" | "backup", number>>; offsetMs?: Partial<Record<"main" | "backup", number>>; formats?: Partial<Record<"main" | "backup", { codec: string; sampleRate: number; channels: string } | null>> }
  /** A/V sync compensation now applied (ms). */
  sync?: { screencastLagMs: number | null; trimMs: number; videoDelayMs: number; bedDelayMs: number; skippedMs: number; test: boolean }
}

export type SourceHealth = HealthStats & { capture: CaptureSourceStats | null; codeStale?: boolean }

/** Adds the capture-side flags on top of the encoder's own stats. */
export function captureSourceHealth(encoder: HealthStats, capture: CaptureSourceStats | null, now = Date.now(), codeVersion?: string): SourceHealth {
  if (!capture) return { ...encoder, capture: null }
  const warnings = [...encoder.warnings]
  let level: Level = encoder.level === "idle" ? "ok" : encoder.level
  const flag = (bad: boolean, text: string) => {
    warnings.push(text)
    if (bad) level = "bad"
    else if (level === "ok") level = "warn"
  }
  if (now - capture.at > 8000) flag(true, "capture stats stale")
  const stale = Boolean(codeVersion && capture.codeVersion !== codeVersion)
  if (stale) flag(false, "capture running old code: restart Browser capture")
  if (capture.backpressurePct > 2) flag(capture.backpressurePct > 10, `encoder backlog: ${capture.backpressurePct.toFixed(0)}% frames skipped`)
  if (capture.writtenFps < capture.fps - 2) flag(capture.writtenFps < capture.fps * 0.8, `writer ${capture.writtenFps.toFixed(1)} fps`)
  if (capture.maxLagMs > 250) flag(capture.maxLagMs > 1000, `timer lag ${Math.round(capture.maxLagMs)}ms (CPU)`)
  // Page heartbeat, not repaint rate: a static screen legitimately repaints ~0/s.
  if (typeof capture.heartbeatAgeMs === "number") {
    if (capture.heartbeatAgeMs > 8000) flag(capture.heartbeatAgeMs > 15000, `page heartbeat ${Math.round(capture.heartbeatAgeMs / 1000)}s old`)
  } else if (capture.screencastFps < 0.3) flag(false, `Chrome repaint ${capture.screencastFps.toFixed(1)}/s`)
  return { ...encoder, level, warnings, capture, codeStale: stale }
}

export type ForwardHealthInput = { name: string; health: HealthStats }
/**
 * Pure: one line on where the trouble most likely is.
 * Order: source first (everything downstream inherits it), then all-forwards-at-once (upload),
 * then individual forwards (that destination).
 */
export function diagnose(input: { source: { label: string; health: SourceHealth | HealthStats } | null; forwards: ForwardHealthInput[]; totalKbps: number | null; needKbps?: number | null }): { level: Level; text: string } {
  const { source, forwards } = input
  const total = input.totalKbps ? ` Total out ≈ ${(input.totalKbps / 1000).toFixed(1)} Mbps.` : ""
  const cap = source && "capture" in source.health ? source.health.capture : null
  if (source && source.health.level !== "ok" && source.health.level !== "idle") {
    if (cap && (cap.backpressurePct > 2 || cap.maxLagMs > 250 || (source.health.speed !== null && source.health.speed < 0.97)))
      return { level: source.health.level, text: `${source.label} encoder can't keep up → CPU on this machine. Try 720p, a lower bitrate, or VideoToolbox; close other apps.` }
    if (cap && (cap.heartbeatAgeMs ?? 0) > 8000) return { level: source.health.level, text: `${source.label}: /stream page stopped ticking → page stuck or CPU-starved (capture reloads it).` }
    if (source.health.speed !== null && source.health.speed < 0.97) return { level: source.health.level, text: `${source.label} encoder is slower than real time → CPU on this machine.` }
    return { level: source.health.level, text: `${source.label} source: ${source.health.warnings.join(", ")}.` }
  }
  const active = forwards.filter((item) => item.health.level !== "idle")
  const slow = active.filter((item) => item.health.level === "warn" || item.health.level === "bad")
  if (active.length >= 2 && slow.length === active.length)
    return { level: slow.some((item) => item.health.level === "bad") ? "bad" : "warn", text: `All ${active.length} forwards slow at once → upload bandwidth (or this network).${input.needKbps && input.totalKbps ? ` Sending ≈ ${(input.totalKbps / 1000).toFixed(1)} of ≈ ${(input.needKbps / 1000).toFixed(1)} Mbps needed.` : total} Lower the bitrate or forward to fewer destinations.` }
  if (slow.length >= 1) {
    const names = slow.map((item) => item.name).join(", ")
    return { level: slow.some((item) => item.health.level === "bad") ? "bad" : "warn", text: `${slow.length === 1 ? `Only ${names} is` : `${names} are`} slow while the others are fine → that destination / its ingest (${slow[0].health.warnings[0] ?? "slow"}).` }
  }
  if (!source && active.length === 0) return { level: "idle", text: "Nothing running." }
  return { level: "ok", text: `Healthy.${total}` }
}
