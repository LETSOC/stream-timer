import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { notePlannedBack } from "@/lib/program-rearm"
import { disarmFeed } from "@/lib/program-monitor"
import type { ArmScope } from "@/lib/program-arm"
import { setWebrtcPreview, armProgram, backupObsUrl, backupSrtUrl, setSrtBackup, programObsUrl, setBackupPull, setFailover, setLanIngest, setMdnsName, setSrtMain, RELAY_PATHS, relayStatus, rotateProgramCredentials, setForward, startRelay, stopRelay, type RelayPath } from "@/lib/relay"
import { programSrtUrl, srsOptionUrls } from "@/lib/srt-urls"

const NO_STORE = { "Cache-Control": "no-store" }
const scopeOf = (v: unknown): ArmScope => (v === "main" || v === "backup" ? v : "both")

/** Operator only. Relay state, per-path publisher and per-forward status. Never a URL or key. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  return Response.json(await relayStatus(), { headers: NO_STORE })
}

/** Operator + same-origin. { action: "start" | "stop" } (forwards on/off) or { action: "forward", path, destinationId, on } */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request) ?? requireOperator(request)
  if (denied) return denied
  const body = (await request.json().catch(() => null)) as { action?: unknown; path?: unknown; destinationId?: unknown; on?: unknown; url?: unknown; failover?: unknown; name?: unknown; passphrase?: unknown; feed?: unknown } | null
  const reply = async (result: { ok: true; note?: string } | { ok: false; error: string; status: number }) =>
    result.ok ? Response.json({ ...(await relayStatus()), note: result.note ?? null }, { headers: NO_STORE }) : Response.json({ ...(await relayStatus()), error: result.error }, { status: result.status, headers: NO_STORE })
  switch (body?.action) {
    case "start":
      return reply(await startRelay())
    case "stop":
      // Forwards off only. Channels keep publishing into the relay; the preview keeps working.
      return reply(await stopRelay())
    case "forward": {
      if (!RELAY_PATHS.includes(body.path as RelayPath) || typeof body.destinationId !== "string") return Response.json({ error: "Expected { path: slate|capture, destinationId, on }." }, { status: 400 })
      return reply(await setForward(body.path as RelayPath, body.destinationId, body.on === true))
    }
    case "arm-program": {
      const feed = scopeOf(body.feed)
      notePlannedBack(feed) // manual Arm: no auto re-arm of that feed right after
      return reply(await armProgram(feed))
    }
    case "disarm-program":
      return reply(await disarmFeed(scopeOf(body.feed)))
    case "rotate-backup":
      return reply(await rotateProgramCredentials("backup"))
    case "rotate-program":
      return reply(await rotateProgramCredentials())
    case "reveal-program":
      // OBS settings, on demand only (POST + operator + same-origin). Never part of GET status.
      return Response.json(programObsUrl(), { headers: NO_STORE })
    case "reveal-program-srt":
      return Response.json(programSrtUrl(), { headers: NO_STORE })
    case "reveal-backup-srt":
      return Response.json(backupSrtUrl(), { headers: NO_STORE })
    case "reveal-srs":
      return Response.json(srsOptionUrls(), { headers: NO_STORE })
    case "webrtc-preview":
      return reply(await setWebrtcPreview(body.on === true))
    case "srt-backup":
      return reply(await setSrtBackup({ on: body.on, passphrase: body.passphrase }))
    case "srt-main":
      return reply(await setSrtMain({ on: body.on, passphrase: body.passphrase }))
    case "reveal-backup":
      return Response.json(backupObsUrl(), { headers: NO_STORE })
    case "backup-pull":
      if (typeof body.url !== "string") return Response.json({ error: "Expected { url }." }, { status: 400 })
      return reply(await setBackupPull(body.url))
    case "mdns-name":
      return reply(await setMdnsName(body.name))
    case "lan-ingest":
      return reply(await setLanIngest(body.on === true))
    case "failover":
      return reply(await setFailover(body.failover))
    default:
      return Response.json({ error: "Expected { action: start | stop | forward | arm-program | disarm-program | reveal-program | reveal-program-srt | rotate-program | reveal-backup | reveal-backup-srt | reveal-srs | srt-backup | srt-main | backup-pull | failover | lan-ingest | mdns-name }." }, { status: 400 })
  }
}
