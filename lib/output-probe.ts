/**
 * Output probe (read-only): every 10s, while Browser capture is running, one short read (~4s) of what the
 * capture actually publishes on the relay (/capture): fps, A/V interleave gap, keyframe interval, bitrate.
 * Always the same single extra MediaMTX reader, one read at a time (never two at once); nothing else about
 * the relay changes. Separate process, never awaited by capture.
 *
 * Logging (nothing is lost, the dropout log just stops repeating good readings):
 * - every reading → one JSON line in <dropout log dir>/output-probe.jsonl (2MB, then rotated to .1 once);
 * - dropout log, in full: the first reading, every flagged reading (gap over 80ms, no audio/video), the first
 *   good one after a flagged one, every post-switch reading and every content A/V offset;
 * - dropout log, once a minute: count, interleave gap min/median/max, number flagged.
 * Post-switch: one probe ~3s after every Main/Backup switch (plus a flash/beep check).
 * Content A/V offset (lib/av-offset): a short decode instead of the packet read on every 3rd tick while the
 * desk's A/V sync test is on, or always with OUTPUT_PROBE_AV=1 (OBS clapper clip); silent without flash+beep.
 * OUTPUT_PROBE=0 turns it all off.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { readAudioSettings } from "@/lib/audio-bed"
import { avDecodeArgs, avOffset, avOffsetLine, median, onsets, parseAvMetadata } from "@/lib/av-offset"
import { dlog, dropoutDir } from "@/lib/dropout-log"
import { rtmpFiles } from "@/lib/encoder"
import { readServerState } from "@/lib/event-server"
import { SOURCE_LABEL, type ProgramSource } from "@/lib/program-source"
import { relayReadUrl } from "@/lib/relay"
import { stageScreen } from "@/lib/stage"

export const OUTPUT_PROBE_MS = 10_000
export const PROBE_READ_S = 4 // 2s GOP: always at least two keyframes in the read
export const AV_GAP_FLAG_MS = 80
export const SUMMARY_MS = 60_000
export const AFTER_SWITCH_MS = 3000
export const AV_EVERY_TICKS = 3 // content decode on every 3rd tick when on (30s): no constant decode load
export const JSONL_MAX_BYTES = 2_000_000
export const probeJsonlPath = () => path.join(dropoutDir(), "output-probe.jsonl")

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

export const probeFlagged = (r: ProbeResult) => (r.gapMs !== null && r.gapMs > AV_GAP_FLAG_MS) || r.audio === 0 || r.video === 0

/** Pure: the dropout line for one probe (level "!" when the interleave gap is over 80ms). */
export function probeLine(r: ProbeResult, label = "output probe (/capture)"): { level: "!" | "·"; text: string } {
  const q = (x: number | null, unit: string) => (x === null ? "?" : `${x}${unit}`)
  const gapBad = r.gapMs !== null && r.gapMs > AV_GAP_FLAG_MS
  const text = `${label}: ${q(r.fps, "fps")} · interleave gap ${q(r.gapMs, "ms")}${gapBad ? ` (over ${AV_GAP_FLAG_MS}ms)` : ""} · keyframe every ${q(r.keyframeS, "s")} · ${q(r.kbps, "kbps")}${r.audio === 0 ? " · no audio packets" : ""}`
  return { level: probeFlagged(r) ? "!" : "·", text }
}

/** Pure: should this tick reading go to the dropout log in full? (the rest only feed the minute summary + JSONL) */
export function logInFull(r: ProbeResult, prevFlagged: boolean | null): boolean {
  return prevFlagged === null || probeFlagged(r) || prevFlagged
}

