/**
 * Measured input fps from the probe ffmpeg. Pure, no I/O.
 *
 * Primary: count video packets from a `-f framecrc pipe:1` output (one line per packet on every
 * FFmpeg version; header "#media_type N: video" names the video stream). Fallback: the `frame=`
 * counter in stderr stats lines, which FFmpeg 6.1 omits for a stream-copy-only run (7.x/8.x print it).
 * Once a packet line has been counted, stats lines are ignored so the two never mix.
 */
export const FPS_SAMPLE_MS = 1900
export const FPS_WINDOW_MS = 10000

export type FpsCounter = {
  /** output stream index of the video track, from the framecrc header (null = not seen yet) */
  videoIndex: number | null
  /** where the count comes from: framecrc packets, or stderr frame= (fallback) */
  source: "packets" | "stats" | null
  /** running video frame count (packets counted, or the last frame= value) */
  frames: number
  /** frames at the start of the current sample window, and when it started (null = no window yet) */
  sampleFrames: number | null
  sampleAt: number
  /** last time the count moved (a stalled stream stops moving it) */
  lastAt: number
  recent: { at: number; fps: number }[]
  fps: number | null
  fpsMin: number | null
}

export function newFpsCounter(): FpsCounter {
  return { videoIndex: null, source: null, frames: 0, sampleFrames: null, sampleAt: 0, lastAt: 0, recent: [], fps: null, fpsMin: null }
}

function advance(c: FpsCounter, frames: number, now: number) {
  if (frames !== c.frames || c.lastAt === 0) c.lastAt = now
  c.frames = frames
  if (c.sampleFrames === null) { c.sampleFrames = frames; c.sampleAt = now; return }
  if (now - c.sampleAt < FPS_SAMPLE_MS) return
  const fps = Math.round(((frames - c.sampleFrames) * 1000) / (now - c.sampleAt) * 10) / 10
  c.recent = [...c.recent.filter((r) => now - r.at <= FPS_WINDOW_MS), { at: now, fps }]
  c.fps = fps
  c.fpsMin = c.recent.length >= 3 ? Math.min(...c.recent.map((r) => r.fps)) : null
  c.sampleFrames = frames; c.sampleAt = now
}

/**
 * One stdout line of `-f framecrc`: "#media_type 0: video" (header) or
 * "0,        9,        9,       33,    28253, 0xe9c2d302[, F=0x0]" (stream, dts, pts, duration, size, crc).
 */
export function onFramecrcLine(c: FpsCounter, line: string, now: number): void {
  const header = /^#media_type\s+(\d+):\s*video\b/.exec(line)
  if (header) { if (c.videoIndex === null) c.videoIndex = Number(header[1]); return }
  if (c.videoIndex === null) return
  const m = /^\s*(\d+),\s*-?\d+,\s*-?\d+,/.exec(line)
  if (!m || Number(m[1]) !== c.videoIndex) return
  if (c.source !== "packets") {
    // switch from the stats fallback: restart the window on the packet count
    c.source = "packets"; c.frames = 0; c.sampleFrames = null; c.recent = []
  }
  advance(c, c.frames + 1, now)
}

/** One stderr stats line ("frame=  123 fps= 30 …"); used only until framecrc packets arrive. */
export function onStatsLine(c: FpsCounter, line: string, now: number): void {
  if (c.source === "packets") return
  const m = /\bframe=\s*(\d+)/.exec(line)
  if (!m) return
  c.source = "stats"
  advance(c, Number(m[1]), now)
}

/** fps/fpsMin as of now: a count that stopped moving for over 2s reads 0 (stalled stream). */
export function fpsReading(c: FpsCounter, now: number): { fps: number | null; fpsMin: number | null } {
  if (c.lastAt && now - c.lastAt > 2000) return { fps: 0, fpsMin: 0 }
  return { fps: c.fps, fpsMin: c.fpsMin }
}
