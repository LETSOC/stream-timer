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
  const rtmpRunning = rtmpAlive();
  const supervisor = rtmpRunning ? readSupervisorState() : { state: null, restarts: 0 };
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
    rtmpState: deriveRtmpState(rtmpRunning, supervisor.state, readTail(RTMP_LOG_FILE, 32768), readFailure()),
    stopNote: lastStopNote,
    rtmpRunning,
    rtmpReconnecting: rtmpRunning && supervisor.state === "waiting",
    rtmpRestarts: supervisor.restarts,
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
export function deriveRtmpState(
  running: boolean,
  supervisorState: "running" | "waiting" | null,
  log: string,
  failure: string | null,
): EncoderStatus["rtmpState"] {
  if (!running) return failure ? "failed" : "stopped"
  if (supervisorState === "waiting") return "reconnecting"
  const lastStart = Math.max(log.lastIndexOf("supervisor started"), log.lastIndexOf("] ffmpeg exited"))
  const currentRun = lastStart >= 0 ? log.slice(lastStart) : log
  return /Output #0/.test(currentRun) && /(frame=\s*\d+|size=\s*\d+)/.test(currentRun) ? "connected" : "starting"
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

function allowedRtmpHost(url: string): boolean {
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

function readSupervisorState(): { state: "running" | "waiting" | null; restarts: number } {
  try {
    const parsed = JSON.parse(fs.readFileSync(RTMP_STATE_FILE, "utf8")) as { state?: unknown; restarts?: unknown }
    return {
      state: parsed.state === "running" || parsed.state === "waiting" ? parsed.state : null,
      restarts: typeof parsed.restarts === "number" ? parsed.restarts : 0,
    }
  } catch {
    return { state: null, restarts: 0 }
  }
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
export function startRtmpStream(input: StartInput, rtmpUrl: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  return withRtmpLock(() => startRtmpStreamUnlocked(input, rtmpUrl))
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
    }),
  })
  child.unref()
  fs.closeSync(logFd)
  if (!child.pid) return { ok: false, error: "Could not start the RTMP stream.", status: 500 }
  fs.writeFileSync(RTMP_META_FILE, JSON.stringify({ pid: child.pid, startedAt: Date.now() }))

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

export function stopRtmpStream(): Promise<StopResult> {
  return withRtmpLock(async () => {
    clearFailure()
    return stopRtmpStreamUnlocked()
  })
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
