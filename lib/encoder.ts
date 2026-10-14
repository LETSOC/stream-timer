import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EncoderStatus } from "@/lib/encoder-status";
import { programReadFile, relayForwardFingerprints, relayProcessGroups } from "@/lib/relay";
import { audioHash, prepareChannelAudio, readAudioSettings, type AudioMode } from "@/lib/audio-bed";
import { captureSourceHealth, EMPTY_HEALTH, healthFromSamples, parseStatsLines, type CaptureSourceStats, type HealthStats, type SourceHealth } from "@/lib/stream-health";

export const ROOT = process.cwd();
// Overridable so the lifecycle tests can use a temp dir and fake scripts.
export const DATA_DIR = process.env.STREAM_DATA_DIR || path.join(ROOT, "data");
export const HLS_DIR = path.join(DATA_DIR, "hls");
export const META_FILE = path.join(DATA_DIR, "encoder.json");
export const LOG_FILE = path.join(DATA_DIR, "encoder.log");
export const RTMP_META_FILE = path.join(DATA_DIR, "rtmp.json");
export const RTMP_LOG_FILE = path.join(DATA_DIR, "rtmp.log");
export const RTMP_STATE_FILE = path.join(DATA_DIR, "rtmp-supervisor.json");
export const RTMP_FAIL_FILE = path.join(DATA_DIR, "rtmp-failed.json");
export const SCRIPT = process.env.STREAM_SCRIPT || path.join(ROOT, "scripts", "stream-countdown.sh");
export const SUPERVISOR = process.env.STREAM_SUPERVISOR || path.join(ROOT, "scripts", "rtmp-supervisor.sh");
const STOP_GRACE_MS = Number(process.env.STREAM_STOP_GRACE_MS) || 3000;
const STARTUP_WAIT_MS = Number(process.env.STREAM_STARTUP_WAIT_MS) || 1500;
const HLS_STALL_MS = 8000;

type Meta = {
  pid: number;
  startedAt: number;
  eventName: string;
  dateLine: string;
  targetUnix: number;
  burnedRemainingAtStart: number;
  refreshSeconds: number;
};

export type StartInput = {
  eventName: string;
  dateLine: string;
  targetUnix: number;
  refreshSeconds: number;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hides passwords and stream keys: everything after the host in an rtmp(s) URL, plus any password= value. */
export function redact(text: string): string {
  return text
    .replace(/(rtmps?:\/\/[^\s/'"]+)\/[^\s'"]*/gi, "$1/••••")
    .replace(/(password=)[^\s&'"]+/gi, "$1••••");
}

/** Child processes never need the encoder token. */
export function relayChildEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return childEnv(extra)
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.ENCODER_TOKEN;
  return env;
}

/**
 * Confirms a pid from a pidfile still belongs to our script, so a stale pidfile
 * after a reboot or crash can never make us signal an unrelated process that
 * reused the pid.
 */
export function pidRunsScript(pid: number, scriptPath: string): boolean {
  if (!alive(pid)) return false;
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return result.stdout.includes(path.basename(scriptPath));
}

export type StopResult = { forced: boolean; survived: boolean }

/** SIGTERM the process group, wait up to `graceMs`, then SIGKILL whatever is left. */
export async function killGroup(pid: number, graceMs = STOP_GRACE_MS): Promise<StopResult> {
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch { /* already gone */ } }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return { forced: false, survived: false };
    await delay(50);
  }
  signal("SIGKILL");
  const hardDeadline = Date.now() + 1000;
  while (Date.now() < hardDeadline && groupAlive(pid)) await delay(50);
  return { forced: true, survived: groupAlive(pid) };
}

/**
 * Ours if the leader still runs our script, or if the leader is gone but its
 * process group lives on (an orphaned ffmpeg). A pgid in use cannot be handed to a
 * new process, so the second case cannot hit an unrelated program.
 */
function ownsGroup(pid: number, scriptPath: string): boolean {
  if (pidRunsScript(pid, scriptPath)) return true
  if (alive(pid)) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

const NOT_STOPPED: StopResult = { forced: false, survived: false }
let lastStopNote: string | null = null

function noteStop(kind: string, result: StopResult): StopResult {
  if (result.survived) lastStopNote = `The ${kind} did not exit even after SIGKILL. Check Activity Monitor for ffmpeg.`
  else if (result.forced) lastStopNote = `The ${kind} ignored SIGTERM and was force-killed (SIGKILL).`
  else lastStopNote = null
  return result
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return alive(pgid);
  }
}

/** Serialises encoder start/restart/stop so concurrent requests or tabs cannot launch two ffmpegs. */
let encoderLock: Promise<unknown> = Promise.resolve();
function withEncoderLock<T>(task: () => Promise<T>): Promise<T> {
  const run = encoderLock.then(task, task);
  encoderLock = run.catch(() => undefined);
  return run;
}

function readMeta(): Meta | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(META_FILE, "utf8")) as Meta;
    if (!parsed || typeof parsed.pid !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function playlistReady(): boolean {
  try {
    return /\.ts/.test(fs.readFileSync(path.join(HLS_DIR, "stream.m3u8"), "utf8"));
  } catch {
    return false;
  }
}

/** Reads at most the last `maxBytes` of a file, so a long-running log costs the same to read as a short one. */
export function readTail(file: string, maxBytes = 8192): string {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, "r")
    const { size } = fs.fstatSync(fd)
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    return buffer.toString("utf8")
  } catch {
    return ""
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function tailLog(): string {
  return redact(readTail(LOG_FILE).split(/\r?\n/).slice(-30).join("\n").slice(-4000))
}

let ffmpegCache: { value: boolean; until: number } = { value: false, until: 0 }

/**
 * The desk polls status every couple of seconds; spawning ffmpeg each time blocked
 * the server for ~50ms. Found is cached 60s, missing 5s (so installing ffmpeg shows
 * up quickly). Explicit starts pass `fresh` to skip the cache.
 */
export function ffmpegAvailable(options: { fresh?: boolean } = {}): boolean {
  if (!options.fresh && Date.now() < ffmpegCache.until) return ffmpegCache.value
  const found = spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" }).status === 0
  ffmpegCache = { value: found, until: Date.now() + (found ? 60_000 : 5_000) }
  return found
}

export type RtmpUrlCheck = { ok: true; url: string } | { ok: false; error: string }

/**
 * Parses an ingest URL with the WHATWG parser. rtmp/rtmps only, a real host,
 * optional port 1-65535, no user:pass@ (Castr and most ingests put the key in the
 * path or ?password=). Errors never echo the URL, so credentials cannot leak.
 */
export function validateRtmpUrl(raw: string): RtmpUrlCheck {
  const value = raw.trim()
  if (!value) return { ok: false, error: "Paste the RTMP ingest URL." }
  if (/\s/.test(value)) return { ok: false, error: "The RTMP URL must not contain spaces." }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, error: "That is not a valid URL." }
  }
  if (url.protocol !== "rtmp:" && url.protocol !== "rtmps:") return { ok: false, error: "Use an rtmp:// or rtmps:// URL." }
  const host = url.hostname
  const ipv6 = host.startsWith("[") && host.endsWith("]")
  if (!host || (!ipv6 && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host))) {
    return { ok: false, error: "The RTMP URL needs a valid host name." }
  }
  if (url.port && (Number(url.port) < 1 || Number(url.port) > 65535)) return { ok: false, error: "The RTMP port must be 1-65535." }
  if (url.username || url.password) return { ok: false, error: "Remove user:password@ from the RTMP URL; put the key in the path or ?password= instead." }
  if (url.pathname.length <= 1) return { ok: false, error: "The RTMP URL needs an app/stream key path." }
  return { ok: true, url: value }
}

