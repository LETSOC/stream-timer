/**
 * Optional MediaMTX relay. Slate / Browser capture publish to a local MediaMTX
 * (rtmp://127.0.0.1:<port>/slate|capture), and the app fans each path out to any number of
 * saved destinations with one `ffmpeg -c copy` forward per destination, each under its own
 * restart loop (scripts/relay-loop.sh) with its own status.
 *
 * Everything lives in data/relay/ (gitignored, files 0600): settings.json, credentials.json
 * (random publish/read users), mediamtx.yml (generated each start), pidfiles, logs, state.
 * MediaMTX listens on 127.0.0.1 only; the desk preview goes through /api/relay/hls (operator auth).
 */
import os from "node:os"
import { cleanMdnsName, DEFAULT_MDNS_NAME, mdnsStatus, type MdnsConfig, type MdnsState } from "@/lib/mdns"
import { parseFailover, pullUrlError, type FailoverSettings, type ProgramSource, type SourceHealth as ProgramSourceHealth } from "@/lib/program-source"
import crypto from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { destinationFingerprint, directChannelDests, readChannelStatus, killGroup, pidRunsScript, redact, relayChildEnv } from "@/lib/encoder"
import { listDestinations, resolveDestination } from "@/lib/rtmp-destinations"
import { diagnose, EMPTY_HEALTH, healthFromSamples, parseProgressBlocks, type HealthStats, type Level, type SourceHealth } from "@/lib/stream-health"

export const RELAY_PATHS = ["slate", "capture", "vertical"] as const
/** Paths an RTMP channel (lib/encoder.ts) publishes; /vertical is published by the Vertical output (lib/vertical.ts). */
export const CHANNEL_PATHS = ["slate", "capture"] as const
export const VERTICAL_PATH = "vertical"
export type RelayPath = (typeof RELAY_PATHS)[number]

const root = () => process.cwd()
const dataDir = () => process.env.STREAM_DATA_DIR || path.join(root(), "data")
export const relayDir = () => path.join(dataDir(), "relay")
const LOOP = () => process.env.RELAY_LOOP_SCRIPT || path.join(root(), "scripts", "relay-loop.sh")
const port = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback
}
export const relayPorts = () => ({ rtmp: port("RELAY_RTMP_PORT", 19350), hls: port("RELAY_HLS_PORT", 18888), api: port("RELAY_API_PORT", 19997) })
/** Interface MediaMTX binds. Keep 127.0.0.1: the app proxies the preview; publishers are local. */
const bindHost = () => process.env.RELAY_BIND || "127.0.0.1"
/** Where the RTMP ingest listens when "Accept program ingest from LAN" is on. */
const ingestHost = () => process.env.INGEST_HOST || "0.0.0.0"

/** Pure: this machine's LAN IPv4 for the second laptop's OBS (private ranges first, en0/eth0 preferred). */
export function pickLanIp(ifaces: Record<string, { family: string | number; address: string; internal: boolean }[] | undefined>): string | null {
  const found: { name: string; address: string }[] = []
  for (const [name, list] of Object.entries(ifaces)) for (const a of list ?? []) if ((a.family === "IPv4" || a.family === 4) && !a.internal && !a.address.startsWith("169.254.")) found.push({ name, address: a.address })
  const priv = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
  const score = (f: { name: string; address: string }) => (priv(f.address) ? 0 : 10) + (/^(en0|eth0|wlan0|en1)$/.test(f.name) ? 0 : 1) + (/^(utun|tun|tap|docker|br-|veth|bridge|vboxnet|zt)/.test(f.name) ? 5 : 0)
  return found.sort((a, b) => score(a) - score(b))[0]?.address ?? null
}
/** The LAN IP OBS should reach (INGEST_HOST if pinned to one address, else detected). */
export function lanIp(): string | null {
  return process.env.INGEST_HOST && process.env.INGEST_HOST !== "0.0.0.0" ? process.env.INGEST_HOST : pickLanIp(os.networkInterfaces())
}
export function lanServerUrl(): string | null {
  if (!readSettings().lanIngest) return null
  const host = lanIp()
  return host ? `rtmp://${host}:${relayPorts().rtmp}/` : null
}
/** rtmp://<name>.local:<port>/ while the mDNS name is actually being advertised. */
export function mdnsServerUrl(): string | null {
  const st = mdnsStatus()
  return readSettings().lanIngest && st.state === "active" && st.host ? `rtmp://${st.host}:${relayPorts().rtmp}/` : null
}
/** What the mDNS advertiser should publish right now (null = nothing). */
export function wantedMdns(): MdnsConfig | null {
  const settings = readSettings()
  const ip = settings.programArmed && settings.lanIngest ? lanIp() : null
  return ip ? { name: settings.mdnsName, ip, port: relayPorts().rtmp } : null
}
export function setMdnsName(raw: unknown): Promise<RelayResult> {
  return withLock(async () => {
    const name = cleanMdnsName(raw)
    if (!name) return { ok: false, status: 400, error: "Name: letters, digits and hyphens only (e.g. hyphen-stream), up to 63." }
    writeSettings({ ...readSettings(), mdnsName: name })
    return { ok: true, note: `LAN name: ${name}.local` }
  })
}
export function setLanIngest(on: boolean): Promise<RelayResult> {
  return withLock(async () => {
    writeSettings({ ...readSettings(), lanIngest: on })
    if (relayRunning()) writeConfigIfChanged()
    return { ok: true, note: on ? "Program ingest accepts OBS from the LAN (keys still required)." : "Program ingest is local-only again." }
  })
}
const STALL_MS = 20_000

// ---------- files ----------

function file(name: string) {
  return path.join(relayDir(), name)
}
function ensureDir() {
  fs.mkdirSync(relayDir(), { recursive: true, mode: 0o700 })
}
function writePrivate(target: string, content: string) {
  ensureDir()
  fs.writeFileSync(`${target}.tmp`, content, { mode: 0o600 })
  fs.chmodSync(`${target}.tmp`, 0o600)
  fs.renameSync(`${target}.tmp`, target)
}
function readJson<T>(target: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8")) as T
  } catch {
    return null
  }
}

/** `enabled` = forwards on (fan-out). The MediaMTX server itself runs whenever a channel publishes to it or forwards are on. */
export type RelaySettings = {
  enabled: boolean
  forwards: Record<RelayPath, string[]>
  /** OBS program feed armed: MediaMTX stays up and accepts OBS on /program (and the backup on /program-backup). */
  programArmed: boolean
  /** Backup input pulled by MediaMTX from this RTMP/RTSP/HLS/SRT URL instead of a publisher ("" = publish). */
  backupPullUrl: string
  failover: FailoverSettings
  /** Accept OBS on /program and /program-backup from the LAN (RTMP ingest on 0.0.0.0 / INGEST_HOST). Default off. */
  lanIngest: boolean
  /** mDNS name: <mdnsName>.local while LAN ingest is on */
  mdnsName: string
}
/** Pure: what may go in `source:` for the backup pull (no file:, no shell, no YAML breakage). */
export { pullUrlError }
export function validPullUrl(url: string): boolean {
  return pullUrlError(url) === null
}
export function readSettings(): RelaySettings {
  const raw = readJson<Partial<RelaySettings>>(file("settings.json"))
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
  return { enabled: raw?.enabled === true, forwards: { slate: list(raw?.forwards?.slate), capture: list(raw?.forwards?.capture), vertical: list(raw?.forwards?.vertical) }, programArmed: raw?.programArmed === true,
    backupPullUrl: typeof raw?.backupPullUrl === "string" && validPullUrl(raw.backupPullUrl) ? raw.backupPullUrl : "",
    failover: parseFailover(raw?.failover),
    lanIngest: raw?.lanIngest === true,
    mdnsName: cleanMdnsName(raw?.mdnsName) ?? DEFAULT_MDNS_NAME,
  }
}
function writeSettings(settings: RelaySettings) {
  writePrivate(file("settings.json"), JSON.stringify(settings, null, 2))
}

