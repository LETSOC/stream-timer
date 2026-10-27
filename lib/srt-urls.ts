/**
 * SRT URL builders for the desk.
 *
 * MediaMTX SRT (one UDP port, 8890 or SRT_PORT; Main and Backup each have their own toggle):
 *   Main:   srt://<host>:8890?streamid=publish:program:<user>:<pass>&latency=300000&pkt_size=1316
 *   Backup: srt://<host>:8890?streamid=publish:program-backup:<user>:<pass>&latency=300000&pkt_size=1316
 * latency is µs: SRT_LATENCY_MS (default 300) × 1000.
 *
 * SRS (parallel, docker, ports 19360 RTMP / 10080 SRT — not controlled by the app):
 *   RTMP: rtmp://<host>:19360/live  key backup2
 *   SRT:  srt://<host>:10080?streamid=#!::r=live/backup2,m=publish&latency=300000
 */
import { credentials, lanIp, PROGRAM_PATH, readSettings, srtLatencyMs, srtLatencyUs, srtObsUrl, srtPort } from "@/lib/relay"

export type SrtReveal = { url: string | null; lan: boolean; port: number; latencyMs: number; note: string }

/** Build a MediaMTX-style SRT publish URL. */
export function buildMediamtxSrtUrl(input: {
  host: string
  port: number
  path: string
  user: string
  pass: string
  latencyUs?: number
  passphrase?: string
}): string {
  const sid = `publish:${input.path}:${input.user}:${input.pass}`
  const lat = input.latencyUs ?? srtLatencyUs()
  const pp = input.passphrase ? `&passphrase=${input.passphrase}` : ""
  return `srt://${input.host}:${input.port}?streamid=${sid}&latency=${lat}&pkt_size=1316${pp}`
}

/** Build an SRS-style SRT publish URL (streamid format differs). */
export function buildSrsSrtUrl(host: string, key = "backup2", port = 10080, latencyUs = srtLatencyUs()): string {
  return `srt://${host}:${port}?streamid=#!::r=live/${key},m=publish&latency=${latencyUs}`
}

/**
 * Pure: Main SRT reveal from settings + credentials. Main has its own toggle and passphrase; the
 * listener (UDP port) is shared with Backup SRT. Host: the LAN/public IP while LAN ingest is on.
 */
export function mainSrtReveal(input: { srtMain: boolean; passphrase: string; lanIngest: boolean; lanHost: string | null; user?: string; pass?: string; port: number; latencyMs: number }): SrtReveal {
  const { port, latencyMs } = input
  if (!input.srtMain) return { url: null, lan: false, port, latencyMs, note: "SRT for Main is off. Tick ‘Also accept Main over SRT’ first." }
  const host = input.lanIngest ? (input.lanHost ?? "127.0.0.1") : "127.0.0.1"
  const lan = host !== "127.0.0.1"
  if (!input.user || !input.pass) return { url: null, lan, port, latencyMs, note: "No Main credentials yet. Arm the program feed first." }
  const url = srtObsUrl({ host, port, path: PROGRAM_PATH, user: input.user, pass: input.pass, passphrase: input.passphrase, latencyUs: latencyMs * 1000 })
  return { url, lan, port, latencyMs, note: lan ? "OBS / encoder: Settings › Stream › Custom, paste as Server, leave Stream Key blank." : "Main SRT (this machine only). Turn on LAN ingest so an encoder on another machine can reach SRT." }
}

/** Main SRT URL for OBS / an SRT encoder (operator-only reveal; never in status or logs). */
export function programSrtUrl(): SrtReveal {
  const s = readSettings()
  const c = credentials()
  return mainSrtReveal({ srtMain: s.srtMain, passphrase: s.srtMainPassphrase, lanIngest: s.lanIngest, lanHost: s.lanIngest ? lanIp() : null, user: c.programUser, pass: c.programPass, port: srtPort(), latencyMs: srtLatencyMs() })
}

/** SRS option URLs (parallel ingest, not MediaMTX). Returns null host if LAN IP unknown. */
export function srsOptionUrls(key = "backup2"): {
  host: string | null
  rtmpServer: string | null
  rtmpKey: string
  srtUrl: string | null
  flv: string | null
  note: string
} {
  const host = lanIp()
  if (!host) return { host: null, rtmpServer: null, rtmpKey: key, srtUrl: null, flv: null, note: "No LAN IP detected. Start SRS separately (docker) and use the Mac's IP." }
  return {
    host,
    rtmpServer: `rtmp://${host}:19360/live`,
    rtmpKey: key,
    srtUrl: buildSrsSrtUrl(host, key),
    flv: `http://${host}:8088/live/${key}.flv`,
    note: "SRS runs separately (docker). These URLs do not go through MediaMTX.",
  }
}