export function readStatus(): EncoderStatus {
  const meta = readMeta();
  const slate = readChannelStatus("slate");
  const capture = readChannelStatus("capture");
  const running = meta ? pidRunsScript(meta.pid, SCRIPT) : false;
  const hls = hlsHealth(running, meta?.startedAt ?? null);
  if (meta && !running) {
    // Leader gone but ffmpeg orphaned in its group: clean it up.
    if (ownsGroup(meta.pid, SCRIPT)) void killGroup(meta.pid);
    try {
      fs.unlinkSync(META_FILE);
    } catch {
      /* already gone */
    }
  }
  return {
    running,
    playlistReady: playlistReady(),
    pid: running && meta ? meta.pid : null,
    logTail: tailLog(),
    ffmpeg: ffmpegAvailable(),
    eventName: running && meta ? meta.eventName : null,
    dateLine: running && meta ? meta.dateLine : null,
    targetUnix: running && meta ? meta.targetUnix : null,
    startedAt: running && meta ? meta.startedAt : null,
    slateAgeSeconds: running && meta ? Math.floor((Date.now() - meta.startedAt) / 1000) : null,
    burnedRemainingAtStart: running && meta ? meta.burnedRemainingAtStart : null,
    refreshSeconds: running && meta ? meta.refreshSeconds : null,
    encoderState: hls,
    // Top-level rtmp* fields describe the Slate channel (as before); rtmpChannels has both.
    rtmpState: slate.state,
    rtmpAdopted: slate.adopted,
    rtmpSource: slate.running ? "slate" : capture.running ? "capture" : null,
    rtmpOwnProcesses: ownSupervisorCount(),
    stopNote: lastStopNote,
    rtmpRunning: slate.running,
    rtmpReconnecting: slate.reconnecting,
    rtmpRestarts: slate.restarts,
    rtmpConnectError: slate.connectError,
    rtmpFailure: slate.failure,
    rtmpLogTail: slate.logTail,
    rtmpChannels: { slate, capture },
    strayPublishers: findStrayPublishers(),
  };
}

/** HLS preview health: the playlist must keep being rewritten (every ~2s segment). */
function hlsHealth(running: boolean, startedAt: number | null): EncoderStatus["encoderState"] {
  if (!running) return "stopped"
  let mtime = 0
  try {
    mtime = fs.statSync(path.join(HLS_DIR, "stream.m3u8")).mtimeMs
  } catch {
    /* not written yet */
  }
  if (!mtime) return startedAt !== null && Date.now() - startedAt > HLS_STALL_MS * 2 ? "stalled" : "starting"
  return Date.now() - mtime > HLS_STALL_MS ? "stalled" : "running"
}

/**
 * starting: supervisor up, ffmpeg not yet sending frames this run.
 * connected: the current run opened the output and reports progress.
 * reconnecting: ffmpeg exited and the supervisor is waiting to relaunch.
 * failed: the last start gave up (bad URL/key, refused); stopped: nothing running.
 */
/** ffmpeg prints progress every 10s (-stats_period 10); no new log line for this long means it's stuck. */
export const RTMP_LOG_STALE_MS = 35_000
/** A run that hasn't sent a frame within this long is reported as failed instead of "Connecting" forever. */
export const RTMP_CONNECT_TIMEOUT_MS = 45_000

export function deriveRtmpState(
  running: boolean,
  supervisorState: "running" | "waiting" | null,
  log: string,
  failure: string | null,
  timing: { logAgeMs?: number | null; runAgeMs?: number | null } = {},
): EncoderStatus["rtmpState"] {
  if (!running) return failure ? "failed" : "stopped"
  if (supervisorState === "waiting") return "reconnecting"
  const lastStart = Math.max(log.lastIndexOf("supervisor started"), log.lastIndexOf("] ffmpeg exited"))
  const currentRun = lastStart >= 0 ? log.slice(lastStart) : log
  // Progress lines only appear once ffmpeg has opened the RTMP output, so they alone mean "sending".
  // (Requiring "Output #0" too broke long streams: it scrolls out of the 32 KB tail we read.)
  const progress = /(frame=\s*\d+|size=\s*\d+)/.test(currentRun)
  const logAge = timing.logAgeMs ?? 0
  if (progress) return logAge > RTMP_LOG_STALE_MS ? "stalled" : "connected"
  const runAge = timing.runAgeMs ?? logAge
  return runAge > RTMP_CONNECT_TIMEOUT_MS ? "stalled" : "starting"
}