type Credentials = { publishUser: string; publishPass: string; readUser: string; readPass: string; /** OBS's own publish login, for /program only. */ programUser?: string; programPass?: string; /** Backup publisher's own login, for /program-backup only. */ backupUser?: string; backupPass?: string; /** Vertical (9:16) output's publish login, for /vertical only, localhost only. */ verticalUser?: string; verticalPass?: string }
export const PROGRAM_PATH = "program"
export const BACKUP_PATH = "program-backup"
function token(bytes = 18) {
  return crypto.randomBytes(bytes).toString("base64url")
}
export function credentials(): Credentials {
  const existing = readJson<Credentials>(file("credentials.json"))
  if (existing?.publishPass && existing.readPass) {
    if (existing.programUser && existing.programPass && existing.backupUser && existing.backupPass && existing.verticalUser && existing.verticalPass) return existing
    const upgraded = { ...existing, programUser: existing.programUser || `obs_${token(4)}`, programPass: existing.programPass || token(), backupUser: existing.backupUser || `bak_${token(4)}`, backupPass: existing.backupPass || token(), verticalUser: existing.verticalUser || `vrt_${token(4)}`, verticalPass: existing.verticalPass || token() }
    writePrivate(file("credentials.json"), JSON.stringify(upgraded))
    return upgraded
  }
  const created = { publishUser: `pub_${token(4)}`, publishPass: token(), readUser: `read_${token(4)}`, readPass: token(), programUser: `obs_${token(4)}`, programPass: token(), backupUser: `bak_${token(4)}`, backupPass: token(), verticalUser: `vrt_${token(4)}`, verticalPass: token() }
  writePrivate(file("credentials.json"), JSON.stringify(created))
  return created
}

/**
 * New publish login for ONE input (its OBS must be updated; the other input keeps working).
 * Only that path's publisher is kicked.
 */
export function rotateProgramCredentials(which: "main" | "backup" = "main"): Promise<RelayResult> {
  return withLock(async () => {
    const c = credentials()
    const next = which === "backup" ? { ...c, backupUser: `bak_${token(4)}`, backupPass: token() } : { ...c, programUser: `obs_${token(4)}`, programPass: token() }
    writePrivate(file("credentials.json"), JSON.stringify(next))
    if (relayRunning()) writeConfigIfChanged()
    await kickProgramUnlocked(which === "backup" ? [BACKUP_PATH] : [PROGRAM_PATH])
    return { ok: true, note: which === "backup" ? "New backup stream key. Update the backup OBS." : "New Main OBS stream key. Update OBS (backup key unchanged)." }
  })
}

/**
 * Pure: the MediaMTX config. Only RTMP (publish/read), LL-HLS (preview) and the API, all on `host`.
 * Internal publishers may publish to slate/capture only; OBS's login (only while `programArmed`)
 * may publish to /program only.
 */
export function buildMediamtxConfig(input: { host: string; ports: { rtmp: number; hls: number; api: number }; creds: Credentials; programArmed?: boolean; backupPullUrl?: string; /** RTMP ingest host when LAN ingest is on (else `host`) */ ingestHost?: string }): string {
  const { host, ports, creds } = input
  // LAN ingest: only the RTMP listener moves; HLS and the API stay on `host`. Only the program/backup
  // publish logins may connect from other addresses, and only to publish their own path. Reads,
  // the API and the internal slate/capture publishers stay loopback-only.
  const lan = Boolean(input.programArmed && input.ingestHost && input.ingestHost !== host)
  const obsIps = lan ? "['0.0.0.0/0', '::/0']" : null
  const program = input.programArmed && creds.programUser && creds.programPass
  const pull = input.programArmed && input.backupPullUrl && validPullUrl(input.backupPullUrl) ? input.backupPullUrl : ""
  const backup = input.programArmed && !pull && creds.backupUser && creds.backupPass
  const local = "['127.0.0.1/32', '::1/128']"
  return [
    "# Generated by stream-timer (lib/relay.ts) on every relay start. Do not edit; do not commit.",
    "logLevel: info",
    "logDestinations: [stdout]",
    "readTimeout: 10s",
    "writeTimeout: 10s",
    "rtsp: no",
    `rtspAddress: ${host}:${ports.rtmp + 1}`,
    "srt: no",
    "webrtc: no",
    "moq: no",
    "playback: no",
    "metrics: no",
    "pprof: no",
    "rtmp: yes",
    `rtmpAddress: ${lan ? input.ingestHost : host}:${ports.rtmp}`,
    "hls: yes",
    `hlsAddress: ${host}:${ports.hls}`,
    "hlsVariant: lowLatency",
    "hlsSegmentCount: 7",
    "hlsSegmentDuration: 1s",
    "hlsPartDuration: 200ms",
    "hlsAlwaysRemux: no",
    "api: yes",
    `apiAddress: ${host}:${ports.api}`,
    "authMethod: internal",
    "authInternalUsers:",
    `  - user: ${JSON.stringify(creds.publishUser)}`,
    `    pass: ${JSON.stringify(creds.publishPass)}`,
    `    ips: ${local}`,
    `    permissions: [${CHANNEL_PATHS.map((name) => `{ action: publish, path: ${name} }`).join(", ")}]`,
    ...(creds.verticalUser && creds.verticalPass ? [
      `  - user: ${JSON.stringify(creds.verticalUser)}`,
      `    pass: ${JSON.stringify(creds.verticalPass)}`,
      `    ips: ${local}`,
      `    permissions: [{ action: publish, path: ${VERTICAL_PATH} }]`,
    ] : []),
    ...(program ? [
      `  - user: ${JSON.stringify(creds.programUser)}`,
      `    pass: ${JSON.stringify(creds.programPass)}`,
      `    ips: ${obsIps ?? local}`,
      `    permissions: [{ action: publish, path: ${PROGRAM_PATH} }]`,
    ] : []),
    ...(backup ? [
      `  - user: ${JSON.stringify(creds.backupUser)}`,
      `    pass: ${JSON.stringify(creds.backupPass)}`,
      `    ips: ${obsIps ?? local}`,
      `    permissions: [{ action: publish, path: ${BACKUP_PATH} }]`,
    ] : []),
    `  - user: ${JSON.stringify(creds.readUser)}`,
    `    pass: ${JSON.stringify(creds.readPass)}`,
    `    ips: ${local}`,
    "    permissions: [{ action: read }, { action: api }]",
    "paths:",
    ...RELAY_PATHS.map((name) => `  ${name}: {}`),
    // A reconnecting OBS (Wi-Fi blip, kill -9) takes over its path at once instead of being refused
    // until the dead session times out.
    `  ${PROGRAM_PATH}: { overridePublisher: yes }`,
    // Backup: a second publisher, or MediaMTX pulls it (always on while armed, so failover is instant).
    pull ? `  ${BACKUP_PATH}: { source: ${JSON.stringify(pull)}, sourceOnDemand: no }` : `  ${BACKUP_PATH}: { overridePublisher: yes }`,
    "",
  ].join("\n")
}

// ---------- binary ----------

