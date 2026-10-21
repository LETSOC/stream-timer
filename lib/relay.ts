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
import { dlog } from "@/lib/dropout-log"
import type { SrtLink } from "@/lib/rtt"
import { noteProgramDisarm, noteRelayDisruption } from "@/lib/program-rearm"
import { FEED_LABEL, nextArmState, parseDisarmed, type ArmScope, type FeedDisarmed } from "@/lib/program-arm"
import os from "node:os"
import { cleanMdnsName, DEFAULT_MDNS_NAME, mdnsStatus, type MdnsConfig, type MdnsState } from "@/lib/mdns"
import { parseFailover, pullUrlError, type FailoverSettings, type ProgramSource, type SourceHealth as ProgramSourceHealth } from "@/lib/program-source"
import crypto from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { destinationFingerprint, directChannelDests, readChannelStatus, killGroup, pidRunsScript, redact, relayChildEnv } from "@/lib/encoder"
import { listDestinations, resolveDestination, setDestinationTimer } from "@/lib/rtmp-destinations"
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
/** WebRTC (WHEP) preview: signalling HTTP on 127.0.0.1 (proxied), media on UDP/TCP `ice` (one port each). */
export const webrtcPorts = () => ({ http: port("RELAY_WEBRTC_PORT", 18889), ice: port("RELAY_WEBRTC_ICE_PORT", 8189) })
/** Where WebRTC media listens: all interfaces when the desk is served to the LAN (BIND_HOST), else loopback. */
export function webrtcIceHost(env: Record<string, string | undefined> = process.env): string {
  const b = env.BIND_HOST?.trim()
  return b && !/^(127\.|localhost$|::1$)/.test(b) ? (b === "::" ? "0.0.0.0" : b) : "127.0.0.1"
}
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
  /** While armed: which feed's OBS login is off (per-feed Disarm). Both off = programArmed false. */
  disarmed: FeedDisarmed
  /** Backup input pulled by MediaMTX from this RTMP/RTSP/HLS/SRT URL instead of a publisher ("" = publish). */
  backupPullUrl: string
  failover: FailoverSettings
  /** Accept OBS on /program and /program-backup from the LAN (RTMP ingest on 0.0.0.0 / INGEST_HOST). Default off. */
  lanIngest: boolean
  /** mDNS name: <mdnsName>.local while LAN ingest is on */
  mdnsName: string
  /** Also accept the Backup publisher over SRT (UDP, srtPort). Off = MediaMTX config exactly as before. */
  srtBackup: boolean
  /** Optional SRT encryption for /program-backup publishers ("" = off; 10–79 chars). */
  srtPassphrase: string
  /** Fast (WebRTC/WHEP, read-only) operator previews. Default on; off = HLS only and `webrtc: no`. */
  webrtcPreview: boolean
}
export const SRT_LATENCY_US = 300_000
export function srtPort(): number { return Number(process.env.SRT_PORT) || 8890 }
/** Pure: "" ok (off), else 10–79 printable chars without quotes/backslash (YAML + SRT limits). */
export function srtPassphraseError(p: string): string | null {
  if (p === "") return null
  if (p.length < 10 || p.length > 79) return "SRT passphrase: 10 to 79 characters (or blank for none)."
  if (!/^[\x21-\x7e]+$/.test(p) || /["'\\&?=#]/.test(p)) return "SRT passphrase: letters, digits and symbols except quotes, backslash, & ? = #."
  return null
}
/** Pure: what may go in `source:` for the backup pull (no file:, no shell, no YAML breakage). */
export { pullUrlError }
export function validPullUrl(url: string): boolean {
  return pullUrlError(url) === null
}
export function readSettings(): RelaySettings {
  const raw = readJson<Partial<RelaySettings>>(file("settings.json"))
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
  return { enabled: raw?.enabled === true, forwards: { slate: list(raw?.forwards?.slate), capture: list(raw?.forwards?.capture), vertical: list(raw?.forwards?.vertical) }, programArmed: raw?.programArmed === true, disarmed: raw?.programArmed === true ? parseDisarmed(raw?.disarmed) : { main: false, backup: false },
    backupPullUrl: typeof raw?.backupPullUrl === "string" && validPullUrl(raw.backupPullUrl) ? raw.backupPullUrl : "",
    failover: parseFailover(raw?.failover),
    lanIngest: raw?.lanIngest === true,
    mdnsName: cleanMdnsName(raw?.mdnsName) ?? DEFAULT_MDNS_NAME,
    srtBackup: raw?.srtBackup === true,
    webrtcPreview: raw?.webrtcPreview !== false,
    srtPassphrase: typeof raw?.srtPassphrase === "string" && srtPassphraseError(raw.srtPassphrase) === null ? raw.srtPassphrase : "",
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
 * may publish to /program only. Arming changes only the logins (and the Backup pull path): see below.
 */
export function buildMediamtxConfig(input: { host: string; ports: { rtmp: number; hls: number; api: number }; creds: Credentials; programArmed?: boolean; /** per-feed disarm while armed */ disarmed?: FeedDisarmed; backupPullUrl?: string; /** RTMP ingest host when LAN ingest is on (else `host`) */ ingestHost?: string; /** SRT for the Backup publisher (bound like RTMP ingest) */ srt?: { port: number; passphrase: string }; /** WHEP read-only previews */ webrtc?: { httpPort: number; iceHost: string; icePort: number; additionalHosts: string[] } }): string {
  const { host, ports, creds } = input
  // LAN ingest: only the RTMP listener moves; HLS and the API stay on `host`. Only the program/backup
  // publish logins may connect from other addresses, and only to publish their own path. Reads,
  // the API and the internal slate/capture publishers stay loopback-only.
  //
  // Arm/disarm must only touch /program and /program-backup. MediaMTX (v1.21.2 core.closeResources)
  // hot-reloads authInternalUsers (ReloadInternalUsers) and per-path confs (only changed paths are
  // recreated), but a change to rtmpAddress / srt / srtAddress restarts that whole listener and
  // terminates EVERY connection on it (/capture, /vertical, all readers and forwards). So the listener
  // lines depend only on the LAN-ingest / SRT settings, never on `programArmed`; arming only adds the
  // OBS logins (and the Backup pull source). Disarmed + LAN: the listener stays on the LAN address but
  // no login may connect from there (internal logins are loopback-only).
  const lan = Boolean(input.ingestHost && input.ingestHost !== host)
  const obsIps = lan ? "['0.0.0.0/0', '::/0']" : null
  const program = input.programArmed && !input.disarmed?.main && creds.programUser && creds.programPass
  const pullUrl = input.backupPullUrl && validPullUrl(input.backupPullUrl) ? input.backupPullUrl : ""
  const backupOn = input.programArmed && !input.disarmed?.backup
  const pull = backupOn ? pullUrl : ""
  const backup = backupOn && !pull && creds.backupUser && creds.backupPass
  const local = "['127.0.0.1/32', '::1/128']"
  // SRT (Backup publisher) whenever it is turned on and the Backup isn't pulled, armed or not (see above).
  const srt = !pullUrl && input.srt ? input.srt : null
  return [
    "# Generated by stream-timer (lib/relay.ts) on every relay start. Do not edit; do not commit.",
    "logLevel: info",
    "logDestinations: [stdout]",
    "readTimeout: 10s",
    "writeTimeout: 10s",
    "rtsp: no",
    `rtspAddress: ${host}:${ports.rtmp + 1}`,
    ...(srt ? ["srt: yes", `srtAddress: ${lan ? input.ingestHost : host}:${srt.port}`] : ["srt: no"]),
    // WebRTC: reads only. Signalling on 127.0.0.1 (the app proxies it behind operator auth); no
    // publisher login can reach it (OBS logins are RTMP/SRT; internal publishers are local RTMP).
    ...(input.webrtc ? [
      "webrtc: yes",
      `webrtcAddress: ${host}:${input.webrtc.httpPort}`,
      "webrtcEncryption: no",
      "webrtcAllowOrigins: ['*']",
      `webrtcLocalUDPAddress: ${input.webrtc.iceHost}:${input.webrtc.icePort}`,
      `webrtcLocalTCPAddress: ${input.webrtc.iceHost}:${input.webrtc.icePort}`,
      "webrtcIPsFromInterfaces: yes",
      `webrtcAdditionalHosts: [${input.webrtc.additionalHosts.map((h) => JSON.stringify(h)).join(", ")}]`,
      "webrtcICEServers2: []",
      // Keep WebRTC packets under typical Wi-Fi/VPN MTUs (no IP fragmentation, which drops whole frames).
      "udpMaxPayloadSize: 1200",
    ] : ["webrtc: no"]),
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
    pull ? `  ${BACKUP_PATH}: { source: ${JSON.stringify(pull)}, sourceOnDemand: no }` : `  ${BACKUP_PATH}: { overridePublisher: yes${srt?.passphrase ? `, srtPublishPassphrase: ${JSON.stringify(srt.passphrase)}` : ""} }`,
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
type LoopState = { state: "running" | "waiting"; restarts: number; reconnects?: number; updatedAt: number; lastExit: number | null; nextDelay?: number | null }

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
      // After 4 quick failures in a row (ingest rejecting the key), back off up to 30s instead of every 5s.
      ...(opts.forward ? { LOOP_SLOW_AFTER: "4", LOOP_SLOW_MAX: "30", LOOP_MAX_DELAY: "5", LOOP_WATCH_LOG: log, LOOP_STALL_SECS: "25", LOOP_STALL_GRACE: "30" } : {}),
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

/** Read-only: every relay path as MediaMTX reports it (null = API down). For the dropout log. */
export function relayPathsSnapshot(): Promise<Map<string, { ready: boolean; bytesReceived: number; readers: number; source: string | null }> | null> {
  return apiPaths().then((m) => m && new Map([...m].map(([k, v]) => [k, { ready: v.ready, bytesReceived: v.bytesReceived, readers: v.readers?.length ?? 0, source: v.source?.type ?? null }])))
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
    noteRelayDisruption()
    writeConfigIfChanged()
    spawnLoop("mediamtx", "mediamtx", [bin, file("mediamtx.yml")])
  } else writeConfigIfChanged() // MediaMTX reloads its config file on change; channels keep running
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && !(await apiPaths())) await new Promise((resolve) => setTimeout(resolve, 150))
  if (!(await apiPaths())) return { ok: false, status: 500, error: `MediaMTX did not come up. Ports in use? ${tailOf("mediamtx").split("\n").slice(-3).join(" · ")}` }
  return { ok: true }
}

function desiredConfig() {
  return buildMediamtxConfig({ host: bindHost(), ports: relayPorts(), creds: credentials(), programArmed: readSettings().programArmed, disarmed: readSettings().disarmed, backupPullUrl: readSettings().backupPullUrl, ingestHost: readSettings().lanIngest ? ingestHost() : undefined, srt: readSettings().srtBackup ? { port: srtPort(), passphrase: readSettings().srtPassphrase } : undefined, webrtc: webrtcConfig() })
}
function webrtcConfig() {
  if (!readSettings().webrtcPreview) return undefined
  const iceHost = webrtcIceHost()
  const lan = iceHost === "127.0.0.1" ? null : lanIp()
  return { httpPort: webrtcPorts().http, iceHost, icePort: webrtcPorts().ice, additionalHosts: lan ? [lan] : [] }
}
export function relayWebrtcOrigin(): { origin: string; authorization: string } | null {
  return readSettings().webrtcPreview && relayRunning() ? { origin: `http://127.0.0.1:${webrtcPorts().http}`, authorization: basicAuth() } : null
}
export function setWebrtcPreview(on: boolean): Promise<RelayResult> {
  return withLock(async () => {
    writeSettings({ ...readSettings(), webrtcPreview: on })
    if (relayRunning()) writeConfigIfChanged()
    return { ok: true, note: on ? "Fast previews (WebRTC) on." : "Previews use HLS (~3s)." }
  })
}
function writeConfigIfChanged() {
  const yml = desiredConfig()
  let current = ""
  try { current = fs.readFileSync(file("mediamtx.yml"), "utf8") } catch { /* first start */ }
  if (current.replace(/# resync .*\n$/, "") !== yml) { noteRelayDisruption(); writePrivate(file("mediamtx.yml"), yml) }
}

/**
 * Read-only: remote host of each program input's publisher (RTMP push: rtmpconns remoteAddr; Backup pull:
 * the pull URL's host). null = no publisher / relay down. Used for per-source RTT, never changes anything.
 */
export type PublisherHost = { host: string; via: "push" | "pull"; protocol?: "rtmp" | "srt" | null; srt?: SrtLink | null }
export async function programPublisherHosts(): Promise<Record<"main" | "backup", PublisherHost | null>> {
  const out: Record<"main" | "backup", PublisherHost | null> = { main: null, backup: null }
  for (const conn of (await listPublishers()) ?? []) {
    if (!conn.host) continue
    const v: PublisherHost = { host: conn.host, via: "push", protocol: conn.protocol, srt: conn.srt }
    if (conn.path === PROGRAM_PATH) out.main = v
    if (conn.path === BACKUP_PATH) out.backup = v
  }
  const pull = readSettings().backupPullUrl
  if (!out.backup && pull) {
    try { out.backup = { host: new URL(pull).hostname, via: "pull" } } catch { /* bad url */ }
  }
  return out
}

export type Publisher = { id: string; path: string; protocol: "rtmp" | "srt"; host: string | null; srt: SrtLink | null }
/** Pure: publishers from a MediaMTX /v3/rtmpconns/list or /v3/srtconns/list body. */
export function parseConns(body: unknown, protocol: "rtmp" | "srt"): Publisher[] {
  const items = (body as { items?: unknown[] } | null)?.items
  if (!Array.isArray(items)) return []
  const out: Publisher[] = []
  for (const raw of items) {
    const c = raw as Record<string, unknown>
    if (c.state !== "publish" || typeof c.id !== "string" || typeof c.path !== "string") continue
    const host = typeof c.remoteAddr === "string" ? c.remoteAddr.replace(/^\[?([^\]]+?)\]?:\d+$/, "$1") : null
    let srt: SrtLink | null = null
    if (protocol === "srt") {
      const n = (k: string) => (typeof c[k] === "number" && Number.isFinite(c[k]) ? (c[k] as number) : null)
      const got = n("packetsReceived") ?? 0
      const lost = n("packetsReceivedLoss") ?? 0
      srt = { rttMs: n("msRTT") === null ? null : Math.round((n("msRTT") as number) * 10) / 10, lost, retrans: n("packetsReceivedRetrans") ?? 0, lossPct: got + lost > 0 ? Math.round((lost / (got + lost)) * 1000) / 10 : 0, mbps: n("mbpsReceiveRate") }
    }
    out.push({ id: c.id, path: c.path, protocol, host, srt })
  }
  return out
}
/** Every publisher on the relay, RTMP and SRT (an SRT list error, e.g. SRT off, just means none). */
async function listPublishers(): Promise<Publisher[] | null> {
  const api = `http://127.0.0.1:${relayPorts().api}/v3`
  const get = async (protocol: "rtmp" | "srt") => {
    const response = await fetch(`${api}/${protocol}conns/list`, { headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(1500), cache: "no-store" })
    if (!response.ok) throw new Error(String(response.status))
    return parseConns(await response.json(), protocol)
  }
  try {
    const rtmp = await get("rtmp")
    const srt = readSettings().srtBackup ? await get("srt").catch(() => []) : []
    return [...rtmp, ...srt]
  } catch { return null }
}
/** Pure: which conns to kick for these paths, as API paths. */
export function kickTargets(pubs: Publisher[], paths: string[]): string[] {
  return pubs.filter((p) => paths.includes(p.path)).map((p) => `${p.protocol}conns/kick/${encodeURIComponent(p.id)}`)
}

/** Disconnect whoever publishes /program (disarm / new key), over RTMP or SRT. */
async function kickProgramUnlocked(paths: string[] = [PROGRAM_PATH, BACKUP_PATH]) {
  if (!relayRunning()) return
  const api = `http://127.0.0.1:${relayPorts().api}/v3`
  for (const target of kickTargets((await listPublishers()) ?? [], paths)) {
    try { await fetch(`${api}/${target}`, { method: "POST", headers: { Authorization: basicAuth() }, signal: AbortSignal.timeout(1500) }) } catch { /* gone already */ }
  }
}

const scopePaths = (scope: ArmScope) => (scope === "main" ? [PROGRAM_PATH] : scope === "backup" ? [BACKUP_PATH] : [PROGRAM_PATH, BACKUP_PATH])
const scopeLabel = (scope: ArmScope) => (scope === "both" ? "Main + Backup" : FEED_LABEL[scope])

/** Arm receive (both, or one feed): MediaMTX up (independent of forwards and channels) and OBS may publish. */
export function armProgram(scope: ArmScope = "both"): Promise<RelayResult> {
  return withLock(async () => {
    noteRelayDisruption() // OBS (re)connecting after an arm isn't a Wi-Fi drop
    const cur = readSettings()
    const next = nextArmState(cur, "arm", scope)
    dlog("·", "rearm", `${scopeLabel(scope)} ARMED (OBS may publish to ${scopePaths(scope).map((p) => `/${p}`).join(" and ")})`)
    writeSettings({ ...cur, ...next })
    const up = await ensureServerUnlocked()
    if (!up.ok) return up
    if (relayRunning()) writeConfigIfChanged()
    return { ok: true, note: `${scopeLabel(scope)} armed: waiting for OBS.` }
  })
}

/**
 * Disarm (both, or one feed): that OBS login removed and its publisher kicked; the other feed keeps
 * publishing. `hold`: players keep the last frame for 15s (on-air feed dropped on purpose). The server
 * stops only when everything is disarmed and nothing else uses it. Hand-over is the caller's job.
 */
export function disarmProgram(scope: ArmScope = "both", opts: { hold?: boolean } = {}): Promise<RelayResult> {
  return withLock(async () => {
    noteRelayDisruption()
    if (opts.hold ?? true) noteProgramDisarm() // players hold the last frame (no "Waiting for OBS") while OBS reconnects
    const cur = readSettings()
    const next = nextArmState(cur, "disarm", scope)
    dlog("!", "rearm", `${scopeLabel(scope)} DISARMED: OBS login removed and publisher kicked (${scope === "both" ? "Main and Backup drop" : `${FEED_LABEL[scope]} drops; the other feed stays`})`)
    writeSettings({ ...cur, ...next })
    if (relayRunning()) writeConfigIfChanged()
    await kickProgramUnlocked(scopePaths(scope))
    const stopped = next.programArmed ? false : await stopServerIfIdleUnlocked()
    if (scope !== "backup") programCache.ready = false
    sourceCache.at = 0
    return { ok: true, note: stopped ? "Disarmed; relay server stopped (nothing else uses it)." : `${scopeLabel(scope)} disarmed.` }
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
/** Pure: the SRT URL OBS 2 pastes as Server (Stream Key blank). latency is µs. */
export function srtObsUrl(input: { host: string; port: number; user: string; pass: string; passphrase: string; latencyUs?: number }): string {
  const sid = `publish:${BACKUP_PATH}:${input.user}:${input.pass}`
  return `srt://${input.host}:${input.port}?streamid=${sid}&latency=${input.latencyUs ?? SRT_LATENCY_US}&pkt_size=1316${input.passphrase ? `&passphrase=${input.passphrase}` : ""}`
}
/** SRT settings for OBS 2 (operator-only reveal). url null = SRT off; lan false = only reachable from this machine. */
export function backupSrtUrl(): { url: string | null; lan: boolean; port: number; note: string } {
  const s = readSettings()
  const c = credentials()
  if (!s.srtBackup) return { url: null, lan: false, port: srtPort(), note: "SRT for Backup is off." }
  if (s.backupPullUrl) return { url: null, lan: false, port: srtPort(), note: "Backup pulls from a URL; SRT publish is off while pulling." }
  const lanHost = s.lanIngest ? lanIp() : null
  const url = srtObsUrl({ host: lanHost ?? "127.0.0.1", port: srtPort(), user: c.backupUser ?? "", pass: c.backupPass ?? "", passphrase: s.srtPassphrase })
  return { url, lan: Boolean(lanHost), port: srtPort(), note: lanHost ? "OBS 2: Settings › Stream › Custom, paste as Server, leave Stream Key blank." : "Turn on LAN ingest so OBS 2 on another machine can reach SRT (this URL only works on this Mac)." }
}
export function setSrtBackup(raw: { on?: unknown; passphrase?: unknown }): Promise<RelayResult> {
  return withLock(async () => {
    const cur = readSettings()
    const passphrase = typeof raw.passphrase === "string" ? raw.passphrase.trim() : cur.srtPassphrase
    const why = srtPassphraseError(passphrase)
    if (why) return { ok: false, status: 400, error: why }
    const on = typeof raw.on === "boolean" ? raw.on : cur.srtBackup
    writeSettings({ ...cur, srtBackup: on, srtPassphrase: passphrase })
    if (relayRunning()) writeConfigIfChanged()
    return { ok: true, note: on ? `Backup also accepts SRT on UDP ${srtPort()}${passphrase ? " (encrypted)" : ""}.` : "SRT for Backup is off." }
  })
}

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

export type ProgramStatus = { armed: boolean; /** per-feed OBS login on */ feeds: { main: boolean; backup: boolean }; ready: boolean; tracks: string[]; kbps: number | null; fps: number | null; video: string | null; audio: string | null; /** What MediaMTX says OBS sends as audio (null = no audio track). */ audioTrack: { codec: string; channels: number | null; sampleRate: number | null } | null; readers: number; since: string | null }

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
  // "Stop forwards" is the HD fan-out switch: the Vertical encoder and its /vertical forwards have their own.
  for (const loop of findRelayLoops()) if (loop.tag !== "mediamtx" && !isVerticalTag(loop.tag) && !loop.tag.startsWith(`forward:${VERTICAL_PATH}:`)) await killGroup(loop.pid)
  for (const name of fs.existsSync(relayDir()) ? fs.readdirSync(relayDir()) : []) {
    if (/^fwd-.*\.json$/.test(name) && !name.startsWith(`fwd-${VERTICAL_PATH}-`)) fs.rmSync(file(name), { force: true })
  }
}
const publishingChannels = () => [...directChannelDests().filter((item) => item.running && item.relay), ...(verticalPublishing() ? [{ channel: VERTICAL_PATH, running: true, relay: true }] : [])]
/** The Vertical output's loop is alive (its pidfile names a running relay-loop.sh). Read here, not via lib/vertical (that imports this module). */
const allDirectDests = () => directChannelDests()
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
  const out: { path: RelayPath; dest: string; destId: string }[] = []
  // HD paths count while forwards are on; /vertical forwards whenever ticked (they follow the Vertical encoder).
  for (const name of settings.enabled ? RELAY_PATHS : [VERTICAL_PATH] as const) {
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
  // HD paths: while "Start forwards" is on. /vertical: whenever ticked AND the Vertical encoder runs
  // (its own switch), so ticks apply live and a stopped Vertical leaves them "waiting", not retrying.
  const pathOn = (name: RelayPath) => relayRunning() && (name === VERTICAL_PATH ? verticalPublishing() : settings.enabled)
  const wanted = new Map<string, { name: RelayPath; destId: string; url: string; tag: string }>()
  {
    for (const name of RELAY_PATHS.filter(pathOn)) {
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
/** Ticked /vertical forwards (migration from the old direct "vertical destinations"); no process change here. */
export function addVerticalForwards(ids: string[]) {
  if (!ids.length) return
  const settings = readSettings()
  writeSettings({ ...settings, forwards: { ...settings.forwards, vertical: [...new Set([...settings.forwards.vertical, ...ids])] } })
}

export async function reconcileRelay(force = false) {
  if (!force && Date.now() - reconcileAt < 2000) return
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

/**
 * Pure: an operator hint for a forward's last ffmpeg error line. "End of file" while opening the output
 * means the ingest accepted TCP and then hung up: almost always a wrong/expired stream key, a wrong app
 * path, or rtmp:// where the platform wants rtmps://.
 */
export function friendlyForwardError(line: string, url?: string): string {
  const scheme = url?.startsWith("rtmps:") ? "rtmps" : url?.startsWith("rtmp:") ? "rtmp" : null
  if (/End of file/i.test(line)) return `Platform closed the connection — check the stream URL/key (TikTok/Instagram keys expire each session; get a fresh one)${scheme === "rtmp" ? ". If the platform gives an rtmps:// URL, use that" : ""}.`
  if (/Connection refused/i.test(line)) return "Connection refused — wrong server/port, or the ingest is down."
  if (/(Connection timed out|Operation timed out|timed out)/i.test(line)) return "Timed out reaching the ingest — check the server address and your network."
  if (/(Failed to resolve|Name or service not known|nodename nor servname)/i.test(line)) return "Can't resolve the server name — check the URL."
  if (/(403|Forbidden|denied|Unauthorized|401)/i.test(line)) return "The platform refused the stream key (not authorised)."
  if (/(Broken pipe|Connection reset)/i.test(line)) return "The platform dropped the connection — reconnecting."
  return line.slice(0, 200)
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
export type RelayForwardStatus = { /** the ffmpeg line behind `error` */ rawError?: string | null; destId: string; name: string; host: string; state: ForwardState; restarts: number; reconnects: number; error: string | null; adopted: boolean; health: HealthStats }
export type RelayPathStatus = { /** per saved destination: why it can't be ticked on this path (null = fine) */ available: { destId: string; reason: string | null }[]; name: RelayPath; ready: boolean; publisher: string | null; tracks: string[]; readers: number; bytesReceived: number; forwards: RelayForwardStatus[]; source: SourceHealth | HealthStats | null; outKbps: number; diagnosis: { level: Level; text: string } }
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

export type BackupStatus = { srt: { on: boolean; passphraseSet: boolean; port: number }; lanIngest: boolean; ready: boolean; kbps: number | null; dataAgeMs: number | null; /** pull source: scheme://host only (no path/keys) */ pullFrom: string | null; failover: FailoverSettings; audioTrack: ProgramStatus["audioTrack"] }
export type RelayStatus = { webrtc: { on: boolean; icePort: number; iceHost: string }; ingest: IngestDiag; backup: BackupStatus; program: ProgramStatus; totalOutKbps: number; installed: boolean; bin: string | null; version: string | null; /** forwards on */ enabled: boolean; publishing: RelayPath[]; running: boolean; apiUp: boolean; adopted: boolean; restarts: number; error: string | null; paths: Record<RelayPath, RelayPathStatus> }

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
      if (name === VERTICAL_PATH && !meta && !blocked) {
        // Not running because nothing publishes /vertical: say so (it starts by itself once Vertical runs).
        const why = !verticalPublishing() ? "Waiting for /vertical (start Vertical 9:16)." : !relayRunning() ? "Relay server is starting…" : "Starting…"
        return { destId, name: dest.name, host: dest.host, state: "waiting", restarts: loop?.restarts ?? 0, reconnects: loop?.reconnects ?? 0, error: why, adopted: false, health: EMPTY_HEALTH }
      }
      if (name === VERTICAL_PATH && meta && info?.ready !== true) {
        return { destId, name: dest.name, host: dest.host, state: "waiting", restarts: loop?.restarts ?? 0, reconnects: loop?.reconnects ?? 0, error: "Waiting for /vertical to publish (Vertical starting, or Browser capture not on the relay).", adopted: meta.adopted === true, health: EMPTY_HEALTH }
      }
      if (blocked && (settings.enabled || name === VERTICAL_PATH)) return { destId, name: dest.name, host: dest.host, state: "blocked", restarts: 0, reconnects: 0, error: blocked, adopted: false, health: EMPTY_HEALTH }
      const health = meta && info?.ready ? healthFromSamples(parseProgressBlocks(tailOf(key, 32768)).slice(-13), 5, logAgeMs(key), expect) : EMPTY_HEALTH
      return { destId, name: dest.name, host: dest.host, state, restarts: loop?.restarts ?? 0, reconnects: loop?.reconnects ?? 0, error: state === "forwarding" || state === "off" || !errorLine ? null : `${friendlyForwardError(errorLine, resolved?.url)}${state === "retrying" && loop?.nextDelay ? ` Next try in ${loop.nextDelay}s.` : ""}`, rawError: errorLine?.slice(0, 200) ?? null, adopted: meta?.adopted === true, health }
    })
    const outKbps = forwards.reduce((sum, item) => sum + (item.health.kbps ?? 0), 0)
    const diagnosis = diagnose({ source: source ? { label: name === "slate" ? "Slate" : name === "capture" ? "Browser capture" : "Vertical", health: source } : null, forwards: forwards.map((item) => ({ name: item.name, health: item.health })), totalKbps: outKbps || null, needKbps: expect.kbps ? expect.kbps * forwards.filter((item) => item.state !== "off" && item.state !== "blocked").length : null })
    const allFwd = RELAY_PATHS.flatMap((p) => settings.forwards[p].map((id) => { const d = resolveDestination(id); return { path: p, dest: d ? destinationFingerprint(d.url) : "" } }))
    const direct = allDirectDests()
    const available = [...dests.values()].map((d) => { const r = resolveDestination(d.id); return { destId: d.id, reason: r ? forwardConflict({ path: name, dest: destinationFingerprint(r.url) }, allFwd, direct) : "Missing." } })
    paths[name] = { available, name, ready: info?.ready === true, publisher: info?.source?.type ?? null, tracks: info?.tracks ?? [], readers: info?.readers.length ?? 0, bytesReceived: info?.bytesReceived ?? 0, forwards, source, outKbps, diagnosis }
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
    armed: settings.programArmed, feeds: { main: settings.programArmed && !settings.disarmed.main, backup: settings.programArmed && !settings.disarmed.backup }, ready: prog?.ready === true, tracks: prog?.tracks ?? [],
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
  const webrtcPreview = settings.webrtcPreview
  const backup: BackupStatus = { srt: { on: settings.srtBackup, passphraseSet: settings.srtPassphrase !== "", port: srtPort() }, lanIngest: settings.lanIngest, ...programSourceHealth("backup"), pullFrom, failover: settings.failover, audioTrack: bk?.ready ? programAudioTrack(bk) : null }
  const parsedLog = parseIngestLog(mtx ? tailOf("mediamtx", 65536) : "")
  // Live bind from MediaMTX itself (the startup log line scrolls out of the tail on a busy relay).
  const live = api ? await liveGlobalConfig() : null
  const ingest: IngestDiag = { resyncs: mediamtxConfigResyncs(), listen: (live?.rtmpAddress !== "?" ? live?.rtmpAddress : undefined) ?? (api ? parsedLog.listen : null), lan: settings.lanIngest, lanUrl: lanServerUrl(), mdnsUrl: mdnsServerUrl(), mdns: mdnsStatus(), lastReject: parsedLog.lastReject, logFile: file("mediamtx.log") }
  return {
    webrtc: { on: webrtcPreview, icePort: webrtcPorts().ice, iceHost: webrtcIceHost() },
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


/** Check destinations with timers and activate their forwards when the time arrives. */
let timerInterval: ReturnType<typeof setInterval> | null = null
export function startDestinationTimers() {
  if (timerInterval) return
  timerInterval = setInterval(() => void checkDestinationTimers(), 15_000)
  void checkDestinationTimers()
}
async function checkDestinationTimers() {
  const now = Date.now()
  const { items } = listDestinations()
  const settings = readSettings()
  for (const dest of items) {
    if (!dest.activateAt || dest.activateAt > now) continue
    // Find which path this destination is assigned to
    let path: RelayPath | null = null
    for (const p of RELAY_PATHS) {
      if (settings.forwards[p].includes(dest.id)) { path = p; break }
    }
    if (!path) continue // not assigned to a path yet
    try {
      await setForward(path, dest.id, true)
      setDestinationTimer(dest.id, null)
      dlog("relay", `timer fired: ${dest.name} on /${path}`)
    } catch { /* next tick */ }
  }
}