/** Pure: the minute summary line, or null when nothing was read in the minute. */
export function summaryLine(rs: ProbeResult[]): { level: "!" | "·"; text: string } | null {
  if (!rs.length) return null
  const gaps = rs.map((r) => r.gapMs).filter((x): x is number => x !== null)
  const flagged = rs.filter(probeFlagged).length
  const med = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.length ? Math.round(median(v) * 10) / 10 : null }
  const fps = med(rs.map((r) => r.fps))
  const kbps = med(rs.map((r) => r.kbps))
  const g = gaps.length ? `${Math.min(...gaps)}/${Math.round(median(gaps))}/${Math.max(...gaps)}ms` : "?"
  return { level: flagged ? "!" : "·", text: `output probe 1-min (/capture): ${rs.length} readings · interleave gap min/median/max ${g} · ${flagged} flagged (over ${AV_GAP_FLAG_MS}ms or missing audio/video) · median ${fps ?? "?"}fps · ${kbps ?? "?"}kbps` }
}

/** Append one JSON line; past maxBytes the file becomes .1.jsonl (one old file kept: bounded at ~2× maxBytes). */
export function appendJsonl(file: string, row: object, maxBytes = JSONL_MAX_BYTES) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file.replace(/\.jsonl$/, ".1.jsonl")) } catch { /* new file */ }
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
  } catch { /* diagnostics never break the show */ }
}

export function probeArgs(url: string): string[] {
  return ["-v", "error", "-rw_timeout", "5000000", "-analyzeduration", "500000", "-probesize", "500000", "-read_intervals", `%+${PROBE_READ_S}`, "-show_entries", "packet=codec_type,pts_time,size,flags", "-of", "compact=p=0", url]
}

