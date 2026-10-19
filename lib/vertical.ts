/**
 * Vertical (9:16) output: a separate ffmpeg that READS the Browser capture path from the local
 * MediaMTX relay (rtmp://127.0.0.1:19350/capture, read credentials), fits the whole 16:9 picture
 * into 1080x1920 (centred, bars top/bottom) and publishes it to ONE place: the relay path /vertical.
 * Destinations are relay forwards from /vertical (lib/relay.ts), exactly like the HD paths: one
 * ffmpeg -c copy each, added/removed live without touching the encoder.
 *
 * It never touches the capture or slate pipelines: it is just another reader of /capture, under its
 * own restart loop (scripts/relay-loop.sh, tag "vertical:dest=<fingerprint>", same backoff and stall
 * watchdog as the relay forwards). Files live in data/vertical/ (0600): settings.json, vertical.json
 * (pidfile), vertical.log, vertical-state.json.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { ffmpegAvailable, killGroup, pidRunsScript, redact, relayChildEnv } from "@/lib/encoder"
import { addVerticalForwards, deriveForwardState, ensureRelayServer, findRelayLoops, mediamtxPathStats, reconcileRelay, relayPublishUrl, relayReadUrl, VERTICAL_PATH, type ForwardState } from "@/lib/relay"
import { listDestinations } from "@/lib/rtmp-destinations"
import { EMPTY_HEALTH, type HealthStats } from "@/lib/stream-health"

export const VERTICAL_W = 1080
export const VERTICAL_H = 1920
export const VERTICAL_FPS = 30
export const VERTICAL_KBPS = 4500
export const VERTICAL_GOP_SEC = 2
export const VERTICAL_BG_PRESETS = ["#000000", "#0000B6"] as const
export type VerticalEncoder = "auto" | "libx264" | "videotoolbox"
export type VerticalAudio = "auto" | "copy" | "aac"
export type VerticalSettings = { bg: string; encoder: VerticalEncoder; audio: VerticalAudio }
export const DEFAULT_VERTICAL: VerticalSettings = { bg: "#000000", encoder: "auto", audio: "auto" }

const root = () => process.cwd()
const dir = () => path.join(process.env.STREAM_DATA_DIR || path.join(root(), "data"), "vertical")
const file = (name: string) => path.join(dir(), name)
const LOOP = () => process.env.RELAY_LOOP_SCRIPT || path.join(root(), "scripts", "relay-loop.sh")
export const VERTICAL_TAG_RE = /^vertical:dest=(relay|[0-9a-f]{16})$/

// ---------- pure ----------

export function cleanBg(value: unknown, fallback = DEFAULT_VERTICAL.bg): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toUpperCase() : fallback
}
export function parseVerticalSettings(raw: unknown): VerticalSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  return {
    bg: cleanBg(r.bg),
    encoder: r.encoder === "libx264" || r.encoder === "videotoolbox" ? r.encoder : "auto",
    audio: r.audio === "copy" || r.audio === "aac" ? r.audio : "auto",
  }
}
/** Old builds kept direct "vertical destination" ticks here; they become /vertical relay forwards. */
export function legacyDestIds(raw: unknown): string[] {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  return Array.isArray(r.destIds) ? [...new Set(r.destIds.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id)))] : []
}

/** Fit the whole 16:9 frame into 1080x1920: scale to 1080 wide (even height), pad centred with `bg`. */
export function verticalFilter(bg: string): string {
  const color = `0x${cleanBg(bg).slice(1)}`
  return `scale=${VERTICAL_W}:-2:flags=bicubic,pad=${VERTICAL_W}:${VERTICAL_H}:(ow-iw)/2:(oh-ih)/2:color=${color},fps=${VERTICAL_FPS},format=yuv420p,setsar=1`
}

export function videoArgs(encoder: "libx264" | "videotoolbox"): string[] {
  const k = `${VERTICAL_KBPS}k`
  const gop = String(VERTICAL_FPS * VERTICAL_GOP_SEC)
  const cbr = ["-b:v", k, "-minrate", k, "-maxrate", k, "-bufsize", `${VERTICAL_KBPS * 2}k`]
  // VideoToolbox: hardware encode on the Mac (a fraction of libx264's CPU). maxrate/bufsize cap the rate; -realtime keeps up.
  if (encoder === "videotoolbox") return ["-c:v", "h264_videotoolbox", "-realtime", "1", "-allow_sw", "1", "-prio_speed", "1", "-profile:v", "high", ...cbr, "-bf", "0", "-g", gop, "-force_key_frames", `expr:gte(t,n_forced*${VERTICAL_GOP_SEC})`]
  return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "high", ...cbr, "-x264-params", "nal-hrd=cbr:force-cfr=1", "-g", gop, "-keyint_min", gop, "-sc_threshold", "0", "-force_key_frames", `expr:gte(t,n_forced*${VERTICAL_GOP_SEC})`]
}