const CONNECT_ERROR = /(Error opening output|Connection refused|Connection timed out|End of file|Input\/output error|Server returned|Failed to resolve|No route to host|Network is unreachable|Operation timed out|Broken pipe)/i

/**
 * When the latest ffmpeg run died before it connected, a short operator message such as
 * "Can't connect to ingest (live.restream.io): End of file". Null while connected or with no failure.
 */
export function parseConnectError(log: string, host: string | null): string | null {
  const exits = [...log.matchAll(/\[supervisor [^\]]*\] ffmpeg exited[^\n]*/g)]
  if (exits.length === 0) return null
  const lastExit = exits[exits.length - 1]
  // A run that started after the last exit and is now sending frames means we recovered.
  const after = log.slice((lastExit.index ?? 0) + lastExit[0].length)
  if (/Output #0/.test(after) && /(frame=\s*\d+|size=\s*\d+)/.test(after)) return null
  const before = log.slice(0, lastExit.index)
  const runStart = Math.max(before.lastIndexOf("supervisor started"), before.lastIndexOf("] ffmpeg exited"))
  const run = runStart >= 0 ? before.slice(runStart) : before
  if (/Output #0/.test(run) && /(frame=\s*\d+|size=\s*\d+)/.test(run)) return null // it was live, then dropped
  const match = run.match(CONNECT_ERROR)
  const reason = match ? match[1] : "ffmpeg exited before connecting"
  return `Can't connect to ingest${host ? ` (${host})` : ""}: ${reason}`
}

// ---------- RTMP channels: Slate and Browser capture run independently ----------

export type RtmpChannel = "slate" | "capture"
export const RTMP_CHANNELS: RtmpChannel[] = ["slate", "capture"]

/** Per-channel files. Slate keeps the original names so an older running stream is still found. */
export function rtmpFiles(ch: RtmpChannel) {
  if (ch === "slate") return { meta: RTMP_META_FILE, log: RTMP_LOG_FILE, state: RTMP_STATE_FILE, fail: RTMP_FAIL_FILE }
  return {
    meta: path.join(DATA_DIR, "rtmp-capture.json"),
    log: path.join(DATA_DIR, "rtmp-capture.log"),
    state: path.join(DATA_DIR, "rtmp-capture-supervisor.json"),
    fail: path.join(DATA_DIR, "rtmp-capture-failed.json"),
    stats: path.join(DATA_DIR, "rtmp-capture-stats.json"),
  }
}

type RtmpMeta = { pid?: number; adopted?: boolean; host?: string; source?: string; size?: string | null; dest?: string; relay?: boolean; bitrateK?: number; encoder?: string; audio?: { mode: AudioMode; hash: string; warning: string | null } }

function readRtmpMeta(ch: RtmpChannel = "slate"): RtmpMeta | null {
  try {
    return JSON.parse(fs.readFileSync(rtmpFiles(ch).meta, "utf8")) as RtmpMeta
  } catch {
    return null
  }
}

function readRtmpHost(ch: RtmpChannel = "slate"): string | null {
  const host = readRtmpMeta(ch)?.host
  return typeof host === "string" ? host : null
}

function readFailure(ch: RtmpChannel = "slate"): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(rtmpFiles(ch).fail, "utf8")) as { error?: unknown }
    return typeof parsed.error === "string" ? parsed.error : "failed"
  } catch {
    return null
  }
}

function writeFailure(error: string, ch: RtmpChannel = "slate") {
  try {
    fs.writeFileSync(rtmpFiles(ch).fail, JSON.stringify({ error: redact(error).slice(0, 500), at: Date.now() }), { mode: 0o600 })
  } catch {
    /* best effort */
  }
}

function clearFailure(ch: RtmpChannel = "slate") {
  try { fs.unlinkSync(rtmpFiles(ch).fail) } catch { /* already gone */ }
}

/** Slate: 2500k video + 128k audio (stream-countdown.sh). Capture: its chosen bitrate + 128k. */
const SLATE_KBPS = 2628
/** Live encoder health for a channel (slate: its ffmpeg stats lines; capture: the capture process's stats file). */
function channelHealth(ch: RtmpChannel, running: boolean, meta: RtmpMeta | null): SourceHealth | HealthStats {
  if (!running) return EMPTY_HEALTH
  const files = rtmpFiles(ch)
  if (ch === "slate") return healthFromSamples(parseStatsLines(readTail(files.log, 32768)), 5, fileAgeMs(files.log), { fps: 30, kbps: SLATE_KBPS })
  let stats: (CaptureSourceStats & { enc?: { fps: number; kbps: number; speed: number; dup: number; drop: number; bytes: number } }) | null = null
  try { stats = JSON.parse(fs.readFileSync((files as { stats: string }).stats, "utf8")) } catch { /* not yet */ }
  if (!stats) return EMPTY_HEALTH
  const enc = stats.enc
  const expectKbps = (meta?.bitrateK ?? stats.bitrateK) + 128
  const encoder: HealthStats = enc
    ? (() => {
        const warnings: string[] = []
        let level: HealthStats["level"] = "ok"
        const flag = (bad: boolean, text: string) => { warnings.push(text); if (bad) level = "bad"; else if (level === "ok") level = "warn" }
        if (enc.speed < 0.97) flag(enc.speed < 0.9, `encoder speed ${enc.speed.toFixed(2)}x`)
        if (enc.fps < stats!.fps - 2) flag(enc.fps < stats!.fps * 0.8, `${enc.fps.toFixed(1)} fps (want ${stats!.fps})`)
        if (enc.kbps < expectKbps * 0.6) flag(enc.kbps < expectKbps * 0.4, `bitrate ${enc.kbps}k (set ${expectKbps}k)`)
        return { fps: enc.fps, kbps: enc.kbps, speed: enc.speed, dup: enc.dup, drop: enc.drop, bytes: enc.bytes, ageMs: Math.round(Date.now() - stats!.at), level, warnings }
      })()
    : { ...EMPTY_HEALTH, ageMs: Date.now() - stats.at }
  return captureSourceHealth(encoder, stats)
}

