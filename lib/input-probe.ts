/**
 * Live per-input stats (fps, audio format) from a cheap stream-copy reader per publishing input.
 * Server only. MediaMTX's API reports bytes but not fps or the audio format.
 *
 * fps = video packets counted from a framecrc output on stdout (works on FFmpeg 6.1, whose
 * stream-copy stats lines have no frame=, and on 7.x/8.x); stderr frame= is the fallback.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { fpsReading, newFpsCounter, onFramecrcLine, onStatsLine, type FpsCounter } from "@/lib/fps-counter"
import { EMPTY_STATS, parseStreamInfo, type InputStats } from "@/lib/input-state"
import type { ProgramSource } from "@/lib/program-source"

type Probe = { child: ChildProcess | null; url: string | null; stats: InputStats; counter: FpsCounter; startedAt: number }
const KEY = Symbol.for("stream-timer.input-probe")
function probes(): Record<ProgramSource, Probe> {
  const h = globalThis as { [KEY]?: Record<ProgramSource, Probe> }
  const fresh = (): Probe => ({ child: null, url: null, stats: { ...EMPTY_STATS }, counter: newFpsCounter(), startedAt: 0 })
  return (h[KEY] ??= { main: fresh(), backup: fresh() })
}

function stop(p: Probe) {
  p.child?.kill("SIGKILL")
  Object.assign(p, { child: null, url: null, stats: { ...EMPTY_STATS }, counter: newFpsCounter() })
}

/** Pure: the probe ffmpeg. framecrc on stdout = one line per packet (cheap Adler-32, no decode). */
export function probeArgs(url: string): string[] {
  return ["-hide_banner", "-nostdin", "-loglevel", "info", "-stats_period", "0.5", "-rw_timeout", "5000000", "-i", url, "-map", "0", "-c", "copy", "-f", "framecrc", "pipe:1"]
}

/** Split a stream into lines; returns the leftover partial line. */
function eachLine(buf: string, chunk: Buffer, fn: (line: string) => void): string {
  const parts = (buf + chunk.toString()).split(/[\r\n]/)
  const rest = parts.pop() ?? ""
  for (const line of parts) if (line) fn(line)
  return rest
}

/** Keep a reader running for each publishing input (url = null → stop). */
export function syncInputProbe(source: ProgramSource, url: string | null, now = Date.now()) {
  const p = probes()[source]
  if (!url) { if (p.child || p.url) stop(p); return }
  if (p.child && p.url === url) return
  if (now - p.startedAt < 2000) return // backoff after a quick exit
  stop(p)
  p.url = url; p.startedAt = now
  const bin = process.env.FFMPEG_BIN || "ffmpeg"
  const child = spawn(/* turbopackIgnore: true */ bin, probeArgs(url), { stdio: ["ignore", "pipe", "pipe"] })
  p.child = child
  const counter = p.counter
  let out = "", err = ""
  child.stdout?.on("data", (chunk: Buffer) => { out = eachLine(out, chunk, (line) => onFramecrcLine(counter, line, Date.now())) })
  child.stderr?.on("data", (chunk: Buffer) => {
    err = eachLine(err, chunk, (line) => {
      const info = parseStreamInfo(line)
      if (info.video) p.stats.video = true
      if (info.fpsNominal) p.stats.fpsNominal = info.fpsNominal
      if (info.audio) p.stats.audio = info.audio
      onStatsLine(counter, line, Date.now())
    })
  })
  child.on("exit", () => { if (p.child === child) { p.child = null; p.stats = { ...EMPTY_STATS }; p.counter = newFpsCounter() } })
}

export function inputStats(source: ProgramSource, now = Date.now()): InputStats {
  const p = probes()[source]
  // A stalled stream stops the count: the last fps would linger, so it ages out to 0.
  return { ...p.stats, ...fpsReading(p.counter, now) }
}
