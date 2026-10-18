/**
 * Vertical (9:16) output: a separate ffmpeg that READS the Browser capture path from the local
 * MediaMTX relay (rtmp://127.0.0.1:19350/capture, read credentials), fits the whole 16:9 picture
 * into 1080x1920 (centred, bars top/bottom) and pushes it to its own destination list.
 *
 * It never touches the capture or slate pipelines: it is just another reader of /capture, under its
 * own restart loop (scripts/relay-loop.sh, tag "vertical:dest=<fingerprint>", same backoff and stall
 * watchdog as the relay forwards). Files live in data/vertical/ (0600): settings.json, vertical.json
 * (pidfile), vertical.log, vertical-state.json.
 */
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { allowedRtmpHost, destinationFingerprint, directChannelDests, ffmpegAvailable, killGroup, pidRunsScript, redact, relayChildEnv, validateRtmpUrl } from "@/lib/encoder"
import { deriveForwardState, ensureRelayServer, findRelayLoops, mediamtxPathStats, relayForwardFingerprints, relayReadUrl, type ForwardState } from "@/lib/relay"
import { listDestinations, resolveDestination } from "@/lib/rtmp-destinations"
import { EMPTY_HEALTH, type HealthStats } from "@/lib/stream-health"

export const VERTICAL_W = 1080
export const VERTICAL_H = 1920
export const VERTICAL_FPS = 30
export const VERTICAL_KBPS = 4500
export const VERTICAL_GOP_SEC = 2
export const VERTICAL_MAX_DESTS = 4
export const VERTICAL_BG_PRESETS = ["#000000", "#0000B6"] as const
export type VerticalEncoder = "auto" | "libx264" | "videotoolbox"
export type VerticalAudio = "auto" | "copy" | "aac"
export type VerticalSettings = { destIds: string[]; bg: string; encoder: VerticalEncoder; audio: VerticalAudio }
export const DEFAULT_VERTICAL: VerticalSettings = { destIds: [], bg: "#000000", encoder: "auto", audio: "auto" }

const root = () => process.cwd()
const dir = () => path.join(process.env.STREAM_DATA_DIR || path.join(root(), "data"), "vertical")
const file = (name: string) => path.join(dir(), name)
const LOOP = () => process.env.RELAY_LOOP_SCRIPT || path.join(root(), "scripts", "relay-loop.sh")
export const VERTICAL_TAG_RE = /^vertical:dest=[0-9a-f]{16}$/

// ---------- pure ----------

export function cleanBg(value: unknown, fallback = DEFAULT_VERTICAL.bg): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toUpperCase() : fallback
}
export function parseVerticalSettings(raw: unknown): VerticalSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const ids = Array.isArray(r.destIds) ? [...new Set(r.destIds.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id)))].slice(0, VERTICAL_MAX_DESTS) : []
  return {
    destIds: ids,
    bg: cleanBg(r.bg),
    encoder: r.encoder === "libx264" || r.encoder === "videotoolbox" ? r.encoder : "auto",
    audio: r.audio === "copy" || r.audio === "aac" ? r.audio : "auto",
  }
}

/** Fit the whole 16:9 frame into 1080x1920: scale to 1080 wide (even height), pad centred with `bg`. */
export function verticalFilter(bg: string): string {
  const color = `0x${cleanBg(bg).slice(1)}`
  return `scale=${VERTICAL_W}:-2:flags=bicubic,pad=${VERTICAL_W}:${VERTICAL_H}:(ow-iw)/2:(oh-ih)/2:color=${color},fps=${VERTICAL_FPS},format=yuv420p,setsar=1`
}

/** The tee muxer splits its target on | and treats [ ] \ specially: such URLs can't be a vertical destination. */
export function teeSafeUrl(url: string): boolean {
  return !/[|[\]\\]/.test(url)
}

/** One encode, several RTMP outputs. With 2+ outputs one failing ingest must not drop the others. */
export function teeTarget(urls: string[]): string {
  const onfail = urls.length > 1 ? "ignore" : "abort"
  return urls.map((url) => `[f=flv:flvflags=no_duration_filesize:onfail=${onfail}]${url}`).join("|")
}