function channelAudio(ch: RtmpChannel, meta: RtmpMeta | null): { mode: AudioMode; warning: string | null; pending: boolean } {
  const live = meta?.audio
  const saved = audioHash(readAudioSettings().channels[ch])
  const runtimeFallback = /\[audio\] audio (bed file missing|settings unreadable)/.test(readTail(rtmpFiles(ch).log, 16384).split(/supervisor[^\n]*started|Mode: /).pop() ?? "")
  const warning = live?.warning ?? (runtimeFallback ? "Audio bed file went missing; streaming silence." : null)
  return { mode: runtimeFallback ? "silent" : (live?.mode ?? "silent"), warning, pending: live ? live.hash !== saved : false }
}

function forgetChannel(ch: RtmpChannel) {
  try { fs.unlinkSync(rtmpFiles(ch).meta) } catch { /* already gone */ }
  try { fs.unlinkSync(rtmpFiles(ch).state) } catch { /* already gone */ }
}

function readRtmpPid(ch: RtmpChannel = "slate"): number | null {
  const pid = readRtmpMeta(ch)?.pid
  return typeof pid === "number" ? pid : null
}

function rtmpAlive(ch: RtmpChannel = "slate"): boolean {
  const pid = readRtmpPid(ch)
  if (pid === null) return false
  if (pidRunsScript(pid, SUPERVISOR)) return true
  if (ownsGroup(pid, SUPERVISOR)) void killGroup(pid)
  // Stale pidfile (crash, reboot, pid reused): forget it.
  forgetChannel(ch)
  return false
}

