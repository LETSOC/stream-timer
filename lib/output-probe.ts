/**
 * Output probe (read-only): every 10s, while Browser capture is running, one short ffprobe read (~4s)
 * of what the capture actually publishes on the relay (/capture), logged to the dropout log as fps,
 * A/V interleave gap, keyframe interval and bitrate. One extra MediaMTX reader; nothing else about the relay
 * changes. Separate process, never awaited by capture; skipped while the previous probe still runs.
 * OUTPUT_PROBE=0 turns it off.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import { dlog } from "@/lib/dropout-log"
import { rtmpFiles } from "@/lib/encoder"
import { relayReadUrl } from "@/lib/relay"

export const OUTPUT_PROBE_MS = 10_000
export const PROBE_READ_S = 4 // 2s GOP: always at least two keyframes in the read
export const AV_GAP_FLAG_MS = 80

export type ProbeResult = { fps: number | null; gapMs: number | null; keyframeS: number | null; kbps: number | null; video: number; audio: number }

/**
 * Pure: ffprobe `-show_entries packet=codec_type,pts_time,size,flags -of compact=p=0` output → numbers.
 * A fresh RTMP reader gets audio at once but video only from the next keyframe, so everything before the
 * first video keyframe is dropped (it made a 0–2s "gap" that just showed where in the GOP the read began).
 * Audio counts toward the bitrate only inside the video's time span. gapMs = interleave gap at the end of the read: how
 * far the last audio and video timestamps are apart. It is NOT a content A/V sync measurement (use the
 * desk's A/V sync test for that).
 */
export function parseProbePackets(text: string): ProbeResult {
  const pk: { type: "video" | "audio"; pts: number; size: number; key: boolean }[] = []
  for (const line of text.split("\n")) {
    const f: Record<string, string> = {}
    for (const kv of line.trim().split("|")) { const i = kv.indexOf("="); if (i > 0) f[kv.slice(0, i)] = kv.slice(i + 1) }
    const pts = Number(f.pts_time)
    if (!Number.isFinite(pts) || (f.codec_type !== "video" && f.codec_type !== "audio")) continue
    pk.push({ type: f.codec_type, pts, size: Number(f.size) || 0, key: f.codec_type === "video" && (f.flags ?? "").startsWith("K") })
  }
  const keyPts = pk.filter((p) => p.key).map((p) => p.pts)
  const allV = pk.filter((p) => p.type === "video").map((p) => p.pts)
  // From the first video keyframe on (no keyframe in the read: from the first video packet).
  const from = keyPts.length ? Math.min(...keyPts) : allV.length ? Math.min(...allV) : -Infinity
  const vp = pk.filter((p) => p.type === "video" && p.pts >= from)
  const v = vp.map((p) => p.pts)
  const vMin = v.length ? Math.min(...v) : 0
  const vMax = v.length ? Math.max(...v) : 0
  const AUDIO_SLACK_S = 0.05 // one AAC frame is ~21ms
  const ap = pk.filter((p) => p.type === "audio" && (!v.length || (p.pts >= vMin && p.pts <= vMax + AUDIO_SLACK_S)))
  const a = ap.map((p) => p.pts)
  const vSpan = v.length > 1 ? vMax - vMin : 0
  const fps = vSpan > 0 ? +((v.length - 1) / vSpan).toFixed(1) : null
  // End of the read: last video vs last audio (audio from the first keyframe on, either side of the video end).
  const aEnd = pk.filter((p) => p.type === "audio" && p.pts >= from).map((p) => p.pts)
  const gapMs = v.length && aEnd.length && a.length ? Math.round(Math.abs(vMax - Math.max(...aEnd)) * 1000) : null
  const ks = keyPts.filter((k) => k >= from).sort((x, y) => x - y)
  const keyframeS = ks.length > 1 ? +((ks[ks.length - 1] - ks[0]) / (ks.length - 1)).toFixed(2) : null
  const bytes = [...vp, ...ap].reduce((n, p) => n + p.size, 0)
  const kbps = vSpan > 0 ? Math.round((bytes * 8) / vSpan / 1000) : null
  return { fps, gapMs, keyframeS, kbps, video: v.length, audio: pk.filter((p) => p.type === "audio").length }
}

/** Pure: the dropout line for one probe (level "!" when the interleave gap is over 80ms). */
export function probeLine(r: ProbeResult): { level: "!" | "·"; text: string } {
  const q = (x: number | null, unit: string) => (x === null ? "?" : `${x}${unit}`)
  const gapBad = r.gapMs !== null && r.gapMs > AV_GAP_FLAG_MS
  const text = `output probe (/capture): ${q(r.fps, "fps")} · interleave gap ${q(r.gapMs, "ms")}${gapBad ? ` (over ${AV_GAP_FLAG_MS}ms)` : ""} · keyframe every ${q(r.keyframeS, "s")} · ${q(r.kbps, "kbps")}${r.audio === 0 ? " · no audio packets" : ""}`
  return { level: gapBad || r.audio === 0 || r.video === 0 ? "!" : "·", text }
}

export function probeArgs(url: string): string[] {
  return ["-v", "error", "-rw_timeout", "5000000", "-analyzeduration", "500000", "-probesize", "500000", "-read_intervals", `%+${PROBE_READ_S}`, "-show_entries", "packet=codec_type,pts_time,size,flags", "-of", "compact=p=0", url]
}

type ProbeState = { timer?: NodeJS.Timeout; busy: boolean; failing: boolean }
const st = (): ProbeState => {
  const g = globalThis as { __outputProbe?: ProbeState }
  g.__outputProbe ??= { busy: false, failing: false }
  return g.__outputProbe
}

function captureRunning(now: number): boolean {
  try {
    const stats = (rtmpFiles("capture") as { stats?: string }).stats
    if (!stats) return false
    const at = (JSON.parse(fs.readFileSync(stats, "utf8")) as { at?: number }).at ?? 0
    return now - at < 7000
  } catch { return false }
}

function probeOnce() {
  const s = st()
  if (s.busy || !captureRunning(Date.now())) return
  let url: string
  try { url = relayReadUrl("capture") } catch { return }
  s.busy = true
  let out = ""
  const child = spawn(/* turbopackIgnore: true */ process.env.FFPROBE_BIN || "ffprobe", probeArgs(url), { stdio: ["ignore", "pipe", "ignore"] })
  const kill = setTimeout(() => child.kill("SIGKILL"), (PROBE_READ_S + 6) * 1000)
  child.stdout.on("data", (d: Buffer) => { if (out.length < 2_000_000) out += d.toString() })
  const done = () => {
    clearTimeout(kill)
    s.busy = false
    const r = parseProbePackets(out)
    if (r.video === 0 && r.audio === 0) {
      if (!s.failing) dlog("!", "capture", "output probe: could not read /capture from the relay (capture not on the relay, or relay down)")
      s.failing = true
      return
    }
    if (s.failing) s.failing = false
    const line = probeLine(r)
    dlog(line.level, "capture", line.text)
  }
  child.on("error", () => { clearTimeout(kill); s.busy = false })
  child.on("close", done)
}

export function startOutputProbe() {
  if (process.env.OUTPUT_PROBE === "0") return
  const s = st()
  if (s.timer) return
  s.timer = setInterval(() => { try { probeOnce() } catch { st().busy = false } }, OUTPUT_PROBE_MS)
  s.timer.unref()
}
