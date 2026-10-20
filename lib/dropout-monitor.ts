/**
 * Dropout watcher (server side, read-only): polls MediaMTX, tails the relay/forward/capture logs and
 * the capture health file, and writes one line per anomaly to the dropout log (lib/dropout-log.ts).
 * It never changes anything: no restarts, no config, no ffmpeg arguments.
 */
import fs from "node:fs"
import path from "node:path"
import { dlog, type DropLevel } from "@/lib/dropout-log"
import { relayDir, relayPathsSnapshot } from "@/lib/relay"
import { rtmpFiles } from "@/lib/encoder"
import { rttView } from "@/lib/rtt-monitor"

const PATH_LABEL: Record<string, string> = { program: "Main /program", "program-backup": "Backup /program-backup", capture: "Browser capture /capture", slate: "Slate /slate", vertical: "Vertical /vertical" }
/** Publisher connected but no new bytes for this long = the ingest is starving (weak Wi-Fi). */
export const INGEST_STALL_MS = 1500
export const SCREENCAST_GAP_MS = 200

// ---------- pure helpers (unit-tested) ----------

/**
 * Pure: one MediaMTX log line → a dropout note, tracking which connection publishes/reads which path
 * (`conns`, mutated) so "closed: EOF" can say whose connection it was. null = noise.
 */
export function mediamtxNote(line: string, conns: Map<string, { path: string; role: "publisher" | "reader" }>): { level: DropLevel; text: string; path?: string } | null {
  const m = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} (INF|WAR|ERR|DEB) (.*)$/.exec(line.trim())
  if (!m) return null
  const [, lvl, text] = m
  const conn = /^\[(RTMP|SRT|RTSP|WebRTC)\] \[(?:conn|session) ([^\]]+)\] (.*)$/.exec(text)
  if (conn) {
    const [, proto, id, rest] = conn
    const pub = /^is publishing to path '([^']+)'/.exec(rest)
    if (pub) { conns.set(id, { path: pub[1], role: "publisher" }); return { level: "·", text: `${proto} publisher ${id} connected to /${pub[1]}`, path: pub[1] } }
    const rd = /^is reading from path '([^']+)'/.exec(rest)
    if (rd) { conns.set(id, { path: rd[1], role: "reader" }); return null }
    const closed = /^closed: (.*)$/.exec(rest)
    if (closed) {
      const who = conns.get(id)
      conns.delete(id)
      if (/no stream is available on path/.test(closed[1])) return null
      if (who?.role === "publisher") return { level: "!", text: `${proto} publisher of /${who.path} (${id}) closed: ${closed[1]}`, path: who.path }
      if (who?.role === "reader") return { level: "·", text: `${proto} reader of /${who.path} closed: ${closed[1]}`, path: who.path }
      return /authenticat/.test(closed[1]) ? { level: "!", text: `${proto} ${id} refused: ${closed[1]}` } : null
    }
    if (lvl === "WAR" && /skipping track/.test(rest)) return null // WebRTC previews can't carry AAC (by design)
    if (lvl === "WAR" || lvl === "ERR") return { level: "!", text: `${proto} ${id}: ${rest}` }
    return null
  }
  if (lvl === "WAR" || lvl === "ERR") return { level: "!", text }
  if (/reloading configuration/.test(text)) return { level: "·", text }
  return null
}

/** ffmpeg -progress block (key=value lines) → the numbers we watch. */
export function parseProgress(block: string): { fps: number | null; kbps: number | null; speed: number | null; totalSize: number | null; outTimeUs: number | null } {
  const get = (k: string) => new RegExp(`(?:^|\\n)${k}=\\s*([^\\n]*)`).exec(block)?.[1]?.trim() ?? null
  const num = (v: string | null) => (v === null || v === "N/A" ? null : Number.parseFloat(v))
  const n = (v: number | null) => (v === null || !Number.isFinite(v) ? null : v)
  return { fps: n(num(get("fps"))), kbps: n(num(get("bitrate")?.replace(/kbits\/s/, "") ?? null)), speed: n(num(get("speed")?.replace(/x$/, "") ?? null)), totalSize: n(num(get("total_size"))), outTimeUs: n(num(get("out_time_us"))) }
}

