import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { EncoderStatus } from "@/lib/encoder-status";

export const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, "data");
export const HLS_DIR = path.join(DATA_DIR, "hls");
export const META_FILE = path.join(DATA_DIR, "encoder.json");
export const LOG_FILE = path.join(DATA_DIR, "encoder.log");
export const SCRIPT = path.join(ROOT, "scripts", "stream-countdown.sh");

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
  };
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
