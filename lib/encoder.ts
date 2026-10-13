import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EncoderStatus } from "@/lib/encoder-status";

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
async function killGroup(pid: number, graceMs = STOP_GRACE_MS): Promise<StopResult> {
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

function groupAlive(pgid: number): boolean {
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
let rtmpLock: Promise<unknown> = Promise.resolve();
function withRtmpLock<T>(task: () => Promise<T>): Promise<T> {
  const run = rtmpLock.then(task, task);
  rtmpLock = run.catch(() => undefined);
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
  adoptRunningSupervisor();
  const rtmpRunning = rtmpAlive();
  const supervisor = rtmpRunning ? readSupervisorState() : { state: null, restarts: 0, updatedAt: null };
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
    rtmpState: deriveRtmpState(rtmpRunning, supervisor.state, readTail(RTMP_LOG_FILE, 32768), readFailure(), { logAgeMs: fileAgeMs(RTMP_LOG_FILE), runAgeMs: supervisor.updatedAt ? Date.now() - supervisor.updatedAt : null }),
    rtmpAdopted: rtmpRunning && readRtmpMeta()?.adopted === true,
    rtmpOwnProcesses: ownSupervisorCount(),
    stopNote: lastStopNote,
    rtmpRunning,
    rtmpReconnecting: rtmpRunning && supervisor.state === "waiting",
    rtmpRestarts: supervisor.restarts,
    rtmpConnectError: rtmpRunning ? parseConnectError(readTail(RTMP_LOG_FILE, 32768), readRtmpHost()) : null,
    rtmpFailure: rtmpRunning ? null : readFailure(),
    rtmpLogTail: redact(readTail(RTMP_LOG_FILE).split(/\r?\n/).slice(-20).join("\n").slice(-2000)),
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

function readRtmpHost(): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(RTMP_META_FILE, "utf8")) as { host?: unknown }
    return typeof meta.host === "string" ? meta.host : null
  } catch {
    return null
  }
}

function readFailure(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(RTMP_FAIL_FILE, "utf8")) as { error?: unknown }
    return typeof parsed.error === "string" ? parsed.error : "failed"
  } catch {
    return null
  }
}

function writeFailure(error: string) {
  try {
    fs.writeFileSync(RTMP_FAIL_FILE, JSON.stringify({ error: redact(error).slice(0, 500), at: Date.now() }), { mode: 0o600 })
  } catch {
    /* best effort */
  }
}

function clearFailure() {
  try { fs.unlinkSync(RTMP_FAIL_FILE) } catch { /* already gone */ }
}

function readRtmpPid(): number | null {
  try {
    const meta = JSON.parse(fs.readFileSync(RTMP_META_FILE, "utf8")) as { pid?: number }
    return typeof meta.pid === "number" ? meta.pid : null
  } catch {
    return null
  }
}

function rtmpAlive(): boolean {
  const pid = readRtmpPid()
  if (pid === null) return false
  if (pidRunsScript(pid, SUPERVISOR)) return true
  if (ownsGroup(pid, SUPERVISOR)) void killGroup(pid)
  // Stale pidfile (crash, reboot, pid reused): forget it.
  try { fs.unlinkSync(RTMP_META_FILE) } catch { /* already gone */ }
  try { fs.unlinkSync(RTMP_STATE_FILE) } catch { /* already gone */ }
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

function readSupervisorState(): { state: "running" | "waiting" | null; restarts: number; updatedAt: number | null } {
  try {
    const parsed = JSON.parse(fs.readFileSync(RTMP_STATE_FILE, "utf8")) as { state?: unknown; restarts?: unknown; updatedAt?: unknown }
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

function readRtmpMeta(): { pid?: number; adopted?: boolean; host?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(RTMP_META_FILE, "utf8")) as { pid?: number; adopted?: boolean; host?: string }
  } catch {
    return null
  }
}

// ---------- re-attaching to a stream that outlived the server (restart, rebuild, crash) ----------

/**
 * Supervisor processes of THIS project: `bash <absolute path to our rtmp-supervisor.sh>`,
 * and process-group leaders (spawned detached), so another checkout's stream never matches.
 */
export function parseOwnSupervisors(psOutput: string, supervisorPath: string): number[] {
  const pids: number[] = []
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const pgid = Number(match[2])
    const command = match[3].trim()
    if (pid !== pgid) continue
    if (/^(\S*\/)?bash\s+/.test(command) && command.split(/\s+/).includes(supervisorPath)) pids.push(pid)
  }
  return pids
}