export function findMediamtxBin(): string | null {
  const candidates = [process.env.MEDIAMTX_BIN, path.join(root(), "bin", "mediamtx"), "/opt/homebrew/bin/mediamtx", "/usr/local/bin/mediamtx", "/usr/bin/mediamtx"]
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, "mediamtx"))
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      fs.accessSync(/* turbopackIgnore: true */ candidate, fs.constants.X_OK)
      if (fs.statSync(/* turbopackIgnore: true */ candidate).isFile()) return candidate
    } catch { /* next */ }
  }
  return null
}
let versionCache: { bin: string; version: string | null } | null = null
function mediamtxVersion(bin: string): string | null {
  if (versionCache?.bin === bin) return versionCache.version
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 3000 })
  versionCache = { bin, version: result.status === 0 ? result.stdout.trim().split(/\s+/)[0] || null : null }
  return versionCache.version
}

// ---------- URLs (server side only; never sent to the client) ----------

export function relayPublishUrl(name: RelayPath): string {
  const c = credentials()
  const [user, pass] = name === VERTICAL_PATH ? [c.verticalUser ?? "", c.verticalPass ?? ""] : [c.publishUser, c.publishPass]
  return `rtmp://127.0.0.1:${relayPorts().rtmp}/${name}?user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`
}
export function relayReadUrl(name: RelayPath | typeof PROGRAM_PATH | typeof BACKUP_PATH): string {
  const c = credentials()
  return `rtmp://127.0.0.1:${relayPorts().rtmp}/${name}?user=${encodeURIComponent(c.readUser)}&pass=${encodeURIComponent(c.readPass)}`
}
function basicAuth(): string {
  const c = credentials()
  return `Basic ${Buffer.from(`${c.readUser}:${c.readPass}`).toString("base64")}`
}
export function isRelayUrl(url: string): boolean {
  return RELAY_PATHS.some((name) => url.startsWith(`rtmp://127.0.0.1:${relayPorts().rtmp}/${name}?`))
}

// ---------- processes ----------

type Pidfile = { pid: number; startedAt: number; tag: string; adopted?: boolean }
type LoopState = { state: "running" | "waiting"; restarts: number; reconnects?: number; updatedAt: number; lastExit: number | null }

const forwardKey = (name: RelayPath, destId: string) => `fwd-${name}-${destId.replace(/[^a-zA-Z0-9-]/g, "")}`
function forwardTag(name: RelayPath, destId: string, fingerprint: string) {
  return `forward:${name}:${destId}:dest=${fingerprint}`
}

function loopAlive(key: string): Pidfile | null {
  const meta = readJson<Pidfile>(file(`${key}.json`))
  if (!meta?.pid) return null
  if (pidRunsScript(meta.pid, LOOP())) return meta
  return null
}

function spawnLoop(key: string, tag: string, command: string[], opts: { redact?: boolean; forward?: boolean } = {}) {
  ensureDir()
  const log = file(`${key}.log`)
  fs.writeFileSync(log, "", { mode: 0o600 })
  fs.chmodSync(log, 0o600)
  const out = fs.openSync(log, "a")
  const child = spawn("bash", [LOOP(), tag, "--", ...command], {
    cwd: relayDir(),
    detached: true,
    stdio: ["ignore", out, out],
    env: relayChildEnv({
      LOOP_STATE_FILE: file(`${key}-state.json`),
      LOOP_REDACT: opts.redact ? "1" : "",
      // Forwards: retry within 5s (a capture relaunch shouldn't leave YouTube dark for 30s), and a
      // watchdog restarts a forward whose bytes-sent stops growing for 25s. MediaMTX keeps 30s.
      ...(opts.forward ? { LOOP_MAX_DELAY: "5", LOOP_WATCH_LOG: log, LOOP_STALL_SECS: "25", LOOP_STALL_GRACE: "30" } : {}),
    }),
  })
  fs.closeSync(out)
  child.unref()
  if (!child.pid) throw new Error("could not start the relay process")
  writePrivate(file(`${key}.json`), JSON.stringify({ pid: child.pid, startedAt: Date.now(), tag } satisfies Pidfile))
  return child.pid
}

/** The Vertical (9:16) output (lib/vertical.ts) runs under relay-loop.sh too; forward reconcile/"Stop forwards" leave it alone. */
export const isVerticalTag = (tag: string) => tag.startsWith("vertical:")
export type OwnRelayLoop = { pid: number; tag: string }
/** Pure: our relay-loop.sh group leaders (this checkout's absolute script path) and their tags. */
export function parseRelayLoops(psOutput: string, loopPath: string): OwnRelayLoop[] {
  const found: OwnRelayLoop[] = []
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match || match[1] !== match[2]) continue
    const parts = match[3].trim().split(/\s+/)
    if (!/^(\S*\/)?bash$/.test(parts[0] ?? "")) continue
    const at = parts.indexOf(loopPath)
    if (at < 0 || !parts[at + 1]) continue
    found.push({ pid: Number(match[1]), tag: parts[at + 1] })
  }
  return found
}
export function findRelayLoops(): OwnRelayLoop[] {
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  return result.status === 0 ? parseRelayLoops(result.stdout, LOOP()) : []
}
/** Process groups the stray-publisher scan must ignore (our forwards publish over RTMP). */
export function relayProcessGroups(): number[] {
  return findRelayLoops().map((item) => item.pid)
}

/** Pidfile gone (or stale) but the loop still runs (server restarted): take it back. */
function adopt(loops: OwnRelayLoop[]) {
  for (const loop of loops) {
    let key: string | null = null
    if (loop.tag === "mediamtx") key = "mediamtx"
    const fwd = /^forward:(slate|capture|vertical):([^:]+):dest=[0-9a-f]{16}$/.exec(loop.tag)
    if (fwd) key = forwardKey(fwd[1] as RelayPath, fwd[2])
    if (!key || loopAlive(key)?.pid === loop.pid) continue
    if (loopAlive(key)) continue // a different live one owns the key; the reconcile pass will clean up
    writePrivate(file(`${key}.json`), JSON.stringify({ pid: loop.pid, startedAt: Date.now(), tag: loop.tag, adopted: true } satisfies Pidfile))
  }
}

// ---------- MediaMTX API ----------

type ApiPath = { name: string; ready: boolean; readyTime: string | null; tracks: string[]; tracks2?: { codec: string; codecProps?: { width?: number; height?: number; sampleRate?: number; channelCount?: number } }[]; readers: { type: string }[]; bytesReceived: number; source: { type: string } | null }
async function apiPaths(): Promise<Map<string, ApiPath> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${relayPorts().api}/v3/paths/list`, { headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(1500), cache: "no-store" })
    if (!response.ok) return null
    const body = (await response.json()) as { items?: ApiPath[] }
    return new Map((body.items ?? []).map((item) => [item.name, item]))
  } catch {
    return null
  }
}

/**
 * Read-only MediaMTX stats for the desk's A/V diagnostics (TC3). Our own relay API by default
 * (RELAY_API_PORT, read user); MEDIAMTX_API_URL points at another MediaMTX (e.g. http://127.0.0.1:9997).
 * null = API off / unreachable. Never changes anything.
 */
export type MediamtxPathStat = { name: string; ready: boolean; readyTime: string | null; source: string | null; readers: number; bytesReceived: number; bytesSent: number | null; tracks: string[] }
export async function mediamtxPathStats(): Promise<{ url: string; paths: MediamtxPathStat[] } | null> {
  const external = process.env.MEDIAMTX_API_URL?.replace(/\/+$/, "")
  const url = external || `http://127.0.0.1:${relayPorts().api}`
  try {
    const response = await fetch(`${url}/v3/paths/list`, { headers: external ? {} : { Authorization: basicAuth() }, signal: AbortSignal.timeout(1500), cache: "no-store" })
    if (!response.ok) return null
    const body = (await response.json()) as { items?: (ApiPath & { bytesSent?: number })[] }
    return {
      url,
      paths: (body.items ?? []).map((p) => ({ name: p.name, ready: p.ready === true, readyTime: p.readyTime ?? null, source: p.source?.type ?? null, readers: p.readers?.length ?? 0, bytesReceived: p.bytesReceived ?? 0, bytesSent: typeof p.bytesSent === "number" ? p.bytesSent : null, tracks: p.tracks ?? [] })),
    }
  } catch {
    return null
  }
}