export function allowedRtmpHost(url: string): boolean {
  const list = (process.env.RTMP_ALLOWED_HOSTS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)
  if (list.length === 0) return true
  let host = ""
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return list.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

function readSupervisorState(ch: RtmpChannel = "slate"): { state: "running" | "waiting" | null; restarts: number; updatedAt: number | null } {
  try {
    const parsed = JSON.parse(fs.readFileSync(rtmpFiles(ch).state, "utf8")) as { state?: unknown; restarts?: unknown; updatedAt?: unknown }
    return {
      state: parsed.state === "running" || parsed.state === "waiting" ? parsed.state : null,
      restarts: typeof parsed.restarts === "number" ? parsed.restarts : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt * 1000 : null,
    }
  } catch {
    // Adopted stream whose state file we lost: treat as running.
    return { state: null, restarts: 0, updatedAt: null }
  }
}

function fileAgeMs(file: string): number | null {
  try {
    return Date.now() - fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

/** Fingerprint of an ingest URL (server + key) so two channels can't publish to one key; never the key itself. */
export function destinationFingerprint(url: string): string {
  return crypto.createHash("sha256").update(url.trim()).digest("hex").slice(0, 16)
}

export type RtmpChannelStatus = {
  running: boolean
  state: EncoderStatus["rtmpState"]
  reconnecting: boolean
  restarts: number
  adopted: boolean
  host: string | null
  size: string | null
  relay: boolean
  bitrateK: number | null
  encoder: string | null
  health: SourceHealth | HealthStats
  /** What this channel is playing as audio; pending = saved settings differ (restart to apply). */
  audio: { mode: AudioMode; warning: string | null; pending: boolean } | null
  connectError: string | null
  failure: string | null
  logTail: string
}

export function readChannelStatus(ch: RtmpChannel): RtmpChannelStatus {
  adoptRunningSupervisor(ch)
  const running = rtmpAlive(ch)
  const supervisor = running ? readSupervisorState(ch) : { state: null, restarts: 0, updatedAt: null }
  const files = rtmpFiles(ch)
  const meta = running ? readRtmpMeta(ch) : null
  return {
    running,
    state: deriveRtmpState(running, supervisor.state, readTail(files.log, 32768), readFailure(ch), { logAgeMs: fileAgeMs(files.log), runAgeMs: supervisor.updatedAt ? Date.now() - supervisor.updatedAt : null }),
    reconnecting: running && supervisor.state === "waiting",
    restarts: supervisor.restarts,
    adopted: running && meta?.adopted === true,
    host: meta?.host ?? null,
    size: typeof meta?.size === "string" ? meta.size : null,
    relay: running && meta?.relay === true,
    bitrateK: running ? (meta?.bitrateK ?? (ch === "slate" ? 2500 : null)) : null,
    encoder: running ? (meta?.encoder ?? (ch === "slate" ? "libx264" : null)) : null,
    health: channelHealth(ch, running, meta),
    audio: running ? channelAudio(ch, meta) : null,
    connectError: running ? parseConnectError(readTail(files.log, 32768), readRtmpHost(ch)) : null,
    failure: running ? null : readFailure(ch),
    logTail: redact(readTail(files.log).split(/\r?\n/).slice(-20).join("\n").slice(-2000)),
  }
}

// ---------- re-attaching to a stream that outlived the server (restart, rebuild, crash) ----------

export type OwnSupervisor = { pid: number; channel: RtmpChannel; dest?: string; relay?: boolean }

/**
 * Supervisor processes of THIS project: `bash <absolute path to our rtmp-supervisor.sh> [channel]`,
 * and process-group leaders (spawned detached), so another checkout's stream never matches.
 * No channel argument = slate (streams started before channels existed).
 */
export function parseOwnSupervisorList(psOutput: string, supervisorPath: string): OwnSupervisor[] {
  const found: OwnSupervisor[] = []
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const pgid = Number(match[2])
    const command = match[3].trim()
    if (pid !== pgid) continue
    if (!/^(\S*\/)?bash\s+/.test(command)) continue
    const parts = command.split(/\s+/)
    const at = parts.indexOf(supervisorPath)
    if (at < 0) continue
    // argv: SUPERVISOR <channel> dest=<fingerprint>. The fingerprint is a hash, never the key; it lets an
    // adopted stream (pidfile gone after a restart) still block a second publisher on the same destination.
    const destArg = parts.slice(at + 1).find((part) => /^dest=[0-9a-f]{16}$/.test(part))
    const relay = parts.slice(at + 1).includes("via=relay")
    found.push({ pid, channel: parts[at + 1] === "capture" ? "capture" : "slate", ...(destArg ? { dest: destArg.slice(5) } : {}), ...(relay ? { relay: true } : {}) })
  }
  return found
}

/** Back-compat: pids only. */
export function parseOwnSupervisors(psOutput: string, supervisorPath: string): number[] {
  return parseOwnSupervisorList(psOutput, supervisorPath).map((item) => item.pid)
}

let ownCache: { at: number; value: OwnSupervisor[] } = { at: 0, value: [] }
export function findOwnSupervisorList(): OwnSupervisor[] {
  if (Date.now() - ownCache.at < 3000) return ownCache.value
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  const value = result.status === 0 ? parseOwnSupervisorList(result.stdout, SUPERVISOR) : []
  ownCache = { at: Date.now(), value }
  return value
}
export function findOwnSupervisors(): number[] {
  return findOwnSupervisorList().map((item) => item.pid)
}

function ownSupervisorCount(ch?: RtmpChannel): number {
  return findOwnSupervisorList().filter((item) => !ch || item.channel === ch).length
}

/**
 * No pidfile (or a stale one) but exactly one of our supervisors for this channel is running:
 * take it back, so the desk shows it and Stop works. Several is a mess the operator must see ("Stop all").
 */
function adoptRunningSupervisor(ch: RtmpChannel = "slate") {
  const current = readRtmpPid(ch)
  if (current !== null && pidRunsScript(current, SUPERVISOR)) return
  const found = findOwnSupervisorList().filter((item) => item.channel === ch)
  if (found.length !== 1) return
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(rtmpFiles(ch).meta, JSON.stringify({ pid: found[0].pid, startedAt: Date.now(), adopted: true, source: ch, ...(found[0].dest ? { dest: found[0].dest } : {}), ...(found[0].relay ? { relay: true } : {}) }))
  strayCache = { at: 0, value: [] }
}

/** Stop every supervisor of this project (both channels) plus stray RTMP ffmpeg publishers (explicit "Stop all"). */
export function stopAllRtmp(): Promise<{ stopped: number[]; strays: number[] }> {
  return withRtmpLock("slate", () => withRtmpLock("capture", async () => {
    ownCache = { at: 0, value: [] }
    strayCache = { at: 0, value: [] }
    const supervisors = findOwnSupervisors()
    for (const pid of supervisors) await killGroup(pid)
    strayCache = { at: 0, value: [] }
    const strays = findStrayPublishers().map((item) => item.pid)
    for (const pid of strays) {
      try { process.kill(pid, "SIGTERM") } catch { /* gone */ }
    }
    for (const ch of RTMP_CHANNELS) {
      forgetChannel(ch)
      clearFailure(ch)
      gates[ch].last = { kind: "stop", at: Date.now() }
    }
    ownCache = { at: 0, value: [] }
    strayCache = { at: 0, value: [] }
    return { stopped: supervisors, strays }
  }))
}

export type StrayPublisher = { pid: number; command: string }

/**
 * Finds ffmpeg processes that publish over RTMP but do not belong to this app's
 * supervisors (for example one left running in a Terminal tab). Two publishers on
 * one Castr key is a common reason an old picture stays on air.
 * Input is `ps -axo pid=,pgid=,command=` output so it can be tested without ps.
 */
export function parseStrayPublishers(psOutput: string, ownPgid: number | null | number[], selfPid: number): StrayPublisher[] {
  const own = new Set((Array.isArray(ownPgid) ? ownPgid : [ownPgid]).filter((item): item is number => typeof item === "number"))
  const strays: StrayPublisher[] = []
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const pgid = Number(match[2])
    const command = match[3]
    if (pid === selfPid) continue
    if (own.has(pgid)) continue
    const isFfmpeg = /^(\S*\/)?ffmpeg(\s|$)/.test(command)
    if (!isFfmpeg || !/\s-f\s+flv\s/.test(command) || !/rtmps?:\/\//.test(command)) continue
    strays.push({ pid, command: redact(command).slice(0, 160) })
  }
  return strays
}

let strayCache: { at: number; value: StrayPublisher[] } = { at: 0, value: [] }

/** Cached for 5s because the desk polls status every couple of seconds. */
export function findStrayPublishers(): StrayPublisher[] {
  if (Date.now() - strayCache.at < 5000) return strayCache.value
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  const own = [...RTMP_CHANNELS.map((ch) => readRtmpPid(ch)), ...findOwnSupervisors(), ...relayProcessGroups()].filter((item): item is number => item !== null)
  const value = result.status === 0 ? parseStrayPublishers(result.stdout, own, process.pid) : []
  strayCache = { at: Date.now(), value }
  return value
}

const SUPERVISOR_EXIT = /\[supervisor [^\]]*\] ffmpeg exited/

// ---------- RTMP command gate (spam-click / opposing-command protection), one per channel ----------

export type RtmpCommand = "start" | "stop"
export type RtmpGateInput = {
  kind: RtmpCommand
  inFlight: RtmpCommand | null
  running: boolean
  last: { kind: RtmpCommand; at: number } | null
  now: number
}
export type RtmpGate = { action: "run" } | { action: "noop"; note: string } | { action: "reject"; status: number; error: string; retryAfterMs?: number }

/** Minimum gap between a start and a following stop (or the reverse). */
export const RTMP_COOLDOWN_MS = 2000

/**
 * Pure decision for a start/stop request. Same command twice is idempotent (no relaunch,
 * no second stop); an opposite command while one is in flight, or within the cooldown, is refused.
 */
export function decideRtmpCommand({ kind, inFlight, running, last, now }: RtmpGateInput): RtmpGate {
  if (inFlight === kind) return { action: "reject", status: 409, error: kind === "start" ? "Already starting the stream." : "Already stopping the stream." }
  if (inFlight) return { action: "reject", status: 409, error: inFlight === "start" ? "The stream is still starting. Wait for it, then stop." : "The stream is still stopping. Wait, then start." }
  if (kind === "start" && running) return { action: "noop", note: "The stream is already running. Stop it first to change the URL." }
  if (kind === "stop" && !running) return { action: "noop", note: "The stream is not running." }
  if (last && last.kind !== kind && now - last.at < RTMP_COOLDOWN_MS) {
    const retryAfterMs = RTMP_COOLDOWN_MS - (now - last.at)
    return { action: "reject", status: 429, error: `Too soon after ${last.kind}. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`, retryAfterMs }
  }
  return { action: "run" }
}

const gates: Record<RtmpChannel, { inFlight: RtmpCommand | null; last: { kind: RtmpCommand; at: number } | null; lock: Promise<unknown> }> = {
  slate: { inFlight: null, last: null, lock: Promise.resolve() },
  capture: { inFlight: null, last: null, lock: Promise.resolve() },
}

function withRtmpLock<T>(ch: RtmpChannel, task: () => Promise<T>): Promise<T> {
  const run = gates[ch].lock.then(task, task)
  gates[ch].lock = run.catch(() => undefined)
  return run
}

export function rtmpInFlightCommand(ch: RtmpChannel = "slate"): RtmpCommand | null {
  return gates[ch].inFlight
}

type RtmpStartResult = { ok: true; note?: string } | { ok: false; error: string; status: number }
type RtmpStopResult = (StopResult & { ok: true; note?: string }) | { ok: false; error: string; status: number }

/** Slate = ffmpeg drawtext countdown; capture = headless Chromium rendering the real /stream page. */
/** `relay: true` = publishing to the local MediaMTX relay path (lib/relay.ts) instead of a destination. */
export type CaptureEncoder = "auto" | "libx264" | "videotoolbox"
export type RtmpSource = ({ kind: "slate" } | { kind: "capture"; pageUrl: string; size: "1280x720" | "1920x1080"; bitrateK?: number; encoder?: CaptureEncoder }) & { relay?: boolean }

/** What each channel publishes to right now (fingerprints only), for the relay's same-destination guard. */
export function directChannelDests(): { channel: RtmpChannel; running: boolean; dest?: string; relay?: boolean }[] {
  return RTMP_CHANNELS.map((channel) => {
    const running = rtmpAlive(channel)
    const meta = running ? readRtmpMeta(channel) : null
    return { channel, running, dest: meta?.dest, relay: meta?.relay === true }
  })
}

/** Pure: may this channel start to `fingerprint`? Castr (and most ingests) take one publisher per key. */
const pendingDest: Record<RtmpChannel, string | null> = { slate: null, capture: null }

export function sameDestinationConflict(fingerprint: string, others: { channel: RtmpChannel; running: boolean; dest?: string }[]): RtmpChannel | null {
  return others.find((other) => other.running && other.dest === fingerprint)?.channel ?? null
}

export function startRtmpStream(input: StartInput, rtmpUrl: string, now = Date.now(), source: RtmpSource = { kind: "slate" }): Promise<RtmpStartResult> {
  const ch: RtmpChannel = source.kind
  const gate = decideRtmpCommand({ kind: "start", inFlight: gates[ch].inFlight, running: rtmpAlive(ch), last: gates[ch].last, now })
  if (gate.action === "reject") return Promise.resolve({ ok: false, error: gate.error, status: gate.status })
  if (gate.action === "noop") return Promise.resolve({ ok: true, note: gate.note })
  const other: RtmpChannel = ch === "slate" ? "capture" : "slate"
  const fingerprint = destinationFingerprint(rtmpUrl)
  // A start still in flight on the other channel counts too (its pidfile isn't written yet).
  const clash = sameDestinationConflict(fingerprint, [
    { channel: other, running: rtmpAlive(other), dest: readRtmpMeta(other)?.dest },
    { channel: other, running: pendingDest[other] !== null, dest: pendingDest[other] ?? undefined },
  ])
  const relayClash = source.relay ? undefined : relayForwardFingerprints().find((item) => item.dest === fingerprint)
  if (relayClash) {
    return Promise.resolve({ ok: false, status: 409, error: `The relay (/${relayClash.path}) is forwarding to this destination. One stream key takes one publisher: turn that forward off or pick another destination.` })
  }
  if (clash) {
    return Promise.resolve({ ok: false, status: 409, error: `The ${clash === "capture" ? "Browser capture" : "Slate"} stream is already publishing to this destination. One stream key takes one publisher: pick another destination or stop that stream first.` })
  }
  gates[ch].inFlight = "start"
  pendingDest[ch] = fingerprint
  return withRtmpLock(ch, () => startRtmpStreamUnlocked(input, rtmpUrl, source)).finally(() => {
    pendingDest[ch] = null
    gates[ch].inFlight = null
    gates[ch].last = { kind: "start", at: Date.now() }
  })
}

async function startRtmpStreamUnlocked(input: StartInput, rtmpUrl: string, source: RtmpSource = { kind: "slate" }): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const ch: RtmpChannel = source.kind
  const files = rtmpFiles(ch)
  const checked = validateRtmpUrl(rtmpUrl)
  if (!checked.ok) return { ok: false, error: checked.error, status: 400 }
  const url = checked.url
  if (!source.relay && !allowedRtmpHost(url)) {
    return { ok: false, error: "That RTMP host is not in RTMP_ALLOWED_HOSTS.", status: 400 }
  }
  if (!ffmpegAvailable({ fresh: true })) return { ok: false, error: "ffmpeg is not installed on this machine.", status: 500 }
  if (!fs.existsSync(/* turbopackIgnore: true */ SCRIPT) || !fs.existsSync(/* turbopackIgnore: true */ SUPERVISOR)) {
    return { ok: false, error: "The countdown script is missing.", status: 500 }
  }
  // Wait for this channel's old publisher to be fully gone before connecting again, so two
  // ffmpegs never push to the same stream key at once.
  await stopRtmpStreamUnlocked(ch)
  clearFailure(ch)
  if (ch === "capture") fs.rmSync((files as { stats: string }).stats, { force: true })
  strayCache = { at: 0, value: [] }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  // The raw log may hold the ingest URL (key + password): owner-only.
  fs.writeFileSync(files.log, "", { mode: 0o600 })
  fs.chmodSync(files.log, 0o600)
  const logFd = fs.openSync(files.log, "a")
  // Stream audio for this run (silence / tone / looped bed); a missing file falls back to silence.
  const audio = prepareChannelAudio(ch)
  const child = spawn("bash", [SUPERVISOR, ch, `dest=${destinationFingerprint(url)}`, ...(source.relay ? ["via=relay"] : [])], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: ROOT,
    env: childEnv({
      EVENT_NAME: input.eventName,
      EVENT_LINE: input.dateLine,
      TARGET_UNIX: String(input.targetUnix),
      RTMP_URL: url,
      RTMP_STATE_FILE: files.state,
      RTMP_LOG_FILE: files.log,
      RTMP_FAIL_FILE: files.fail,
      AUDIO_ARGS_FILE: audio.argsFile,
      ...(source.kind === "capture"
        ? { RTMP_RUNNER: "capture", CAPTURE_URL: source.pageUrl, CAPTURE_KEY_FILE: path.join(DATA_DIR, "capture-key"), PROGRAM_READ_FILE: programReadFile(), CAPTURE_SIZE: source.size, CAPTURE_BITRATE: String(source.bitrateK ?? (source.size === "1920x1080" ? 4500 : 2500)), CAPTURE_ENCODER: source.encoder ?? "auto", CAPTURE_STATS_FILE: (files as { stats: string }).stats, NODE_BIN: process.execPath, FFMPEG_BIN: process.env.FFMPEG_BIN || "ffmpeg" }
        : {}),
    }),
  })
  child.unref()
  fs.closeSync(logFd)
  if (!child.pid) return { ok: false, error: "Could not start the RTMP stream.", status: 500 }
  const audioMeta = { mode: audio.plan.mode, hash: audio.hash, warning: audio.plan.warning }
  let host = ""
  try { host = new URL(url).hostname } catch { /* validated above */ }
  fs.writeFileSync(files.meta, JSON.stringify({ pid: child.pid, startedAt: Date.now(), host, source: ch, size: source.kind === "capture" ? source.size : null, ...(source.kind === "capture" ? { bitrateK: source.bitrateK ?? (source.size === "1920x1080" ? 4500 : 2500), encoder: source.encoder ?? "auto" } : {}), dest: destinationFingerprint(url), audio: audioMeta, ...(source.relay ? { relay: true } : {}) }))

  // Wait for the first connection. "Output #0" means ffmpeg opened the RTMP output.
  // A supervisor "exited" line this early means the URL or script is wrong, so stop
  // retrying and show the error instead of looping silently.
  // Browser capture needs a few extra seconds to launch Chromium and load /stream.
  const deadline = Date.now() + (ch === "capture" ? 15000 : 8000)
  while (Date.now() < deadline) {
    await delay(400)
    if (!alive(child.pid)) break
    const log = readTail(files.log, 32768)
    if (SUPERVISOR_EXIT.test(log)) {
      await stopRtmpStreamUnlocked(ch)
      const error = redact(readTail(files.log, 4000)) || "ffmpeg exited before the stream connected."
      writeFailure(error, ch)
      return { ok: false, error, status: 500 }
    }
    if (/Output #0/.test(log)) return { ok: true }
  }
  if (!alive(child.pid)) {
    const error = redact(readTail(files.log, 4000)) || "The RTMP supervisor exited."
    writeFailure(error, ch)
    return { ok: false, error, status: 500 }
  }
  // Still connecting: the supervisor keeps retrying and the desk shows "Reconnecting".
  return { ok: true }
}