let ownCache: { at: number; value: number[] } = { at: 0, value: [] }
export function findOwnSupervisors(): number[] {
  if (Date.now() - ownCache.at < 3000) return ownCache.value
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  const value = result.status === 0 ? parseOwnSupervisors(result.stdout, SUPERVISOR) : []
  ownCache = { at: Date.now(), value }
  return value
}

function ownSupervisorCount(): number {
  return findOwnSupervisors().length
}

/**
 * No pidfile (or a stale one) but exactly one of our supervisors is running: take it back,
 * so the desk shows it and Stop works. Several running is a mess the operator must see ("Stop all").
 */
function adoptRunningSupervisor() {
  const current = readRtmpPid()
  if (current !== null && pidRunsScript(current, SUPERVISOR)) return
  const found = findOwnSupervisors()
  if (found.length !== 1) return
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(RTMP_META_FILE, JSON.stringify({ pid: found[0], startedAt: Date.now(), adopted: true }))
  strayCache = { at: 0, value: [] }
}

/** Stop every supervisor of this project plus stray RTMP ffmpeg publishers (explicit "Stop all"). */
export function stopAllRtmp(): Promise<{ stopped: number[]; strays: number[] }> {
  return withRtmpLock(async () => {
    ownCache = { at: 0, value: [] }
    strayCache = { at: 0, value: [] }
    const supervisors = findOwnSupervisors()
    for (const pid of supervisors) await killGroup(pid)
    strayCache = { at: 0, value: [] }
    const strays = findStrayPublishers().map((item) => item.pid)
    for (const pid of strays) {
      try { process.kill(pid, "SIGTERM") } catch { /* gone */ }
    }
    try { fs.unlinkSync(RTMP_META_FILE) } catch { /* already gone */ }
    try { fs.unlinkSync(RTMP_STATE_FILE) } catch { /* already gone */ }
    clearFailure()
    ownCache = { at: 0, value: [] }
    strayCache = { at: 0, value: [] }
    lastRtmpCommand = { kind: "stop", at: Date.now() }
    return { stopped: supervisors, strays }
  })
}

export type StrayPublisher = { pid: number; command: string }

/**
 * Finds ffmpeg processes that publish over RTMP but do not belong to this app's
 * supervisor (for example one left running in a Terminal tab). Two publishers on
 * one Castr key is a common reason an old picture stays on air.
 * Input is `ps -axo pid=,pgid=,command=` output so it can be tested without ps.
 */
export function parseStrayPublishers(psOutput: string, ownPgid: number | null, selfPid: number): StrayPublisher[] {
  const strays: StrayPublisher[] = []
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const pgid = Number(match[2])
    const command = match[3]
    if (pid === selfPid) continue
    if (ownPgid !== null && pgid === ownPgid) continue
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
  const value = result.status === 0 ? parseStrayPublishers(result.stdout, readRtmpPid(), process.pid) : []
  strayCache = { at: Date.now(), value }
  return value
}

const SUPERVISOR_EXIT = /\[supervisor [^\]]*\] ffmpeg exited/

/**
 * Starts the RTMP stream under scripts/rtmp-supervisor.sh, which relaunches
 * ffmpeg whenever it exits. Replaces any stream this app started earlier.
 */
// ---------- RTMP command gate (spam-click / opposing-command protection) ----------

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

let rtmpInFlight: RtmpCommand | null = null
let lastRtmpCommand: { kind: RtmpCommand; at: number } | null = null

export function rtmpInFlightCommand(): RtmpCommand | null {
  return rtmpInFlight
}

type RtmpStartResult = { ok: true; note?: string } | { ok: false; error: string; status: number }
type RtmpStopResult = (StopResult & { ok: true; note?: string }) | { ok: false; error: string; status: number }

export function startRtmpStream(input: StartInput, rtmpUrl: string, now = Date.now()): Promise<RtmpStartResult> {
  const gate = decideRtmpCommand({ kind: "start", inFlight: rtmpInFlight, running: rtmpAlive(), last: lastRtmpCommand, now })
  if (gate.action === "reject") return Promise.resolve({ ok: false, error: gate.error, status: gate.status })
  if (gate.action === "noop") return Promise.resolve({ ok: true, note: gate.note })
  rtmpInFlight = "start"
  return withRtmpLock(() => startRtmpStreamUnlocked(input, rtmpUrl)).finally(() => {
    rtmpInFlight = null
    lastRtmpCommand = { kind: "start", at: Date.now() }
  })
}