// ---------- public operations ----------

const lock = { chain: Promise.resolve() as Promise<unknown> }
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = lock.chain.then(task, task)
  lock.chain = run.catch(() => undefined)
  return run
}

export type RelayResult = { ok: true; note?: string } | { ok: false; error: string; status: number }

async function ensureServerUnlocked(): Promise<RelayResult> {
  const bin = findMediamtxBin()
  if (!bin) return { ok: false, status: 500, error: "MediaMTX is not installed. Run scripts/install-mediamtx.sh (or brew install mediamtx), or set MEDIAMTX_BIN." }
  if (!loopAlive("mediamtx")) {
    writeConfigIfChanged()
    spawnLoop("mediamtx", "mediamtx", [bin, file("mediamtx.yml")])
  } else writeConfigIfChanged() // MediaMTX reloads its config file on change; channels keep running
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && !(await apiPaths())) await new Promise((resolve) => setTimeout(resolve, 150))
  if (!(await apiPaths())) return { ok: false, status: 500, error: `MediaMTX did not come up. Ports in use? ${tailOf("mediamtx").split("\n").slice(-3).join(" · ")}` }
  return { ok: true }
}

function desiredConfig() {
  return buildMediamtxConfig({ host: bindHost(), ports: relayPorts(), creds: credentials(), programArmed: readSettings().programArmed, backupPullUrl: readSettings().backupPullUrl, ingestHost: readSettings().lanIngest ? ingestHost() : undefined })
}
function writeConfigIfChanged() {
  const yml = desiredConfig()
  let current = ""
  try { current = fs.readFileSync(file("mediamtx.yml"), "utf8") } catch { /* first start */ }
  if (current.replace(/# resync .*\n$/, "") !== yml) writePrivate(file("mediamtx.yml"), yml)
}

/**
 * Read-only: remote host of each program input's publisher (RTMP push: rtmpconns remoteAddr; Backup pull:
 * the pull URL's host). null = no publisher / relay down. Used for per-source RTT, never changes anything.
 */
export async function programPublisherHosts(): Promise<Record<"main" | "backup", { host: string; via: "push" | "pull" } | null>> {
  const out: Record<"main" | "backup", { host: string; via: "push" | "pull" } | null> = { main: null, backup: null }
  try {
    const response = await fetch(`http://127.0.0.1:${relayPorts().api}/v3/rtmpconns/list`, { headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(1500), cache: "no-store" })
    if (response.ok) {
      const body = (await response.json()) as { items?: { path: string; state: string; remoteAddr?: string }[] }
      for (const conn of body.items ?? []) {
        if (conn.state !== "publish" || !conn.remoteAddr) continue
        const host = conn.remoteAddr.replace(/^\[?([^\]]+?)\]?:\d+$/, "$1")
        if (conn.path === PROGRAM_PATH) out.main = { host, via: "push" }
        if (conn.path === BACKUP_PATH) out.backup = { host, via: "push" }
      }
    }
  } catch { /* relay down */ }
  const pull = readSettings().backupPullUrl
  if (!out.backup && pull) {
    try { out.backup = { host: new URL(pull).hostname, via: "pull" } } catch { /* bad url */ }
  }
  return out
}

/** Disconnect whoever publishes /program (disarm / new key). */
async function kickProgramUnlocked(paths: string[] = [PROGRAM_PATH, BACKUP_PATH]) {
  if (!relayRunning()) return
  try {
    const api = `http://127.0.0.1:${relayPorts().api}/v3`
    const response = await fetch(`${api}/rtmpconns/list`, { headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(1500), cache: "no-store" })
    const body = (await response.json()) as { items?: { id: string; path: string; state: string }[] }
    for (const conn of body.items ?? []) {
      if (paths.includes(conn.path) && conn.state === "publish") await fetch(`${api}/rtmpconns/kick/${encodeURIComponent(conn.id)}`, { method: "POST", headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(1500) })
    }
  } catch { /* nothing to kick */ }
}

/** Arm receive: MediaMTX up (independent of forwards and channels) and OBS may publish to /program. */
export function armProgram(): Promise<RelayResult> {
  return withLock(async () => {
    writeSettings({ ...readSettings(), programArmed: true })
    const up = await ensureServerUnlocked()
    if (!up.ok) return up
    return { ok: true, note: "Armed: waiting for OBS on /program." }
  })
}

/** Disarm: OBS login removed and kicked; the server stops only if nothing else uses it. */
export function disarmProgram(): Promise<RelayResult> {
  return withLock(async () => {
    writeSettings({ ...readSettings(), programArmed: false })
    if (relayRunning()) writeConfigIfChanged()
    await kickProgramUnlocked()
    const stopped = await stopServerIfIdleUnlocked()
    programCache.ready = false; sourceCache.at = 0
    return { ok: true, note: stopped ? "Disarmed; relay server stopped (nothing else uses it)." : "Disarmed. The relay keeps running for the channels/forwards." }
  })
}

/** OBS settings (Server + Stream Key). Operator-only, on demand; never in status or logs. */
export function programObsUrl(): { server: string; streamKey: string; url: string; lanServer: string | null; mdnsServer: string | null } {
  const c = credentials()
  const server = `rtmp://127.0.0.1:${relayPorts().rtmp}/`
  const streamKey = `${PROGRAM_PATH}?user=${encodeURIComponent(c.programUser ?? "")}&pass=${encodeURIComponent(c.programPass ?? "")}`
  return { server, streamKey, url: `${server}${streamKey}`, lanServer: lanServerUrl(), mdnsServer: mdnsServerUrl() }
}

/** Backup publisher settings (second computer). Operator-only, on demand. */
export function backupObsUrl(): { server: string; streamKey: string; url: string; lanServer: string | null; mdnsServer: string | null } {
  const c = credentials()
  const server = `rtmp://127.0.0.1:${relayPorts().rtmp}/`
  const streamKey = `${BACKUP_PATH}?user=${encodeURIComponent(c.backupUser ?? "")}&pass=${encodeURIComponent(c.backupPass ?? "")}`
  return { server, streamKey, url: `${server}${streamKey}`, lanServer: lanServerUrl(), mdnsServer: mdnsServerUrl() }
}

/**
 * For Browser capture's program audio: the read URLs in 0600 files (never in env/argv of the capture
 * script). program-read.url = Main; program-backup-read.url next to it = Backup.
 */
export function programReadFile(): string {
  const target = file("program-read.url")
  writePrivate(target, relayReadUrl(PROGRAM_PATH))
  writePrivate(file("program-backup-read.url"), relayReadUrl(BACKUP_PATH))
  return target
}

/** Pull URL for the backup ("" = a publisher). Takes effect at once (MediaMTX reloads its config). */
export function setBackupPull(url: string): Promise<RelayResult> {
  return withLock(async () => {
    const clean = url.trim()
    const why = pullUrlError(clean)
    if (why) return { ok: false, status: 400, error: why }
    writeSettings({ ...readSettings(), backupPullUrl: clean })
    if (relayRunning()) writeConfigIfChanged()
    return { ok: true, note: clean ? "Backup pulls from the URL." : "Backup takes a publisher again." }
  })
}
export function setFailover(raw: unknown): Promise<RelayResult> {
  return withLock(async () => {
    writeSettings({ ...readSettings(), failover: parseFailover({ ...readSettings().failover, ...(raw && typeof raw === "object" ? raw : {}) }) })
    return { ok: true }
  })
}

/** Pure: does MediaMTX's live config (API) match the generated file on what matters for ingest? */
export function liveConfigMatches(yml: string, live: { rtmpAddress?: string; authInternalUsers?: { user: string }[] }): boolean {
  const want = /\nrtmpAddress: (\S+)/.exec(yml)?.[1]
  const users = [...yml.matchAll(/\n  - user: "([^"]+)"/g)].map((m) => m[1]).sort().join(",")
  return live.rtmpAddress === want && (live.authInternalUsers ?? []).map((u) => u.user).sort().join(",") === users
}
/**
 * MediaMTX hot-reloads mediamtx.yml, but two writes in quick succession (LAN toggle, New key, arm)
 * can leave it running the older one: e.g. RTMP still on 127.0.0.1 or an old OBS key, so the LAN
 * laptop gets "connection refused" / "authentication failed". Compare the live config with the
 * file and re-trigger the reload when they disagree twice in a row. Called by the program monitor.
 */
const configCheck = ((globalThis as { __mtxConfigCheck?: { at: number; misses: number; reloads: number } }).__mtxConfigCheck ??= { at: 0, misses: 0, reloads: 0 })
async function liveGlobalConfig(): Promise<{ rtmpAddress?: string; authInternalUsers?: { user: string }[] } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${relayPorts().api}/v3/config/global/get`, { headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(1500), cache: "no-store" })
    // 401: MediaMTX still runs a config with an older read login (credentials.json was recreated):
    // every internal reader (preview, capture, health) would fail auth on loopback. Treat as mismatch.
    if (response.status === 401) return { rtmpAddress: "?", authInternalUsers: [] }
    return response.ok ? ((await response.json()) as { rtmpAddress?: string; authInternalUsers?: { user: string }[] }) : null
  } catch {
    return null
  }
}
export async function verifyMediamtxConfig(now = Date.now()): Promise<void> {
  if (now - configCheck.at < 2000 || !relayRunning()) return
  configCheck.at = now
  try {
    const live = await liveGlobalConfig()
    if (!live) return
    const yml = desiredConfig()
    if (liveConfigMatches(yml, live)) { configCheck.misses = 0; return }
    if (++configCheck.misses < 2) return
    configCheck.misses = 0
    configCheck.reloads += 1
    // Same content plus a changing comment: a new file event MediaMTX can't coalesce away.
    writePrivate(file("mediamtx.yml"), `${yml}# resync ${configCheck.reloads} ${new Date(now).toISOString()}\n`)
    console.log(`[relay] MediaMTX was running an older config; reload re-triggered (${configCheck.reloads})`)
  } catch { /* API down: the loop restarts it */ }
}
export function mediamtxConfigResyncs(): number {
  return configCheck.reloads
}