export function stopRtmpStream(now = Date.now(), ch: RtmpChannel = "slate"): Promise<RtmpStopResult> {
  const gate = decideRtmpCommand({ kind: "stop", inFlight: gates[ch].inFlight, running: rtmpAlive(ch), last: gates[ch].last, now })
  if (gate.action === "reject") return Promise.resolve({ ok: false, error: gate.error, status: gate.status })
  if (gate.action === "noop") {
    clearFailure(ch)
    return Promise.resolve({ ...NOT_STOPPED, ok: true, note: gate.note })
  }
  gates[ch].inFlight = "stop"
  return withRtmpLock(ch, async () => {
    clearFailure(ch)
    return { ...(await stopRtmpStreamUnlocked(ch)), ok: true as const }
  }).finally(() => {
    gates[ch].inFlight = null
    gates[ch].last = { kind: "stop", at: Date.now() }
  })
}

/** Test hook: forget the gates' in-memory history. */
export function resetRtmpGate() {
  for (const ch of RTMP_CHANNELS) {
    gates[ch].inFlight = null
    gates[ch].last = null
  }
}

async function stopRtmpStreamUnlocked(ch: RtmpChannel = "slate"): Promise<StopResult> {
  const pid = readRtmpPid(ch)
  // The supervisor, the script and ffmpeg share one process group. Only signal it
  // if it is still ours (not a reused pid from a stale file).
  const result = pid !== null && ownsGroup(pid, SUPERVISOR) ? noteStop("RTMP stream", await killGroup(pid)) : NOT_STOPPED
  forgetChannel(ch)
  return result
}

