/**
 * SRT URL builders for the desk.
 *
 * MediaMTX SRT (port 8890, when srtBackup is on):
 *   Main:   srt://<host>:8890?streamid=publish:program:<user>:<pass>&latency=300000&pkt_size=1316
 *   Backup: srt://<host>:8890?streamid=publish:program-backup:<user>:<pass>&latency=300000&pkt_size=1316
 *
 * SRS (parallel, docker, ports 19360 RTMP / 10080 SRT — not controlled by the app):
 *   RTMP: rtmp://<host>:19360/live  key backup2
 *   SRT:  srt://<host>:10080?streamid=#!::r=live/backup2,m=publish&latency=300000
 */
import { lanIp } from "@/lib/relay"
import { SRT_LATENCY_US, srtPort } from "@/lib/relay"

export type SrtReveal = { url: string | null; lan: boolean; port: number; note: string }

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
  const lat = input.latencyUs ?? SRT_LATENCY_US
  const pp = input.passphrase ? `&passphrase=${input.passphrase}` : ""
  return `srt://${input.host}:${input.port}?streamid=${sid}&latency=${lat}&pkt_size=1316${pp}`
}

/** Build an SRS-style SRT publish URL (streamid format differs). */
export function buildSrsSrtUrl(host: string, key = "backup2", port = 10080, latencyUs = SRT_LATENCY_US): string {
  return `srt://${host}:${port}?streamid=#!::r=live/${key},m=publish&latency=${latencyUs}`
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