// ---------- both program inputs: health for the switcher and auto-failover ----------
type SourceTrack = { ready: boolean; bytes: number; bytesAt: number; grewAt: number | null; kbps: number | null; readyTime: string | null }
const sourceCache = ((globalThis as { __programSources?: { at: number; main: SourceTrack; backup: SourceTrack } }).__programSources ??= {
  at: 0,
  main: { ready: false, bytes: 0, bytesAt: 0, grewAt: null, kbps: null, readyTime: null },
  backup: { ready: false, bytes: 0, bytesAt: 0, grewAt: null, kbps: null, readyTime: null },
})
function trackSource(t: SourceTrack, info: ApiPath | undefined, now: number) {
  if (!info?.ready) return Object.assign(t, { ready: false, bytes: 0, bytesAt: 0, grewAt: null, kbps: null, readyTime: null })
  if (t.readyTime !== info.readyTime) Object.assign(t, { bytes: info.bytesReceived, bytesAt: now, grewAt: now, kbps: null, readyTime: info.readyTime })
  if (info.bytesReceived > t.bytes) t.grewAt = now
  if (now - t.bytesAt >= 1000) {
    t.kbps = Math.max(0, Math.round(((info.bytesReceived - t.bytes) * 8) / (now - t.bytesAt)))
    t.bytes = info.bytesReceived
    t.bytesAt = now
  }
  t.ready = true
}
/** Poll MediaMTX for both inputs (cached 400ms; one API call). */
export async function refreshProgramSources(): Promise<void> {
  const now = Date.now()
  if (now - sourceCache.at < 400) return
  sourceCache.at = now
  const api = readSettings().programArmed && relayRunning() ? await apiPaths() : null
  trackSource(sourceCache.main, api?.get(PROGRAM_PATH), now)
  trackSource(sourceCache.backup, api?.get(BACKUP_PATH), now)
  programCache.ready = sourceCache.main.ready
}
export function programSourceHealth(source: ProgramSource, now = Date.now()): ProgramSourceHealth {
  const t = sourceCache[source]
  return { ready: t.ready, kbps: t.ready ? t.kbps : null, dataAgeMs: t.ready && t.grewAt !== null ? now - t.grewAt : null }
}

// Cached /program readiness for /api/public/state (polled every second by every /stream).
const programCache = ((globalThis as { __programCache?: { at: number; ready: boolean; bytes: number; bytesAt: number; kbps: number | null; fpsFor: string | null; fps: number | null } }).__programCache ??= { at: 0, ready: false, bytes: 0, bytesAt: 0, kbps: null, fpsFor: null, fps: null })