export function parseStartInput(body: unknown): StartInput | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const eventName = typeof record.eventName === "string" ? record.eventName.trim() : "";
  const dateLine = typeof record.dateLine === "string" ? record.dateLine.trim() : "";
  const targetUnix = record.targetUnix;
  if (
    eventName.length === 0 ||
    eventName.length > 80 ||
    /[\r\n]/.test(eventName) ||
    dateLine.length === 0 ||
    dateLine.length > 120 ||
    /[\r\n]/.test(dateLine) ||
    typeof targetUnix !== "number" ||
    !Number.isInteger(targetUnix) ||
    targetUnix < 0 ||
    targetUnix > 4_000_000_000
  ) {
    return null;
  }
  const rawRefresh = record.refreshSeconds;
  const refreshSeconds = rawRefresh === undefined ? 600 : typeof rawRefresh === "number" ? rawRefresh : Number.NaN;
  if (!Number.isInteger(refreshSeconds) || refreshSeconds < 0 || refreshSeconds > 86_400) return null;
  return { eventName, dateLine, targetUnix, refreshSeconds };
}

export function startEncoder(
  input: StartInput,
  options: { replace?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  return withEncoderLock(() => startEncoderUnlocked(input, options))
}

async function startEncoderUnlocked(
  input: StartInput,
  options: { replace?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const current = readMeta();
  if (current && ownsGroup(current.pid, SCRIPT)) {
    if (!options.replace) {
      return {
        ok: false,
        error: "An encoder is already running. Stop it before starting another.",
        status: 409,
      };
    }
    await stopEncoderUnlocked();
  }
  if (!ffmpegAvailable({ fresh: true })) {
    return { ok: false, error: "ffmpeg is not installed on this machine.", status: 500 };
  }
  if (!fs.existsSync(/* turbopackIgnore: true */ SCRIPT)) {
    return { ok: false, error: "The countdown script is missing.", status: 500 };
  }

  fs.mkdirSync(HLS_DIR, { recursive: true });
  fs.rmSync(HLS_DIR, { recursive: true, force: true });
  fs.mkdirSync(HLS_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, "");

  const logFd = fs.openSync(LOG_FILE, "a");
  const child = spawn("bash", [SCRIPT, "--hls", HLS_DIR], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: ROOT,
    env: childEnv({
      EVENT_NAME: input.eventName,
      EVENT_LINE: input.dateLine,
      TARGET_UNIX: String(input.targetUnix),
    }),
  });
  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    return { ok: false, error: "Could not start ffmpeg.", status: 500 };
  }

  const meta: Meta = {
    pid: child.pid,
    startedAt: Date.now(),
    eventName: input.eventName,
    dateLine: input.dateLine,
    targetUnix: input.targetUnix,
    burnedRemainingAtStart: Math.max(0, input.targetUnix - Math.floor(Date.now() / 1000)),
    refreshSeconds: input.refreshSeconds,
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta));
  await delay(STARTUP_WAIT_MS);

  if (!alive(child.pid)) {
    // The script died early; take any orphaned ffmpeg in its group with it.
    if (ownsGroup(child.pid, SCRIPT)) await killGroup(child.pid);
    try {
      fs.unlinkSync(META_FILE);
    } catch {
      /* already gone */
    }
    return {
      ok: false,
      error: tailLog() || "ffmpeg exited before the slate started.",
      status: 500,
    };
  }

  return { ok: true };
}