export function videoArgs(encoder: "libx264" | "videotoolbox"): string[] {
  const k = `${VERTICAL_KBPS}k`
  const gop = String(VERTICAL_FPS * VERTICAL_GOP_SEC)
  const cbr = ["-b:v", k, "-minrate", k, "-maxrate", k, "-bufsize", `${VERTICAL_KBPS * 2}k`]
  if (encoder === "videotoolbox") return ["-c:v", "h264_videotoolbox", "-realtime", "1", "-allow_sw", "1", "-profile:v", "high", ...cbr, "-g", gop, "-force_key_frames", `expr:gte(t,n_forced*${VERTICAL_GOP_SEC})`]
  return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "high", ...cbr, "-x264-params", "nal-hrd=cbr:force-cfr=1", "-g", gop, "-keyint_min", gop, "-sc_threshold", "0"]
}

export function audioArgs(copy: boolean): string[] {
  return copy ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]
}

/** The vertical ffmpeg argv. Destination URLs (with keys) are argv entries; the loop redacts them in its log. */
export function verticalCommand(input: { readUrl: string; urls: string[]; bg: string; encoder: "libx264" | "videotoolbox"; audioCopy: boolean; ffmpeg?: string }): string[] {
  return [input.ffmpeg ?? "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info", "-nostats", "-progress", "pipe:1", "-stats_period", "5",
    "-rw_timeout", "10000000", "-i", input.readUrl,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", verticalFilter(input.bg), "-r", String(VERTICAL_FPS), "-pix_fmt", "yuv420p",
    ...videoArgs(input.encoder),
    ...audioArgs(input.audioCopy),
    "-f", "tee", teeTarget(input.urls)]
}

/** Copy only what MediaMTX reports as AAC (capture sends AAC 48k stereo); anything else is re-encoded. */
export function decideAudioCopy(mode: VerticalAudio, tracks: string[]): boolean {
  if (mode === "copy") return true
  if (mode === "aac") return false
  // Capture not publishing yet: it always sends AAC 48k stereo, so copy.
  if (tracks.length === 0) return true
  return tracks.some((t) => /^(MPEG-4 Audio|AAC)$/i.test(t))
}

/** Pure: fps / speed / frames from the last -progress block (the tee muxer reports total_size=N/A, so kbps is the CBR target). */
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

export function combinedFingerprint(urls: string[]): string {
  return crypto.createHash("sha256").update(urls.map((u) => destinationFingerprint(u)).sort().join(",")).digest("hex").slice(0, 16)
}

/** Pure: a vertical destination that some other output already publishes to (one publisher per key). */
export function verticalConflict(fingerprints: string[], forwards: { path: string; dest: string }[], direct: { channel: string; running: boolean; dest?: string; relay?: boolean }[]): string | null {
  for (const fp of fingerprints) {
    const fwd = forwards.find((f) => f.dest === fp)
    if (fwd) return `Relay /${fwd.path} already forwards to one of these destinations. One stream key takes one publisher.`
    const ch = direct.find((d) => d.running && !d.relay && d.dest === fp)
    if (ch) return `The ${ch.channel === "capture" ? "Browser capture" : "Slate"} stream publishes to one of these destinations. Pick a different one for Vertical.`
  }
  return null
}

// ---------- settings + processes ----------

type Pidfile = { pid: number; startedAt: number; tag: string; adopted?: boolean; hosts?: string[]; encoder?: string; audioCopy?: boolean; bg?: string; command?: string }
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
  const s = parseVerticalSettings(readJson(file("settings.json")))
  const known = new Set(listDestinations().items.map((d) => d.id))
  return { ...s, destIds: s.destIds.filter((id) => known.has(id)) }
}

/** auto = libx264 (strict CBR via nal-hrd). VideoToolbox is opt-in: much lighter on a Mac, but rate control is average/max, not strict CBR. */
export function resolveEncoder(choice: VerticalEncoder): "libx264" | "videotoolbox" {
  return choice === "videotoolbox" ? "videotoolbox" : "libx264"
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
    const cur = readVerticalSettings()
    const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {}
    const next = parseVerticalSettings({ ...cur, ...p })
    for (const id of next.destIds) {
      const d = resolveDestination(id)
      if (!d) return { ok: false, status: 404, error: "No such destination." }
      if (!teeSafeUrl(d.url)) return { ok: false, status: 400, error: `${d.name}: its URL contains | [ ] or \\, which the vertical output can't send to.` }
    }
    writePrivate(file("settings.json"), JSON.stringify(next, null, 2))
    return { ok: true, note: loopAlive() ? "Saved. Stop and start Vertical to apply." : "Saved." }
  })
}