export function audioArgs(copy: boolean): string[] {
  // Re-encode: aresample=async=1 stretches/pads audio back onto the video clock after an input gap
  // (Wi-Fi drop), first_pts=0 starts it at 0 with the video. Copy can't be filtered, so it skips this.
  return copy ? ["-c:a", "copy"] : ["-af", "aresample=async=1:first_pts=0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]
}

/** The vertical ffmpeg argv: capture in, 9:16 out to the relay path /vertical only (its read/publish logins are argv; the loop redacts them). */
export function verticalCommand(input: { readUrl: string; publishUrl: string; bg: string; encoder: "libx264" | "videotoolbox"; audioCopy: boolean; ffmpeg?: string }): string[] {
  return [input.ffmpeg ?? "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info", "-nostats", "-progress", "pipe:1", "-stats_period", "5",
    "-rw_timeout", "10000000", "-i", input.readUrl,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", verticalFilter(input.bg), "-r", String(VERTICAL_FPS), "-pix_fmt", "yuv420p",
    ...videoArgs(input.encoder),
    ...audioArgs(input.audioCopy),
    "-f", "flv", "-flvflags", "no_duration_filesize", "-rw_timeout", "15000000", input.publishUrl]
}

/** Copy only what MediaMTX reports as AAC (capture sends AAC 48k stereo); anything else is re-encoded. */
export function decideAudioCopy(mode: VerticalAudio, tracks: string[]): boolean {
  if (mode === "copy") return true
  // auto/aac: re-encode, so audio can be realigned after gaps (see audioArgs). Copy only when asked.
  void tracks
  return false
}

/** Pure: fps / speed / frames from the last -progress block (kbps shown is the CBR target). */
export function verticalProgress(text: string): { fps: number | null; speed: number | null; frame: number | null; drop: number | null; dup: number | null } {
  const blocks = text.split(/progress=(?:continue|end)/)
  const last = blocks.length > 1 ? blocks[blocks.length - 2] : ""
  const num = (key: string) => { const m = new RegExp(`(?:^|\\n)${key}=\\s*([\\d.]+)`).exec(last); return m ? Number(m[1]) : null }
  return { fps: num("fps"), speed: num("speed"), frame: num("frame"), drop: num("drop_frames"), dup: num("dup_frames") }
}

export function verticalHealth(p: ReturnType<typeof verticalProgress>, ageMs: number | null): HealthStats {
  if (p.fps === null) return { ...EMPTY_HEALTH, ageMs }
  const warnings: string[] = []
  let level: HealthStats["level"] = "ok"
  const flag = (bad: boolean, text: string) => { warnings.push(text); if (bad) level = "bad"; else if (level === "ok") level = "warn" }
  if (p.speed !== null && p.speed < 0.97) flag(p.speed < 0.9, `encoder speed ${p.speed.toFixed(2)}x (CPU can't keep up)`)
  if (p.fps < VERTICAL_FPS - 2) flag(p.fps < VERTICAL_FPS * 0.8, `${p.fps.toFixed(1)} fps (want ${VERTICAL_FPS})`)
  return { ...EMPTY_HEALTH, fps: p.fps, kbps: VERTICAL_KBPS, speed: p.speed, dup: p.dup, drop: p.drop, ageMs: ageMs === null ? null : Math.round(ageMs), level, warnings }
}

// ---------- settings + processes ----------

type Pidfile = { pid: number; startedAt: number; tag: string; adopted?: boolean; relay?: boolean; encoder?: string; audioCopy?: boolean; bg?: string; command?: string }
type LoopState = { state: "running" | "waiting"; restarts: number; reconnects?: number; updatedAt: number; lastExit: number | null }

function ensureDir() {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
}
function writePrivate(target: string, content: string) {
  ensureDir()
  fs.writeFileSync(`${target}.tmp`, content, { mode: 0o600 })
  fs.renameSync(`${target}.tmp`, target)
  fs.chmodSync(target, 0o600)
}
function readJson<T>(target: string): T | null {
  try { return JSON.parse(fs.readFileSync(target, "utf8")) as T } catch { return null }
}

export function readVerticalSettings(): VerticalSettings {
  const raw = readJson(file("settings.json"))
  const legacy = legacyDestIds(raw)
  const s = parseVerticalSettings(raw)
  if (legacy.length) {
    // One-time migration: old direct ticks → /vertical forwards (unknown ids dropped), then forget them.
    const known = new Set(listDestinations().items.map((d) => d.id))
    addVerticalForwards(legacy.filter((id) => known.has(id)))
    writePrivate(file("settings.json"), JSON.stringify(s, null, 2))
  }
  return s
}

/** auto = VideoToolbox on macOS (hardware: libx264 1080x1920 ran at 0.97x there), libx264 elsewhere. Both selectable. */
export function resolveEncoder(choice: VerticalEncoder, platform: string = process.platform): "libx264" | "videotoolbox" {
  if (choice === "libx264" || choice === "videotoolbox") return choice
  return platform === "darwin" ? "videotoolbox" : "libx264"
}

/** Our pidfile, only if its pid still runs relay-loop.sh. A stale one (reboot, crash, reused pid) is removed, never signalled. */
function loopAlive(): Pidfile | null {
  const meta = readJson<Pidfile>(file("vertical.json"))
  if (!meta?.pid) return null
  if (pidRunsScript(meta.pid, LOOP())) return meta
  fs.rmSync(file("vertical.json"), { force: true })
  return null
}

/** Pidfile gone but our loop runs (server restarted): take it back. Several = kill the extras. */
async function adopt(): Promise<Pidfile | null> {
  const live = loopAlive()
  const loops = findRelayLoops().filter((l) => VERTICAL_TAG_RE.test(l.tag))
  for (const extra of loops.filter((l) => l.pid !== live?.pid).slice(live ? 0 : 1)) await killGroup(extra.pid)
  if (live || loops.length === 0) return live
  const meta: Pidfile = { pid: loops[0].pid, startedAt: Date.now(), tag: loops[0].tag, adopted: true }
  writePrivate(file("vertical.json"), JSON.stringify(meta))
  return meta
}

const gate = { inFlight: null as "start" | "stop" | null, chain: Promise.resolve() as Promise<unknown> }
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = gate.chain.then(task, task)
  gate.chain = run.catch(() => undefined)
  return run
}

