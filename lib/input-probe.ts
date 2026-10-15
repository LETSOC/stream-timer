/**
 * Live per-input stats (fps, audio format) from a cheap stream-copy reader per publishing input.
 * Server only. MediaMTX's API reports bytes but not fps or the audio format.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { EMPTY_STATS, parseStreamInfo, type InputStats } from "@/lib/input-state"
import type { ProgramSource } from "@/lib/program-source"

type Probe = { child: ChildProcess | null; url: string | null; stats: InputStats; frames: number | null; framesAt: number; recent: { at: number; fps: number }[]; startedAt: number }
const KEY = Symbol.for("stream-timer.input-probe")
function probes(): Record<ProgramSource, Probe> {
  const h = globalThis as { [KEY]?: Record<ProgramSource, Probe> }
  const fresh = (): Probe => ({ child: null, url: null, stats: { ...EMPTY_STATS }, frames: null, framesAt: 0, recent: [], startedAt: 0 })
  return (h[KEY] ??= { main: fresh(), backup: fresh() })
}

function stop(p: Probe) {
  p.child?.kill("SIGKILL")
  Object.assign(p, { child: null, url: null, stats: { ...EMPTY_STATS }, frames: null, recent: [] })
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
  const child = spawn(/* turbopackIgnore: true */ bin, ["-hide_banner", "-nostdin", "-loglevel", "info", "-stats_period", "0.5", "-rw_timeout", "5000000", "-i", url, "-map", "0", "-c", "copy", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] })
  p.child = child
  let buf = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    buf += chunk.toString()
    const parts = buf.split(/[\r\n]/); buf = parts.pop() ?? ""
    for (const line of parts) {
      const info = parseStreamInfo(line)
      if (info.video) p.stats.video = true
      if (info.fpsNominal) p.stats.fpsNominal = info.fpsNominal
      if (info.audio) p.stats.audio = info.audio
      const m = /frame=\s*(\d+)/.exec(line)
      if (m) {
        const t = Date.now(), f = Number(m[1])
        if (p.frames !== null && t - p.framesAt >= 1900) {
          const fps = Math.round(((f - p.frames) * 1000) / (t - p.framesAt) * 10) / 10
          p.recent = [...p.recent.filter((r) => t - r.at <= 10000), { at: t, fps }]
          p.stats.fps = fps
          p.stats.fpsMin = p.recent.length >= 3 ? Math.min(...p.recent.map((r) => r.fps)) : null
          p.frames = f; p.framesAt = t
        } else if (p.frames === null) { p.frames = f; p.framesAt = t }
      }
    }
  })
  child.on("exit", () => { if (p.child === child) { p.child = null; p.stats = { ...EMPTY_STATS }; p.frames = null; p.recent = [] } })
}

export function inputStats(source: ProgramSource, now = Date.now()): InputStats {
  const p = probes()[source]
  // A stalled stream stops progress lines: the last fps would linger, so age it out.
  if (p.framesAt && now - p.framesAt > 2000) return { ...p.stats, fps: 0, fpsMin: 0 }
  return p.stats
}