export function startVertical(): Promise<VerticalResult> {
  if (gate.inFlight) return Promise.resolve({ ok: false, status: 409, error: gate.inFlight === "start" ? "Vertical is already starting." : "Vertical is still stopping." })
  gate.inFlight = "start"
  return withLock(async (): Promise<VerticalResult> => {
    if (await adopt()) return { ok: true, note: "Vertical is already running. Stop it first to change destinations." }
    const settings = readVerticalSettings()
    const dests = settings.destIds.map((id) => resolveDestination(id)).filter((d): d is NonNullable<typeof d> => d !== null)
    if (dests.length === 0) return { ok: false, status: 400, error: "Tick at least one vertical destination." }
    for (const d of dests) {
      const checked = validateRtmpUrl(d.url)
      if (!checked.ok) return { ok: false, status: 400, error: `${d.name}: ${checked.error}` }
      if (!allowedRtmpHost(d.url)) return { ok: false, status: 400, error: `${d.name}: that RTMP host is not allowed (RTMP_ALLOWED_HOSTS).` }
      if (!teeSafeUrl(d.url)) return { ok: false, status: 400, error: `${d.name}: its URL contains | [ ] or \\.` }
    }
    const fps = dests.map((d) => destinationFingerprint(d.url))
    const clash = verticalConflict(fps, relayForwardFingerprints(), directChannelDests())
    if (clash) return { ok: false, status: 409, error: clash }
    if (!ffmpegAvailable({ fresh: true })) return { ok: false, status: 500, error: "ffmpeg is not installed on this machine." }
    const up = await ensureRelayServer()
    if (!up.ok) return up
    const tracks = (await mediamtxPathStats())?.paths.find((p) => p.name === "capture")?.tracks ?? []
    const audioCopy = decideAudioCopy(settings.audio, tracks)
    const encoder = resolveEncoder(settings.encoder)
    const command = verticalCommand({ readUrl: relayReadUrl("capture"), urls: dests.map((d) => d.url), bg: settings.bg, encoder, audioCopy, ffmpeg: process.env.FFMPEG_BIN || "ffmpeg" })
    const tag = `vertical:dest=${combinedFingerprint(dests.map((d) => d.url))}`
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
    writePrivate(file("vertical.json"), JSON.stringify({ pid: child.pid, startedAt: Date.now(), tag, hosts: dests.map((d) => { try { return new URL(d.url).host } catch { return "?" } }), encoder, audioCopy, bg: settings.bg, command: redactCommand(command) } satisfies Pidfile))
    return { ok: true, note: `Vertical started → ${dests.length} destination${dests.length === 1 ? "" : "s"} (${encoder}, audio ${audioCopy ? "copy" : "AAC"}).` }
  }).finally(() => { gate.inFlight = null })
}

export function stopVertical(): Promise<VerticalResult> {
  if (gate.inFlight === "start") return Promise.resolve({ ok: false, status: 409, error: "Vertical is still starting. Wait, then stop." })
  gate.inFlight = "stop"
  return withLock(async (): Promise<VerticalResult> => {
    const meta = await adopt()
    if (meta) await killGroup(meta.pid)
    for (const name of ["vertical.json", "vertical-state.json"]) fs.rmSync(file(name), { force: true })
    return { ok: true, note: meta ? "Vertical stopped." : "Vertical was not running." }
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
  hosts: string[]
  encoder: string | null
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
  const capture = meta ? (await mediamtxPathStats())?.paths.find((p) => p.name === "capture") : undefined
  const sourceReady = capture?.ready === true
  const text = meta ? tail() : ""
  const lines = text.split(/[\r\n]+/).filter(Boolean)
  const state = deriveForwardState({ running: meta !== null, loop, sourceReady, logAgeMs: logAgeMs(), lastLine: lines.at(-1) ?? "", runAgeMs: loop?.updatedAt ? Date.now() - loop.updatedAt * 1000 : null })
  const errorLine = [...lines].reverse().find((l) => /error|failed|refused|timed out|denied|not found/i.test(l) && !/^\[relay-loop/.test(l))
  const health = meta && sourceReady ? verticalHealth(verticalProgress(text), logAgeMs()) : EMPTY_HEALTH
  return {
    running: meta !== null, state, adopted: meta?.adopted === true, restarts: loop?.restarts ?? 0, reconnects: loop?.reconnects ?? 0, sourceReady,
    hosts: meta?.hosts ?? [], encoder: meta?.encoder ?? null, audio: meta ? (meta.audioCopy === undefined ? null : meta.audioCopy ? "copy" : "aac") : null, bg: meta?.bg ?? null,
    settings, health,
    error: state === "forwarding" || state === "off" ? null : (errorLine?.slice(0, 200) ?? null),
    command: meta?.command ?? null,
    logTail: lines.filter((l) => !/^[a-z_]+=/.test(l)).slice(-12).join("\n").slice(-1500),
  }
}