export type VerticalResult = { ok: true; note?: string } | { ok: false; error: string; status: number }

export function saveVerticalSettings(patch: unknown): Promise<VerticalResult> {
  return withLock(async () => {
    const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {}
    const next = parseVerticalSettings({ ...readVerticalSettings(), ...p })
    writePrivate(file("settings.json"), JSON.stringify(next, null, 2))
    return { ok: true, note: loopAlive() ? "Saved. Bars/encoder/audio apply on the next start (destinations apply live)." : "Saved." }
  })
}

export function startVertical(): Promise<VerticalResult> {
  if (gate.inFlight) return Promise.resolve({ ok: false, status: 409, error: gate.inFlight === "start" ? "Vertical is already starting." : "Vertical is still stopping." })
  gate.inFlight = "start"
  return withLock(async (): Promise<VerticalResult> => {
    if (await adopt()) return { ok: true, note: "Vertical is already running." }
    const settings = readVerticalSettings()
    if (!ffmpegAvailable({ fresh: true })) return { ok: false, status: 500, error: "ffmpeg is not installed on this machine." }
    const up = await ensureRelayServer()
    if (!up.ok) return up
    const tracks = (await mediamtxPathStats())?.paths.find((p) => p.name === "capture")?.tracks ?? []
    const audioCopy = decideAudioCopy(settings.audio, tracks)
    const encoder = resolveEncoder(settings.encoder)
    const command = verticalCommand({ readUrl: relayReadUrl("capture"), publishUrl: relayPublishUrl(VERTICAL_PATH), bg: settings.bg, encoder, audioCopy, ffmpeg: process.env.FFMPEG_BIN || "ffmpeg" })
    const tag = "vertical:dest=relay"
    ensureDir()
    const log = file("vertical.log")
    fs.writeFileSync(log, "", { mode: 0o600 })
    fs.chmodSync(log, 0o600)
    const out = fs.openSync(log, "a")
    const child = spawn("bash", [LOOP(), tag, "--", ...command], {
      cwd: dir(), detached: true, stdio: ["ignore", out, out],
      env: relayChildEnv({ LOOP_STATE_FILE: file("vertical-state.json"), LOOP_REDACT: "1", LOOP_MAX_DELAY: "5", LOOP_WATCH_LOG: log, LOOP_WATCH_KEY: "out_time_us", LOOP_STALL_SECS: "25", LOOP_STALL_GRACE: "30" }),
    })
    fs.closeSync(out)
    child.unref()
    if (!child.pid) return { ok: false, status: 500, error: "Could not start the vertical ffmpeg." }
    writePrivate(file("vertical.json"), JSON.stringify({ pid: child.pid, startedAt: Date.now(), tag, relay: true, encoder, audioCopy, bg: settings.bg, command: redactCommand(command) } satisfies Pidfile))
    // Ticked /vertical forwards start as soon as the encoder is up (they wait for the path, then connect).
    void reconcileRelay(true).catch(() => undefined)
    return { ok: true, note: `Vertical started → relay /vertical (${encoder}, audio ${audioCopy ? "copy" : "AAC"}). Ticked destinations connect as soon as /vertical is publishing.` }
  }).finally(() => { gate.inFlight = null })
}