/** Is a forward push unhealthy? speed below realtime, or bitrate well under its recent normal. */
export function pushTrouble(p: { speed: number | null; kbps: number | null }, normalKbps: number | null): string | null {
  const parts: string[] = []
  if (p.speed !== null && p.speed < 0.95) parts.push(`speed ${p.speed.toFixed(2)}x (below realtime: upload can't keep up)`)
  if (p.kbps !== null && normalKbps !== null && normalKbps > 200 && p.kbps < normalKbps * 0.6) parts.push(`bitrate ${Math.round(p.kbps)} kb/s (normal ~${Math.round(normalKbps)})`)
  return parts.length ? parts.join(", ") : null
}

/** Pure: capture "[chrome]" lines (browser relaunch / planned refresh) → dropout note. null = not one. */
export function captureChromeNote(line: string): { level: DropLevel; text: string } | null {
  const m = /\[chrome\] (.*)$/.exec(line.trim())
  if (!m) return null
  const text = m[1].slice(0, 200)
  if (/^planned Chrome refresh|^relaunching the capture browser: planned refresh/.test(text)) return { level: "·", text }
  if (/ready in the new browser/.test(text)) return { level: "+", text }
  if (/^relaunching|failed|killed/.test(text)) return { level: "!", text }
  return { level: "·", text }
}

export const AV_LINE_MS = 30_000
export type AvCounters = { corrections: number; jumps: number; resyncs: number }
/** Pure: the 30s "[av]" dropout line (program audio delay vs picture), and the counters it was counted from. */
export function avLine(pa: NonNullable<CaptureStats["programAudio"]>, prev: AvCounters | null): { text: string; counters: AvCounters } {
  const counters = { corrections: pa.corrections ?? 0, jumps: pa.jumps ?? 0, resyncs: pa.resyncs ?? 0 }
  // Counters restart with the capture process: then the new value is the count since.
  const d = (k: keyof AvCounters) => (prev === null ? 0 : counters[k] >= prev[k] ? counters[k] - prev[k] : counters[k])
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? "?" : `${Math.round(v)}ms`)
  return { counters, text: `program audio target delay ${ms(pa.delayMs)}, queue ${ms(pa.queuedMs)}, player latency ${ms(pa.playerLatencyMs)}; last 30s: ${d("corrections")} corrections, ${d("jumps")} drops/holds, ${d("resyncs")} resyncs` }
}

/** Capture health (scripts/capture-stream.mjs stats, every 2s) → problems while the program is on air. */
export type CaptureStats = { at?: number; fps?: number; screencastFps?: number; repeatPct?: number; backpressurePct?: number; heartbeatAgeMs?: number; maxGapMs?: number; programAudio?: { on?: boolean; underruns?: number; delayMs?: number; queuedMs?: number | null; playerLatencyMs?: number | null; corrections?: number; jumps?: number; resyncs?: number }; enc?: { fps: number; speed: number; kbps: number; drop?: number } }
export function captureTrouble(s: CaptureStats): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  const onProgram = s.programAudio?.on === true
  const fps = s.fps ?? 30
  if (onProgram && (s.maxGapMs ?? 0) > SCREENCAST_GAP_MS) out.push({ key: "gap", text: `screencast gap ${s.maxGapMs}ms on the program (page didn't repaint: output repeats the last frame = frozen)` })
  if (onProgram && (s.repeatPct ?? 0) > 50) out.push({ key: "repeat", text: `${s.repeatPct}% repeated frames on the program (picture frozen in the output; screencast ${s.screencastFps} fps)` })
  if ((s.backpressurePct ?? 0) > 0) out.push({ key: "backpressure", text: `encoder behind: ${s.backpressurePct}% frames skipped (CPU) → stutter` })
  if (s.enc && s.enc.speed < 0.95) out.push({ key: "speed", text: `capture encoder speed ${s.enc.speed}x, ${s.enc.fps} fps (below realtime → stutter/buffering downstream)` })
  else if (s.enc && s.enc.fps < fps * 0.85) out.push({ key: "fps", text: `capture encoder ${s.enc.fps} fps (target ${fps})` })
  // The capture samples the heartbeat every 5s, so up to ~5s is normal; > 9s = two missed ticks.
  if ((s.heartbeatAgeMs ?? 0) > 9000) out.push({ key: "hb", text: `/stream page not ticking for ${Math.round((s.heartbeatAgeMs ?? 0) / 1000)}s (page hung: frozen output, reload next)` })
  return out
}

// ---------- tails ----------