export function restartEncoder(input: StartInput) {
  return startEncoder(input, { replace: true })
}

let refreshInFlight: Promise<void> | null = null

/** Polled by every open desk tab; at most one refresh runs at a time and the stale check is repeated inside the lock. */
export function maybeRefreshStaleSlate(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  const meta = readMeta()
  if (!meta || meta.refreshSeconds <= 0 || Date.now() - meta.startedAt < meta.refreshSeconds * 1000) return Promise.resolve()
  refreshInFlight = withEncoderLock(async () => {
    const current = readMeta()
    if (!current || current.refreshSeconds <= 0 || !pidRunsScript(current.pid, SCRIPT)) return
    if (Date.now() - current.startedAt < current.refreshSeconds * 1000) return
    await startEncoderUnlocked({
      eventName: current.eventName,
      dateLine: current.dateLine,
      targetUnix: current.targetUnix,
      refreshSeconds: current.refreshSeconds,
    }, { replace: true })
  }).then(() => undefined).finally(() => { refreshInFlight = null })
  return refreshInFlight
}

export function stopEncoder(): Promise<StopResult> {
  return withEncoderLock(stopEncoderUnlocked)
}

async function stopEncoderUnlocked(): Promise<StopResult> {
  const meta = readMeta();
  const result = meta && ownsGroup(meta.pid, SCRIPT) ? noteStop("encoder", await killGroup(meta.pid)) : NOT_STOPPED;
  try {
    fs.unlinkSync(META_FILE);
  } catch {
    /* already gone */
  }
  return result;
}