async function startRtmpStreamUnlocked(input: StartInput, rtmpUrl: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const checked = validateRtmpUrl(rtmpUrl)
  if (!checked.ok) return { ok: false, error: checked.error, status: 400 }
  const url = checked.url
  if (!allowedRtmpHost(url)) {
    return { ok: false, error: "That RTMP host is not in RTMP_ALLOWED_HOSTS.", status: 400 }
  }
  if (!ffmpegAvailable({ fresh: true })) return { ok: false, error: "ffmpeg is not installed on this machine.", status: 500 }
  if (!fs.existsSync(/* turbopackIgnore: true */ SCRIPT) || !fs.existsSync(/* turbopackIgnore: true */ SUPERVISOR)) {
    return { ok: false, error: "The countdown script is missing.", status: 500 }
  }
  // Wait for the old publisher to be fully gone before connecting again, so two
  // ffmpegs never push to the same stream key at once.
  await stopRtmpStreamUnlocked()
  clearFailure()
  strayCache = { at: 0, value: [] }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  // The raw log holds the ingest URL (key + password): owner-only.
  fs.writeFileSync(RTMP_LOG_FILE, "", { mode: 0o600 })
  fs.chmodSync(RTMP_LOG_FILE, 0o600)
  const logFd = fs.openSync(RTMP_LOG_FILE, "a")
  const child = spawn("bash", [SUPERVISOR], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: ROOT,
    env: childEnv({
      EVENT_NAME: input.eventName,
      EVENT_LINE: input.dateLine,
      TARGET_UNIX: String(input.targetUnix),
      RTMP_URL: url,
      RTMP_STATE_FILE,
      RTMP_LOG_FILE,
      RTMP_FAIL_FILE,
    }),
  })
  child.unref()
  fs.closeSync(logFd)
  if (!child.pid) return { ok: false, error: "Could not start the RTMP stream.", status: 500 }
  let host = ""
  try { host = new URL(url).hostname } catch { /* validated above */ }
  fs.writeFileSync(RTMP_META_FILE, JSON.stringify({ pid: child.pid, startedAt: Date.now(), host }))

  // Wait for the first connection. "Output #0" means ffmpeg opened the RTMP output.
  // A supervisor "exited" line this early means the URL or script is wrong, so stop
  // retrying and show the error instead of looping silently.
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await delay(400)
    if (!alive(child.pid)) break
    const log = readTail(RTMP_LOG_FILE, 32768)
    if (SUPERVISOR_EXIT.test(log)) {
      await stopRtmpStreamUnlocked()
      const error = redact(readTail(RTMP_LOG_FILE, 4000)) || "ffmpeg exited before the stream connected."
      writeFailure(error)
      return { ok: false, error, status: 500 }
    }
    if (/Output #0/.test(log)) return { ok: true }
  }
  if (!alive(child.pid)) {
    const error = redact(readTail(RTMP_LOG_FILE, 4000)) || "The RTMP supervisor exited."
    writeFailure(error)
    return { ok: false, error, status: 500 }
  }
  // Still connecting after 8s: the supervisor keeps retrying and the desk shows "Reconnecting".
  return { ok: true }
}

export function stopRtmpStream(now = Date.now()): Promise<RtmpStopResult> {
  const gate = decideRtmpCommand({ kind: "stop", inFlight: rtmpInFlight, running: rtmpAlive(), last: lastRtmpCommand, now })
  if (gate.action === "reject") return Promise.resolve({ ok: false, error: gate.error, status: gate.status })
  if (gate.action === "noop") {
    clearFailure()
    return Promise.resolve({ ...NOT_STOPPED, ok: true, note: gate.note })
  }
  rtmpInFlight = "stop"
  return withRtmpLock(async () => {
    clearFailure()
    return { ...(await stopRtmpStreamUnlocked()), ok: true as const }
  }).finally(() => {
    rtmpInFlight = null
    lastRtmpCommand = { kind: "stop", at: Date.now() }
  })
}

/** Test hook: forget the gate's in-memory history. */
export function resetRtmpGate() {
  rtmpInFlight = null
  lastRtmpCommand = null
}

async function stopRtmpStreamUnlocked(): Promise<StopResult> {
  const pid = readRtmpPid()
  // The supervisor, the script and ffmpeg share one process group. Only signal it
  // if it is still ours (not a reused pid from a stale file).
  const result = pid !== null && ownsGroup(pid, SUPERVISOR) ? noteStop("RTMP stream", await killGroup(pid)) : NOT_STOPPED
  try { fs.unlinkSync(RTMP_META_FILE) } catch { /* already gone */ }
  try { fs.unlinkSync(RTMP_STATE_FILE) } catch { /* already gone */ }
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