type Tail = { offset: number; partial: string }
function readNew(file: string, t: Tail): string[] {
  let size: number
  try { size = fs.statSync(file).size } catch { return [] }
  if (size < t.offset) { t.offset = 0; t.partial = "" } // truncated (process restarted)
  if (size === t.offset) return []
  const len = Math.min(size - t.offset, 1_000_000)
  const fd = fs.openSync(file, "r")
  const buf = Buffer.alloc(len)
  try { fs.readSync(fd, buf, 0, len, size - len) } finally { fs.closeSync(fd) }
  t.offset = size
  const lines = (t.partial + buf.toString("utf8")).split(/\r?\n|\r/)
  t.partial = lines.pop() ?? ""
  return lines
}

type ForwardWatch = { tail: Tail; block: string; recent: number[]; trouble: string | null; label: string }
type State = {
  timer: NodeJS.Timeout | null
  paths: Map<string, { ready: boolean; bytes: number; bytesAt: number; stalledSince: number | null }>
  apiDown: boolean
  mtx: Tail
  conns: Map<string, { path: string; role: "publisher" | "reader" }>
  lastMtx: { at: number; text: string }[]
  forwards: Map<string, ForwardWatch>
  capTail: Tail
  capStatsAt: number
  avAt: number
  avPrev: AvCounters | null
  capTrouble: Map<string, number>
  capStale: boolean
  srt: Record<"main" | "backup", { lost: number | null; spike: boolean; okSince: number | null }>
}
const KEY = Symbol.for("stream-timer.dropout-monitor")
function state(): State {
  const h = globalThis as { [KEY]?: State }
  h[KEY] ??= { timer: null, paths: new Map(), apiDown: false, mtx: { offset: -1, partial: "" }, conns: new Map(), lastMtx: [], forwards: new Map(), capTail: { offset: -1, partial: "" }, capStatsAt: 0, avAt: 0, avPrev: null, capTrouble: new Map(), capStale: false, srt: { main: { lost: null, spike: false, okSince: null }, backup: { lost: null, spike: false, okSince: null } } }
  return h[KEY]
}
/** Start tails at the current end (don't replay old logs on server start). */
function primeTail(file: string, t: Tail) {
  if (t.offset >= 0) return
  try { t.offset = fs.statSync(file).size } catch { t.offset = 0 }
}

function destNames(): Map<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(relayDir(), "..", "rtmp-destinations.json"), "utf8")) as { items?: { id: string; name: string }[] }
    return new Map((raw.items ?? []).map((d) => [d.id.replace(/[^a-zA-Z0-9-]/g, ""), d.name]))
  } catch { return new Map() }
}

async function pollRelay(s: State, now: number) {
  const snap = await relayPathsSnapshot()
  if (!snap) {
    if (!s.apiDown && s.paths.size) dlog("!", "relay", "MediaMTX API not answering (relay down or restarting): every path drops")
    s.apiDown = true
    return
  }
  if (s.apiDown && s.paths.size) dlog("+", "relay", "MediaMTX API answering again")
  s.apiDown = false
  for (const [name, label] of Object.entries(PATH_LABEL)) {
    const p = snap.get(name)
    const ready = p?.ready === true
    const bytes = p?.bytesReceived ?? 0
    const prev = s.paths.get(name)
    if (!prev) { s.paths.set(name, { ready, bytes, bytesAt: now, stalledSince: null }); continue }
    if (ready !== prev.ready) {
      const reason = s.lastMtx.filter((x) => now - x.at < 4000 && x.text.startsWith(`${name}: `) && /publisher of .* closed/.test(x.text)).map((x) => x.text.slice(name.length + 2)).slice(-1).join("")
      if (ready) dlog("+", "relay", `${label} publisher READY (${p?.source ?? "?"})`)
      else dlog("!", "relay", `${label} publisher GONE${reason ? ` (${reason})` : " (no reason in the MediaMTX log: publisher stopped or the connection timed out)"}`)
      prev.stalledSince = null
    } else if (ready) {
      if (bytes > prev.bytes) {
        if (prev.stalledSince !== null) dlog("+", "ingest", `${label}: data flowing again after ${((now - prev.stalledSince) / 1000).toFixed(1)}s`)
        prev.stalledSince = null
        prev.bytesAt = now
      } else if (prev.stalledSince === null && now - prev.bytesAt > INGEST_STALL_MS) {
        prev.stalledSince = prev.bytesAt
        dlog("!", "ingest", `${label}: no data for ${((now - prev.bytesAt) / 1000).toFixed(1)}s while the publisher is still connected (network starving the ingest: players stall → frozen picture)`)
      }
    }
    prev.ready = ready
    prev.bytes = bytes
  }
}