export function stopVertical(): Promise<VerticalResult> {
  if (gate.inFlight === "start") return Promise.resolve({ ok: false, status: 409, error: "Vertical is still starting. Wait, then stop." })
  gate.inFlight = "stop"
  return withLock(async (): Promise<VerticalResult> => {
    const meta = await adopt()
    if (meta) await killGroup(meta.pid)
    for (const name of ["vertical.json", "vertical-state.json"]) fs.rmSync(file(name), { force: true })
    void reconcileRelay(true).catch(() => undefined) // its forwards go back to "waiting for /vertical"
    return { ok: true, note: meta ? "Vertical stopped. Its destinations wait until it starts again." : "Vertical was not running." }
  }).finally(() => { gate.inFlight = null })
}

/** Shell-quoted, keys redacted: what the desk shows as "ffmpeg command". */
export function redactCommand(argv: string[]): string {
  return redact(argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ")).replace(/(user|pass)=[^&\s']+/g, "$1=••••")
}

function tail(bytes = 16384): string {
  try {
    const target = file("vertical.log")
    const size = fs.statSync(target).size
    const fd = fs.openSync(target, "r")
    const buffer = Buffer.alloc(Math.min(bytes, size))
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length))
    fs.closeSync(fd)
    return redact(buffer.toString("utf8"))
  } catch {
    return ""
  }
}
function logAgeMs(): number | null {
  try { return Date.now() - fs.statSync(file("vertical.log")).mtimeMs } catch { return null }
}

export type VerticalStatus = {
  running: boolean
  state: ForwardState
  adopted: boolean
  restarts: number
  reconnects: number
  sourceReady: boolean
  /** /vertical has a publisher (MediaMTX ready) */
  publishing: boolean
  encoder: string | null
  /** what Auto resolves to on this server */
  autoEncoder: "libx264" | "videotoolbox"
  audio: "copy" | "aac" | null
  bg: string | null
  settings: VerticalSettings
  health: HealthStats
  error: string | null
  command: string | null
  logTail: string
}

export async function verticalStatus(): Promise<VerticalStatus> {
  const meta = await withLock(adopt)
  const settings = readVerticalSettings()
  const loop = readJson<LoopState>(file("vertical-state.json"))
  const stats = meta ? await mediamtxPathStats() : null
  const capture = stats?.paths.find((p) => p.name === "capture")
  const publishing = stats?.paths.find((p) => p.name === VERTICAL_PATH)?.ready === true
  const sourceReady = capture?.ready === true
  const text = meta ? tail() : ""
  const lines = text.split(/[\r\n]+/).filter(Boolean)
  const state = deriveForwardState({ running: meta !== null, loop, sourceReady, logAgeMs: logAgeMs(), lastLine: lines.at(-1) ?? "", runAgeMs: loop?.updatedAt ? Date.now() - loop.updatedAt * 1000 : null })
  const errorLine = [...lines].reverse().find((l) => /error|failed|refused|timed out|denied|not found/i.test(l) && !/^\[relay-loop/.test(l))
  const health = meta && sourceReady ? verticalHealth(verticalProgress(text), logAgeMs()) : EMPTY_HEALTH
  return {
    running: meta !== null, state, adopted: meta?.adopted === true, restarts: loop?.restarts ?? 0, reconnects: loop?.reconnects ?? 0, sourceReady,
    publishing, encoder: meta?.encoder ?? null, autoEncoder: resolveEncoder("auto"), audio: meta ? (meta.audioCopy === undefined ? null : meta.audioCopy ? "copy" : "aac") : null, bg: meta?.bg ?? null,
    settings, health,
    error: state === "forwarding" || state === "off" ? null : (errorLine?.slice(0, 200) ?? null),
    command: meta?.command ?? null,
    logTail: lines.filter((l) => !/^[a-z_]+=/.test(l)).slice(-12).join("\n").slice(-1500),
  }
}