/** OBS's frame rate, probed once per publish (MediaMTX's API doesn't report it). */
function probeProgramFps(readyTime: string) {
  if (programCache.fpsFor === readyTime) return
  programCache.fpsFor = readyTime
  programCache.fps = null
  const probeBin = process.env.FFPROBE_BIN || "ffprobe"
  const child = spawn(/* turbopackIgnore: true */ probeBin, ["-v", "error", "-rw_timeout", "5000000", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate,r_frame_rate", "-of", "csv=p=0", relayReadUrl(PROGRAM_PATH)], { stdio: ["ignore", "pipe", "ignore"] })
  let out = ""
  child.stdout.on("data", (chunk) => (out += chunk))
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000)
  child.on("exit", () => {
    clearTimeout(timer)
    const rate = out.split(/[\s,]+/).map((v) => { const [a, b] = v.split("/").map(Number); return b ? a / b : a }).find((v) => Number.isFinite(v) && v > 0 && v < 241)
    if (programCache.fpsFor === readyTime) programCache.fps = rate ? Math.round(rate * 100) / 100 : null
  })
}
/** Is the given input (default Main) publishing? */
export async function programReady(source: ProgramSource = "main"): Promise<boolean> {
  if (!readSettings().programArmed || !relayRunning()) return false
  await refreshProgramSources()
  return sourceCache[source].ready
}
export function programReadyCached(source: ProgramSource = "main"): boolean | null {
  return readSettings().programArmed ? sourceCache[source].ready : null
}

export type ProgramStatus = { armed: boolean; ready: boolean; tracks: string[]; kbps: number | null; fps: number | null; video: string | null; audio: string | null; /** What MediaMTX says OBS sends as audio (null = no audio track). */ audioTrack: { codec: string; channels: number | null; sampleRate: number | null } | null; readers: number; since: string | null }

/** Channel start (destination "relay"): make sure the MediaMTX server is up. Does not touch forwards. */
export function ensureRelayServer(): Promise<RelayResult> {
  return withLock(ensureServerUnlocked)
}

/** "Start forwards": fan-out on for every ticked destination (server started if needed). */
export function startRelay(): Promise<RelayResult> {
  return withLock(async () => {
    const up = await ensureServerUnlocked()
    if (!up.ok) return up
    writeSettings({ ...readSettings(), enabled: true })
    await reconcileUnlocked()
    return { ok: true }
  })
}

async function killForwardsUnlocked() {
  for (const loop of findRelayLoops()) if (loop.tag !== "mediamtx" && !isVerticalTag(loop.tag)) await killGroup(loop.pid)
  for (const name of fs.existsSync(relayDir()) ? fs.readdirSync(relayDir()) : []) {
    if (/^fwd-.*\.json$/.test(name)) fs.rmSync(file(name), { force: true })
  }
}
const publishingChannels = () => [...directChannelDests().filter((item) => item.running && item.relay), ...(verticalPublishing() ? [{ channel: VERTICAL_PATH, running: true, relay: true }] : [])]
/** The Vertical output's loop is alive (its pidfile names a running relay-loop.sh). Read here, not via lib/vertical (that imports this module). */
/** Destinations the Vertical output pushes to directly (fingerprints from its pidfile), as "direct" publishers. */
export function verticalDirectDests(): { channel: string; running: boolean; dest?: string; relay?: boolean }[] {
  const meta = readJson<{ pid?: number; dests?: unknown }>(path.join(dataDir(), "vertical", "vertical.json"))
  if (!meta?.pid || !Array.isArray(meta.dests) || !pidRunsScript(meta.pid, LOOP())) return []
  return meta.dests.filter((d): d is string => typeof d === "string").map((dest) => ({ channel: VERTICAL_PATH, running: true, dest }))
}
const allDirectDests = () => [...directChannelDests(), ...verticalDirectDests()]
export function verticalPublishing(): boolean {
  const meta = readJson<{ pid?: number; relay?: boolean }>(path.join(dataDir(), "vertical", "vertical.json"))
  return Boolean(meta?.pid && meta.relay !== false && pidRunsScript(meta.pid, LOOP()))
}

async function stopServerIfIdleUnlocked() {
  const settings = readSettings()
  if (settings.enabled || settings.programArmed || publishingChannels().length > 0) return false
  for (const loop of findRelayLoops()) if (loop.tag === "mediamtx") await killGroup(loop.pid)
  for (const name of ["mediamtx.json", "mediamtx-state.json"]) fs.rmSync(file(name), { force: true })
  return true
}

/**
 * "Stop forwards": fan-out off. Channels keep publishing to the relay and the preview keeps
 * working; the server only stops if nothing publishes to it. Ticks are kept for next time.
 */
export function stopRelay(): Promise<RelayResult> {
  return withLock(async () => {
    writeSettings({ ...readSettings(), enabled: false })
    await killForwardsUnlocked()
    const stopped = await stopServerIfIdleUnlocked()
    return { ok: true, note: stopped ? "Forwards stopped; relay server stopped (nothing publishing)." : "Forwards stopped. Channels keep publishing to the relay." }
  })
}

/** After a channel stops: stop the server if nothing uses it any more. */
export function stopRelayServerIfIdle(): Promise<boolean> {
  return withLock(stopServerIfIdleUnlocked)
}

/**
 * Stop all (outgoing): forwards off and their processes gone. The program INPUTS are not outputs:
 * while armed, MediaMTX keeps running so OBS (incl. a LAN laptop) stays connected. Disarm stops it.
 */
export function stopRelayEverything(): Promise<RelayResult> {
  return withLock(async () => {
    writeSettings({ ...readSettings(), enabled: false })
    const keep = readSettings().programArmed
    for (const loop of findRelayLoops()) if (!(keep && loop.tag === "mediamtx")) await killGroup(loop.pid)
    for (const name of fs.existsSync(relayDir()) ? fs.readdirSync(relayDir()) : []) {
      if ((keep ? /^fwd-.*(-state)?\.json$/ : /^(mediamtx|fwd-.*)(-state)?\.json$/).test(name)) fs.rmSync(file(name), { force: true })
    }
    return { ok: true }
  })
}

function relayRunning() {
  return loopAlive("mediamtx") !== null
}

/** Fingerprints of destinations the relay forwards to (enabled forwards, while the relay is on). */
export function relayForwardFingerprints(): { path: RelayPath; dest: string; destId: string }[] {
  const settings = readSettings()
  if (!settings.enabled) return []
  const out: { path: RelayPath; dest: string; destId: string }[] = []
  for (const name of RELAY_PATHS) {
    for (const destId of settings.forwards[name]) {
      const destination = resolveDestination(destId)
      if (destination) out.push({ path: name, dest: destinationFingerprint(destination.url), destId })
    }
  }
  return out
}

/**
 * Pure: may `path` forward to the destination with this fingerprint? Not if the other relay
 * path forwards there, or a direct channel publishes there (one publisher per stream key).
 */
export function forwardConflict(target: { path: RelayPath; dest: string }, forwards: { path: RelayPath; dest: string }[], direct: { channel: string; running: boolean; dest?: string; relay?: boolean }[]): string | null {
  const other = forwards.find((item) => item.dest === target.dest && item.path !== target.path)
  if (other) return `Relay /${other.path} already forwards to this destination. One stream key takes one publisher.`
  const channel = direct.find((item) => item.running && !item.relay && item.dest === target.dest)
  if (channel) return `The ${channel.channel === "capture" ? "Browser capture" : channel.channel === VERTICAL_PATH ? "Vertical" : "Slate"} stream publishes to this destination directly. Stop it or pick another destination.`
  return null
}

export function setForward(name: RelayPath, destId: string, on: boolean): Promise<RelayResult> {
  const direct = allDirectDests()
  return withLock(async () => {
    const destination = resolveDestination(destId)
    if (!destination) return { ok: false, status: 404, error: "No such destination." }
    const settings = readSettings()
    const current = new Set(settings.forwards[name])
    if (on) {
      const dest = destinationFingerprint(destination.url)
      const clash = forwardConflict({ path: name, dest }, RELAY_PATHS.flatMap((p) => settings.forwards[p].map((id) => ({ path: p, dest: (() => { const d = resolveDestination(id); return d ? destinationFingerprint(d.url) : "" })() }))), direct)
      if (clash) return { ok: false, status: 409, error: clash }
      current.add(destId)
    } else current.delete(destId)
    writeSettings({ ...settings, forwards: { ...settings.forwards, [name]: [...current] } })
    await reconcileUnlocked()
    return { ok: true }
  })
}

/** Brings forwards in line with settings: running for each enabled forward while MediaMTX runs, nothing else. */
async function reconcileUnlocked() {
  const loops = findRelayLoops()
  adopt(loops)
  const settings = readSettings()
  // The server must run while a channel publishes into it or forwards are on (e.g. pidfile lost).
  if (!relayRunning() && (settings.enabled || settings.programArmed || publishingChannels().length > 0) && findMediamtxBin()) await ensureServerUnlocked()
  const on = settings.enabled && relayRunning()
  const wanted = new Map<string, { name: RelayPath; destId: string; url: string; tag: string }>()
  if (on) {
    for (const name of RELAY_PATHS) {
      for (const destId of settings.forwards[name]) {
        const destination = resolveDestination(destId)
        if (!destination) continue
        // Never become a second publisher on a key a direct channel is already using.
        if (forwardConflict({ path: name, dest: destinationFingerprint(destination.url) }, [], allDirectDests())) continue
        wanted.set(forwardKey(name, destId), { name, destId, url: destination.url, tag: forwardTag(name, destId, destinationFingerprint(destination.url)) })
      }
    }
  }
  // Stop forwards no longer wanted (or whose destination URL changed), including unknown leftovers.
  for (const loop of findRelayLoops()) {
    if (loop.tag === "mediamtx" || isVerticalTag(loop.tag)) continue
    const fwd = /^forward:(slate|capture|vertical):([^:]+):/.exec(loop.tag)
    const key = fwd ? forwardKey(fwd[1] as RelayPath, fwd[2]) : null
    const want = key ? wanted.get(key) : undefined
    if (!want || want.tag !== loop.tag) {
      await killGroup(loop.pid)
      if (key) for (const suffix of [".json", "-state.json"]) fs.rmSync(file(`${key}${suffix}`), { force: true })
    }
  }
  for (const [key, want] of wanted) {
    if (loopAlive(key)) continue
    spawnLoop(key, want.tag, forwardCommand(want.name, want.url), { redact: true, forward: true })
  }
}

/** Pure-ish: the forward ffmpeg. The destination URL (with its key) is an argv entry: ffmpeg has no other way to take an RTMP output URL. */
export function forwardCommand(name: RelayPath, destinationUrl: string): string[] {
  return [process.env.FFMPEG_BIN || "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "info", "-nostats", "-progress", "pipe:1", "-stats_period", "5",
    "-rw_timeout", "10000000", "-i", relayReadUrl(name), "-map", "0", "-c", "copy", "-f", "flv", "-rw_timeout", "15000000", destinationUrl]
}

let reconcileAt = 0
export async function reconcileRelay() {
  if (Date.now() - reconcileAt < 2000) return
  reconcileAt = Date.now()
  await withLock(reconcileUnlocked)
}

function tailOf(key: string, bytes = 16384): string {
  try {
    const target = file(`${key}.log`)
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
function logAgeMs(key: string): number | null {
  try {
    return Date.now() - fs.statSync(file(`${key}.log`)).mtimeMs
  } catch {
    return null
  }
}

export type ForwardState = "blocked" | "off" | "waiting" | "connecting" | "forwarding" | "retrying" | "stalled"
/** Pure: one forward's state from its loop state, path readiness and log freshness. */
export function deriveForwardState(input: { running: boolean; loop: LoopState | null; sourceReady: boolean; logAgeMs: number | null; lastLine: string; runAgeMs: number | null }): ForwardState {
  if (!input.running) return "off"
  if (!input.sourceReady) return "waiting"
  if (input.loop?.state === "waiting") return "retrying"
  // -progress pipe:1 prints a key=value block ending in progress=continue every 5s.
  const progress = /^progress=continue|(frame=|size=)\s*\S+.*time=/.test(input.lastLine)
  if (!progress) return (input.runAgeMs ?? 0) > STALL_MS ? "stalled" : "connecting"
  if (input.logAgeMs !== null && input.logAgeMs > STALL_MS) return "stalled"
  return "forwarding"
}

/** restarts = every relaunch of the forward ffmpeg (incl. quick retries); reconnects = relaunches after a working run (10s+) dropped. */
export type RelayForwardStatus = { destId: string; name: string; host: string; state: ForwardState; restarts: number; reconnects: number; error: string | null; adopted: boolean; health: HealthStats }
export type RelayPathStatus = { name: RelayPath; ready: boolean; publisher: string | null; tracks: string[]; readers: number; bytesReceived: number; forwards: RelayForwardStatus[]; source: SourceHealth | HealthStats | null; outKbps: number; diagnosis: { level: Level; text: string } }
export type IngestDiag = { resyncs: number; listen: string | null; lan: boolean; lanUrl: string | null; mdnsUrl: string | null; mdns: MdnsState; lastReject: { at: string; text: string } | null; logFile: string }
/**
 * Pure: from MediaMTX's log, where the RTMP ingest last started listening and the last refused /
 * failed publish (auth failure, path taken, timeout), redacted of query strings.
 */
export function parseIngestLog(log: string): { listen: string | null; lastReject: { at: string; from?: string; text: string } | null } {
  let listen: string | null = null
  let lastReject: { at: string; from?: string; text: string } | null = null
  for (const line of log.split("\n")) {
    const l = /\[RTMP\] (?:started|listener opened) .*?on ([^\s(]+)/.exec(line)
    if (l) listen = l[1]
    // Only real publish refusals: auth failures, a path that isn't allowed/configured, or a taken path.
    // A reader/preview hanging up (connection reset, EOF, timeout) is not a refusal.
    const conn = /\[RTMP\] \[conn ([^\]]+)\]/.exec(line)
    if (conn && /(failed to authenticate|authentication failed|already being published|is not configured|not allowed|permission denied)/i.test(line) && !/closed: terminated/.test(line)) {
      const at = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})/.exec(line)?.[1] ?? ""
      const loop = /^(127\.|\[?::1\]?:)/.test(conn[1])
      lastReject = { at, from: loop ? "this computer" : conn[1].replace(/:\d+$/, ""), text: line.replace(/^\S+ \S+ (INF|WAR|ERR) /, "").replace(/\?[^\s'"]*/g, "?…").slice(0, 200) }
    }
  }
  return { listen, lastReject }
}

export type BackupStatus = { lanIngest: boolean; ready: boolean; kbps: number | null; dataAgeMs: number | null; /** pull source: scheme://host only (no path/keys) */ pullFrom: string | null; failover: FailoverSettings; audioTrack: ProgramStatus["audioTrack"] }
export type RelayStatus = { ingest: IngestDiag; backup: BackupStatus; program: ProgramStatus; totalOutKbps: number; installed: boolean; bin: string | null; version: string | null; /** forwards on */ enabled: boolean; publishing: RelayPath[]; running: boolean; apiUp: boolean; adopted: boolean; restarts: number; error: string | null; paths: Record<RelayPath, RelayPathStatus> }

/** The audio track OBS publishes (tracks2 if MediaMTX has it, else the plain track names). */
export function programAudioTrack(prog: Pick<ApiPath, "tracks" | "tracks2">): ProgramStatus["audioTrack"] {
  const a = prog.tracks2?.find((t) => t.codecProps?.sampleRate || /aac|mpeg-4 audio|opus|mp3|mpeg-1\/2 audio|g711|lpcm|ac-3/i.test(t.codec))
  if (a) return { codec: a.codec === "MPEG-4 Audio" ? "AAC" : a.codec, channels: a.codecProps?.channelCount ?? null, sampleRate: a.codecProps?.sampleRate ?? null }
  const name = prog.tracks.find((t) => /aac|mpeg-4 audio|opus|mp3|mpeg-1\/2 audio|g711|lpcm|ac-3/i.test(t))
  return name ? { codec: name === "MPEG-4 Audio" ? "AAC" : name, channels: null, sampleRate: null } : null
}

export async function relayStatus(): Promise<RelayStatus> {
  await reconcileRelay().catch(() => undefined)
  const bin = findMediamtxBin()
  const settings = readSettings()
  const mtx = loopAlive("mediamtx")
  const api = mtx ? await apiPaths() : null
  const mtxState = readJson<LoopState>(file("mediamtx-state.json"))
  const dests = new Map(listDestinations().items.map((item) => [item.id, item]))
  const paths = {} as Record<RelayPath, RelayPathStatus>
  for (const name of RELAY_PATHS) {
    const info = api?.get(name)
    const channel = name === VERTICAL_PATH ? null : readChannelStatus(name)
    const source = channel?.running && channel.relay ? channel.health : null
    const expect = { fps: 30, kbps: name === VERTICAL_PATH ? 4500 + 128 : channel?.running && channel.relay && channel.bitrateK ? channel.bitrateK + 128 : null }
    const forwards = settings.forwards[name].filter((id) => dests.has(id)).map((destId): RelayForwardStatus => {
      const key = forwardKey(name, destId)
      const meta = loopAlive(key)
      const loop = readJson<LoopState>(file(`${key}-state.json`))
      const tail = tailOf(key)
      const lines = tail.split(/[\r\n]+/).filter(Boolean)
      const state = deriveForwardState({ running: meta !== null, loop, sourceReady: info?.ready === true, logAgeMs: logAgeMs(key), lastLine: lines.at(-1) ?? "", runAgeMs: loop?.updatedAt ? Date.now() - loop.updatedAt * 1000 : null })
      const errorLine = [...lines].reverse().find((line) => /error|failed|refused|timed out|denied|not found/i.test(line) && !/^\[relay-loop/.test(line))
      const dest = dests.get(destId)!
      const resolved = resolveDestination(destId)
      const blocked = !meta && resolved ? forwardConflict({ path: name, dest: destinationFingerprint(resolved.url) }, [], allDirectDests()) : null
      if (blocked && settings.enabled) return { destId, name: dest.name, host: dest.host, state: "blocked", restarts: 0, reconnects: 0, error: blocked, adopted: false, health: EMPTY_HEALTH }
      const health = meta && info?.ready ? healthFromSamples(parseProgressBlocks(tailOf(key, 32768)).slice(-13), 5, logAgeMs(key), expect) : EMPTY_HEALTH
      return { destId, name: dest.name, host: dest.host, state, restarts: loop?.restarts ?? 0, reconnects: loop?.reconnects ?? 0, error: state === "forwarding" || state === "off" ? null : (errorLine?.slice(0, 200) ?? null), adopted: meta?.adopted === true, health }
    })
    const outKbps = forwards.reduce((sum, item) => sum + (item.health.kbps ?? 0), 0)
    const diagnosis = diagnose({ source: source ? { label: name === "slate" ? "Slate" : name === "capture" ? "Browser capture" : "Vertical", health: source } : null, forwards: forwards.map((item) => ({ name: item.name, health: item.health })), totalKbps: outKbps || null, needKbps: expect.kbps ? expect.kbps * forwards.filter((item) => item.state !== "off" && item.state !== "blocked").length : null })
    paths[name] = { name, ready: info?.ready === true, publisher: info?.source?.type ?? null, tracks: info?.tracks ?? [], readers: info?.readers.length ?? 0, bytesReceived: info?.bytesReceived ?? 0, forwards, source, outKbps, diagnosis }
  }
  const prog = api?.get(PROGRAM_PATH)
  if (prog?.ready) {
    const now = Date.now()
    if (programCache.bytesAt && prog.bytesReceived >= programCache.bytes && now - programCache.bytesAt > 500) programCache.kbps = Math.round(((prog.bytesReceived - programCache.bytes) * 8) / (now - programCache.bytesAt))
    if (!programCache.bytesAt || now - programCache.bytesAt > 500) { programCache.bytes = prog.bytesReceived; programCache.bytesAt = now }
  } else Object.assign(programCache, { bytes: 0, bytesAt: 0, kbps: null })
  if (prog?.ready && prog.readyTime) probeProgramFps(prog.readyTime)
  const v = prog?.tracks2?.find((t) => t.codecProps?.width)
  const a = prog?.tracks2?.find((t) => t.codecProps?.sampleRate)
  const program: ProgramStatus = {
    armed: settings.programArmed, ready: prog?.ready === true, tracks: prog?.tracks ?? [],
    kbps: prog?.ready ? programCache.kbps : null, fps: prog?.ready ? programCache.fps : null,
    video: v ? `${v.codec} ${v.codecProps?.width}×${v.codecProps?.height}` : null,
    audio: a ? `${a.codec === "MPEG-4 Audio" ? "AAC" : a.codec} ${Math.round((a.codecProps?.sampleRate ?? 0) / 1000)}k ${a.codecProps?.channelCount === 1 ? "mono" : "stereo"}` : null,
    audioTrack: prog?.ready ? programAudioTrack(prog) : null,
    readers: prog?.readers.length ?? 0, since: prog?.ready ? prog.readyTime : null,
  }
  const lastLines = tailOf("mediamtx").split("\n").filter((line) => /ERR|FATAL/.test(line))
  // Upload estimate: every forward plus any channel publishing straight to a destination.
  const direct = CHANNEL_PATHS.map((name) => readChannelStatus(name)).filter((item) => item.running && !item.relay).reduce((sum, item) => sum + (item.health.kbps ?? 0), 0)
  await refreshProgramSources()
  let pullFrom: string | null = null
  if (settings.backupPullUrl) try { const u = new URL(settings.backupPullUrl); pullFrom = `${u.protocol}//${u.host}` } catch { pullFrom = "(url)" }
  const bk = api?.get(BACKUP_PATH)
  const backup: BackupStatus = { lanIngest: settings.lanIngest, ...programSourceHealth("backup"), pullFrom, failover: settings.failover, audioTrack: bk?.ready ? programAudioTrack(bk) : null }
  const parsedLog = parseIngestLog(mtx ? tailOf("mediamtx", 65536) : "")
  // Live bind from MediaMTX itself (the startup log line scrolls out of the tail on a busy relay).
  const live = api ? await liveGlobalConfig() : null
  const ingest: IngestDiag = { resyncs: mediamtxConfigResyncs(), listen: (live?.rtmpAddress !== "?" ? live?.rtmpAddress : undefined) ?? (api ? parsedLog.listen : null), lan: settings.lanIngest, lanUrl: lanServerUrl(), mdnsUrl: mdnsServerUrl(), mdns: mdnsStatus(), lastReject: parsedLog.lastReject, logFile: file("mediamtx.log") }
  return {
    ingest,
    backup,
    program,
    totalOutKbps: RELAY_PATHS.reduce((sum, name) => sum + paths[name].outKbps, 0) + direct,
    installed: bin !== null,
    bin,
    version: bin ? mediamtxVersion(bin) : null,
    enabled: settings.enabled,
    publishing: RELAY_PATHS.filter((name) => (name === VERTICAL_PATH ? verticalPublishing() : directChannelDests().some((item) => item.channel === name && item.running && item.relay))),
    running: mtx !== null,
    apiUp: api !== null,
    adopted: mtx?.adopted === true,
    restarts: mtxState?.restarts ?? 0,
    error: mtx && !api ? (lastLines.at(-1)?.slice(0, 200) ?? "MediaMTX is not answering yet.") : null,
    paths,
  }
}

/** For the HLS preview proxy. */
export function relayHlsOrigin() {
  return { origin: `http://127.0.0.1:${relayPorts().hls}`, authorization: basicAuth() }
}