function pollMediamtxLog(s: State, now: number) {
  const file = path.join(relayDir(), "mediamtx.log")
  if (s.mtx.offset < 0) {
    // Server (re)start: learn who publishes what from the recent log, without logging it again.
    try {
      const size = fs.statSync(file).size
      const len = Math.min(size, 512_000)
      const fd = fs.openSync(file, "r")
      const buf = Buffer.alloc(len)
      try { fs.readSync(fd, buf, 0, len, size - len) } finally { fs.closeSync(fd) }
      for (const line of buf.toString("utf8").split("\n")) mediamtxNote(line, s.conns)
    } catch { /* no log yet */ }
  }
  primeTail(file, s.mtx)
  for (const line of readNew(file, s.mtx)) {
    const n = mediamtxNote(line, s.conns)
    if (!n) continue
    const text = n.text
    if (n.path) s.lastMtx.push({ at: now, text: `${n.path}: ${text}` })
    if (s.lastMtx.length > 20) s.lastMtx.shift()
    dlog(n.level, "relay", `mediamtx: ${text}`, now)
  }
}

function pollForwards(s: State) {
  let names: string[] = []
  try { names = fs.readdirSync(relayDir()).filter((n) => /^fwd-.*\.log$/.test(n)) } catch { return }
  const dests = names.length ? destNames() : new Map<string, string>()
  for (const name of names) {
    const file = path.join(relayDir(), name)
    let w = s.forwards.get(name)
    if (!w) {
      const m = /^fwd-([a-z-]+?)-(.+)\.log$/.exec(name)
      const label = `${dests.get(m?.[2] ?? "") ?? "destination"} (from /${m?.[1] ?? "?"})`
      w = { tail: { offset: -1, partial: "" }, block: "", recent: [], trouble: null, label }
      s.forwards.set(name, w)
      primeTail(file, w.tail)
      continue
    }
    for (const line of readNew(file, w.tail)) {
      if (/^[a-z_0-9]+=/.test(line)) {
        w.block += `${line}\n`
        if (!line.startsWith("progress=")) continue
        const p = parseProgress(w.block)
        w.block = ""
        if (line === "progress=end") continue
        const normal = w.recent.length >= 3 ? [...w.recent].sort((a, b) => a - b)[Math.floor(w.recent.length / 2)] : null
        const t = pushTrouble(p, normal)
        if (t && !w.trouble) dlog("!", "push", `${w.label}: ${t}`)
        else if (!t && w.trouble) dlog("+", "push", `${w.label}: back to normal (${p.kbps === null ? "?" : Math.round(p.kbps)} kb/s, ${p.speed ?? "?"}x)`)
        w.trouble = t
        if (p.kbps !== null && !t) { w.recent.push(p.kbps); if (w.recent.length > 12) w.recent.shift() }
        continue
      }
      if (/\[relay-loop [^\]]+\] (exited|no data sent|starting|stop requested)/.test(line)) {
        // A forward retrying while its source path has no publisher is waiting, not a dropout.
        const from = /^fwd-([a-z-]+?)-/.exec(name)?.[1] ?? ""
        const waiting = /exited \(code \d+ after [0-2]s\)/.test(line) && s.paths.get(from)?.ready === false
        const bad = /exited|no data sent/.test(line) && !waiting
        dlog(bad ? "!" : "·", "push", `${w.label}: ${line.replace(/^\[relay-loop [^\]]+\] /, "")}${bad ? " (YouTube sees the stream end; it resumes on reconnect)" : waiting ? ` (waiting: /${from} has no publisher)` : ""}`)
      } else if (/Connection (reset|refused|timed out)|Broken pipe|I\/O error|Error (writing|number)|Failed to update header|end of file|Server returned/i.test(line)) {
        dlog("!", "push", `${w.label}: ffmpeg: ${line.trim().slice(0, 200)}`)
      }
    }
  }
  for (const key of [...s.forwards.keys()]) if (!names.includes(key)) s.forwards.delete(key)
}

