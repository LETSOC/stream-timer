import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EncoderStatus } from "@/lib/encoder-status";

export const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, "data");
export const HLS_DIR = path.join(DATA_DIR, "hls");
export const META_FILE = path.join(DATA_DIR, "encoder.json");
export const LOG_FILE = path.join(DATA_DIR, "encoder.log");
export const RTMP_META_FILE = path.join(DATA_DIR, "rtmp.json");
export const RTMP_LOG_FILE = path.join(DATA_DIR, "rtmp.log");
export const RTMP_STATE_FILE = path.join(DATA_DIR, "rtmp-supervisor.json");
export const SCRIPT = path.join(ROOT, "scripts", "stream-countdown.sh");
export const SUPERVISOR = path.join(ROOT, "scripts", "rtmp-supervisor.sh");

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

export function redact(text: string): string {
  return text.replace(/(password=)[^\s&'"]+/gi, "$1••••");
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

let ffmpegFoundUntil = 0

/** The desk polls status every couple of seconds; spawning ffmpeg each time blocked the server for ~50ms. */
export function ffmpegAvailable(): boolean {
  if (Date.now() < ffmpegFoundUntil) return true
  const found = spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" }).status === 0
  if (found) ffmpegFoundUntil = Date.now() + 60_000
  return found
}

export function readStatus(): EncoderStatus {
  const meta = readMeta();
  const rtmpRunning = rtmpAlive();
  const supervisor = rtmpRunning ? readSupervisorState() : { state: null, restarts: 0 };
  const running = meta ? alive(meta.pid) : false;
  if (meta && !running) {
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
    rtmpRunning,
    rtmpReconnecting: rtmpRunning && supervisor.state === "waiting",
    rtmpRestarts: supervisor.restarts,
    rtmpLogTail: redact(readTail(RTMP_LOG_FILE).split(/\r?\n/).slice(-20).join("\n").slice(-2000)),
    strayPublishers: findStrayPublishers(),
  };
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
  return pid !== null && alive(pid)
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
export async function startRtmpStream(input: StartInput, rtmpUrl: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const url = rtmpUrl.trim()
  if (!/^rtmps?:\/\/\S+$/.test(url)) {
    return { ok: false, error: "Paste an rtmp:// or rtmps:// URL with no spaces.", status: 400 }
  }
  if (!ffmpegAvailable()) return { ok: false, error: "ffmpeg is not installed on this machine.", status: 500 }
  if (!fs.existsSync(SCRIPT) || !fs.existsSync(SUPERVISOR)) {
    return { ok: false, error: "The countdown script is missing.", status: 500 }
  }
  stopRtmpStream()
  strayCache = { at: 0, value: [] }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(RTMP_LOG_FILE, "")
  const logFd = fs.openSync(RTMP_LOG_FILE, "a")
  const child = spawn("bash", [SUPERVISOR], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: ROOT,
    env: {
      ...process.env,
      EVENT_NAME: input.eventName,
      EVENT_LINE: input.dateLine,
      TARGET_UNIX: String(input.targetUnix),
      RTMP_URL: url,
      RTMP_STATE_FILE,
    },
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
      stopRtmpStream()
      return { ok: false, error: redact(readTail(RTMP_LOG_FILE, 4000)) || "ffmpeg exited before the stream connected.", status: 500 }
    }
    if (/Output #0/.test(log)) return { ok: true }
  }
  if (!alive(child.pid)) {
    return { ok: false, error: redact(readTail(RTMP_LOG_FILE, 4000)) || "The RTMP supervisor exited.", status: 500 }
  }
  // Still connecting after 8s: the supervisor keeps retrying and the desk shows "Reconnecting".
  return { ok: true }
}

export function stopRtmpStream() {
  const pid = readRtmpPid()
  if (pid !== null) {
    // The supervisor, the script and ffmpeg share one process group.
    try { process.kill(-pid, "SIGTERM") } catch { try { process.kill(pid, "SIGTERM") } catch { /* already gone */ } }
  }
  try { fs.unlinkSync(RTMP_META_FILE) } catch { /* already gone */ }
  try { fs.unlinkSync(RTMP_STATE_FILE) } catch { /* already gone */ }
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

export async function startEncoder(
  input: StartInput,
  options: { replace?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const current = readMeta();
  if (current && alive(current.pid)) {
    if (!options.replace) {
      return {
        ok: false,
        error: "An encoder is already running. Stop it before starting another.",
        status: 409,
      };
    }
    stopEncoder();
    await delay(400);
  }
  if (!ffmpegAvailable()) {
    return { ok: false, error: "ffmpeg is not installed on this machine.", status: 500 };
  }
  if (!fs.existsSync(SCRIPT)) {
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
    env: {
      ...process.env,
      EVENT_NAME: input.eventName,
      EVENT_LINE: input.dateLine,
      TARGET_UNIX: String(input.targetUnix),
    },
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
  await delay(1500);

  if (!alive(child.pid)) {
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

export async function maybeRefreshStaleSlate(): Promise<void> {
  const meta = readMeta()
  if (!meta || !alive(meta.pid) || meta.refreshSeconds <= 0) return
  if (Date.now() - meta.startedAt < meta.refreshSeconds * 1000) return
  await restartEncoder({
    eventName: meta.eventName,
    dateLine: meta.dateLine,
    targetUnix: meta.targetUnix,
    refreshSeconds: meta.refreshSeconds,
  })
}

export function stopEncoder(): void {
  const meta = readMeta();
  if (meta && alive(meta.pid)) {
    try {
      process.kill(-meta.pid, "SIGTERM");
    } catch {
      try {
        process.kill(meta.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  try {
    fs.unlinkSync(META_FILE);
  } catch {
    /* already gone */
  }
}