type ProbeState = { timer?: NodeJS.Timeout; busy: boolean; failing: boolean; prevFlagged: boolean | null; tick: number; minute: ProbeResult[]; minuteAt: number; switchTimer?: NodeJS.Timeout }
const st = (): ProbeState => {
  const g = globalThis as { __outputProbe?: ProbeState }
  g.__outputProbe ??= { busy: false, failing: false, prevFlagged: null, tick: 0, minute: [], minuteAt: Date.now() }
  g.__outputProbe.minute ??= []
  g.__outputProbe.tick ??= 0
  g.__outputProbe.minuteAt ??= Date.now()
  if (g.__outputProbe.prevFlagged === undefined) g.__outputProbe.prevFlagged = null
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

/** What is on air right now: Main/Backup when the program screen is up, else the bed (countdown, cards…). */
function onAirTag(): string {
  try {
    const stage = readServerState().stage
    const screen = stageScreen(stage, false)
    return screen === "program" ? SOURCE_LABEL[stage.programSource] : `bed (${screen})`
  } catch { return "?" }
}

function syncTestOn(): boolean {
  try { return readAudioSettings().channels.capture.syncTest === true } catch { return false }
}
const avWanted = () => process.env.OUTPUT_PROBE_AV === "1" || syncTestOn()

/** One read of /capture by one child process; cb gets its output. Returns false when not started (busy/no capture). */
function read(kind: "packets" | "av", cb: (out: string) => void): boolean {
  const s = st()
  if (s.busy || !captureRunning(Date.now())) return false
  let url: string
  try { url = relayReadUrl("capture") } catch { return false }
  s.busy = true
  let out = ""
  const bin = kind === "packets" ? process.env.FFPROBE_BIN || "ffprobe" : process.env.FFMPEG_BIN || "ffmpeg"
  const child = spawn(/* turbopackIgnore: true */ bin, kind === "packets" ? probeArgs(url) : avDecodeArgs(url), { stdio: ["ignore", kind === "packets" ? "pipe" : "ignore", kind === "packets" ? "ignore" : "pipe"] })
  const kill = setTimeout(() => child.kill("SIGKILL"), (PROBE_READ_S + 6) * 1000)
  const stream = kind === "packets" ? child.stdout : child.stderr
  stream?.on("data", (d: Buffer) => { if (out.length < 4_000_000) out += d.toString() })
  let finished = false
  const finish = () => { if (finished) return; finished = true; clearTimeout(kill); s.busy = false; try { cb(out) } catch { /* best effort */ } }
  child.on("error", finish)
  child.on("close", finish)
  return true
}

type Why = "tick" | "switch"
function onPackets(out: string, why: Why, tag: string, switchTo?: string) {
  const s = st()
  const at = Date.now()
  const r = parseProbePackets(out)
  if (r.video === 0 && r.audio === 0) {
    appendJsonl(probeJsonlPath(), { at, kind: "packets", why, tag, ok: false })
    if (!s.failing) dlog("!", "capture", "output probe: could not read /capture from the relay (capture not on the relay, or relay down)")
    s.failing = true
    s.prevFlagged = null
    return
  }
  s.failing = false
  const flagged = probeFlagged(r)
  appendJsonl(probeJsonlPath(), { at, kind: "packets", why, tag, ok: true, ...r, flagged })
  if (why === "switch") {
    const line = probeLine(r, `output probe ${AFTER_SWITCH_MS / 1000}s after switch → ${switchTo} (/capture)`)
    dlog(line.level, "switch", line.text)
  } else {
    s.minute.push(r)
    if (logInFull(r, s.prevFlagged)) {
      const line = probeLine(r)
      dlog(line.level, "capture", line.text + (!flagged && s.prevFlagged ? " · back to normal" : ""))
    }
  }
  s.prevFlagged = flagged
}

function onAv(out: string, why: Why, tag: string) {
  const { luma, rms } = parseAvMetadata(out)
  const r = avOffset(luma, rms)
  const row = { at: Date.now(), kind: "av", why, tag, ok: luma.length > 0, frames: luma.length, flashes: onsets(luma, 60, 0.3).length, beeps: onsets(rms, 25, 0.3).length, ...(r ?? { offsetMs: null }) }
  appendJsonl(probeJsonlPath(), row)
  if (r) dlog(Math.abs(r.offsetMs) > AV_GAP_FLAG_MS ? "!" : "·", why === "switch" ? "switch" : "av", avOffsetLine(r, tag, why === "switch" ? `${AFTER_SWITCH_MS / 1000}s after switch` : syncTestOn() ? "desk A/V sync test (capture chain only)" : "flash+beep in the picture"))
}

function flushSummary(now: number) {
  const s = st()
  if (now - s.minuteAt < SUMMARY_MS) return
  const line = summaryLine(s.minute)
  if (line) dlog(line.level, "capture", line.text)
  s.minute = []
  s.minuteAt = now
}

function tick() {
  const s = st()
  flushSummary(Date.now())
  if (s.busy) return
  s.tick++
  const tag = onAirTag()
  if (avWanted() && s.tick % AV_EVERY_TICKS === 0) read("av", (out) => onAv(out, "tick", tag))
  else read("packets", (out) => onPackets(out, "tick", tag))
}

/** Main/Backup switch: one packet probe ~3s later, then one flash/beep check, both logged in full. */
export function probeAfterSwitch(to: ProgramSource) {
  if (process.env.OUTPUT_PROBE === "0") return
  const s = st()
  if (s.switchTimer) clearTimeout(s.switchTimer)
  const label = SOURCE_LABEL[to]
  const due = Date.now() + AFTER_SWITCH_MS
  const attempt = () => {
    s.switchTimer = undefined
    const started = read("packets", (out) => {
      onPackets(out, "switch", label, label)
      read("av", (av) => onAv(av, "switch", label))
    })
    // A tick read is still running: try again shortly (up to 6s late, then give up quietly).
    if (!started && st().busy && Date.now() - due < 6000) { s.switchTimer = setTimeout(attempt, 250); s.switchTimer.unref() }
  }
  s.switchTimer = setTimeout(attempt, AFTER_SWITCH_MS)
  s.switchTimer.unref()
}

export function startOutputProbe() {
  if (process.env.OUTPUT_PROBE === "0") return
  const s = st()
  if (s.timer) return
  s.timer = setInterval(() => { try { tick() } catch { st().busy = false } }, OUTPUT_PROBE_MS)
  s.timer.unref()
}