function pollCapture(s: State, now: number) {
  let files: { log: string; stats?: string }
  try { files = rtmpFiles("capture") as { log: string; stats?: string } } catch { return }
  primeTail(files.log, s.capTail)
  for (const line of readNew(files.log, s.capTail)) {
    if (/frame=\s*\d+.*speed=/.test(line) || !line.trim()) continue
    const chrome = captureChromeNote(line)
    if (chrome) dlog(chrome.level, "capture", chrome.text)
    else if (/\[audio\] program audio resync/.test(line)) dlog("·", "capture", line.trim().replace(/^\[capture [^\]]+\] /, "").slice(0, 200))
    else if (/heartbeat stalled|reload|crash|could not|failed|restarting capture|exited|timed out|Broken pipe|Connection (reset|refused)|Error/i.test(line)) dlog("!", "capture", line.trim().slice(0, 220))
    else if (/\[audio\] program source|shows the program|left the program/.test(line)) dlog("·", "capture", line.trim().replace(/^\[capture [^\]]+\] /, "").slice(0, 200))
  }
  if (!files.stats) return
  let st: CaptureStats | null = null
  try { st = JSON.parse(fs.readFileSync(files.stats, "utf8")) as CaptureStats } catch { st = null }
  if (!st?.at) return
  const fresh = now - st.at < 7000
  if (!fresh && !s.capStale && s.capStatsAt) dlog("!", "capture", "Browser capture stopped reporting (process stopped, hung or restarting): output frozen or ended")
  if (fresh && s.capStale) dlog("+", "capture", "Browser capture reporting again")
  s.capStale = !fresh
  if (!fresh || st.at === s.capStatsAt) return
  s.capStatsAt = st.at
  if (st.programAudio?.on && now - (s.avAt ?? 0) >= AV_LINE_MS) {
    const a = avLine(st.programAudio, s.avPrev ?? null)
    dlog("·", "av", a.text, now)
    s.avAt = now
    s.avPrev = a.counters
  }
  const found = captureTrouble(st)
  for (const f of found) {
    if (!s.capTrouble.has(f.key)) dlog("!", "capture", f.text)
    s.capTrouble.set(f.key, now)
  }
  for (const [k, since] of [...s.capTrouble]) {
    if (found.some((f) => f.key === k)) continue
    if (now - since > 4000) { s.capTrouble.delete(k); dlog("+", "capture", `${k === "gap" ? "screencast" : k === "repeat" ? "program picture" : k === "hb" ? "page" : "encoder"} back to normal`) }
  }
}

function pollSrt(s: State, now: number) {
  for (const src of ["main", "backup"] as const) {
    const v = rttView(src, now)
    const w = s.srt[src]
    const label = src === "main" ? "Main" : "Backup"
    const srt = v.protocol === "srt" ? v.srt : null
    const lost = srt?.lost ?? null
    const newLost = lost !== null && w.lost !== null && lost > w.lost ? lost - w.lost : 0
    w.lost = lost
    const rtt = srt?.rttMs ?? v.lastMs
    const bad = (rtt !== null && rtt > 150) || newLost >= 5 || (srt === null && v.lossPct >= 10)
    if (bad && !w.spike) {
      w.spike = true
      dlog("!", srt ? "srt" : "ingest", `${label} link spike: ${srt ? "SRT " : ""}RTT ${rtt === null ? "?" : Math.round(rtt)}ms${newLost ? `, ${newLost} packets lost` : ""}${srt ? ` (retransmits ${srt.retrans})` : v.lossPct ? `, ping loss ${v.lossPct}%` : ""} via ${v.host ?? "?"}`)
    }
    if (bad) w.okSince = null
    else if (w.spike) {
      w.okSince ??= now
      if (now - w.okSince > 10_000) { w.spike = false; w.okSince = null; dlog("+", srt ? "srt" : "ingest", `${label} link normal again (RTT ${rtt === null ? "?" : Math.round(rtt)}ms)`) }
    }
  }
}

export async function dropoutTick(now = Date.now()) {
  const s = state()
  pollMediamtxLog(s, now)
  await pollRelay(s, now)
  pollForwards(s)
  pollCapture(s, now)
  pollSrt(s, now)
}

export function startDropoutMonitor(intervalMs = 1000) {
  if (process.env.DROPOUT_LOG === "0") return
  const s = state()
  if (s.timer) return
  dlog("·", "server", "dropout log started (server up)")
  let busy = false
  s.timer = setInterval(() => {
    if (busy) return
    busy = true
    void dropoutTick().catch(() => undefined).finally(() => (busy = false))
  }, intervalMs)
  s.timer.unref()
}
