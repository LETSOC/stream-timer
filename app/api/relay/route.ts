import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { readStatus, stopRtmpStream } from "@/lib/encoder"
import { RELAY_PATHS, relayStatus, setForward, startRelay, stopRelay, type RelayPath } from "@/lib/relay"

const NO_STORE = { "Cache-Control": "no-store" }

/** Operator only. Relay state, per-path publisher and per-forward status. Never a URL or key. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  return Response.json(await relayStatus(), { headers: NO_STORE })
}

/** Operator + same-origin. { action: "start" | "stop" } or { action: "forward", path, destinationId, on } */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request) ?? requireOperator(request)
  if (denied) return denied
  const body = (await request.json().catch(() => null)) as { action?: unknown; path?: unknown; destinationId?: unknown; on?: unknown } | null
  const reply = async (result: { ok: true; note?: string } | { ok: false; error: string; status: number }) =>
    result.ok ? Response.json({ ...(await relayStatus()), note: result.note ?? null }, { headers: NO_STORE }) : Response.json({ ...(await relayStatus()), error: result.error }, { status: result.status, headers: NO_STORE })
  switch (body?.action) {
    case "start":
      return reply(await startRelay())
    case "stop": {
      // Channels publishing into the relay have nowhere to go once it stops: stop them first.
      const channels = readStatus().rtmpChannels
      for (const ch of RELAY_PATHS) if (channels[ch].running && channels[ch].relay) await stopRtmpStream(Date.now(), ch)
      return reply(await stopRelay())
    }
    case "forward": {
      if (!RELAY_PATHS.includes(body.path as RelayPath) || typeof body.destinationId !== "string") return Response.json({ error: "Expected { path: slate|capture, destinationId, on }." }, { status: 400 })
      return reply(await setForward(body.path as RelayPath, body.destinationId, body.on === true))
    }
    default:
      return Response.json({ error: "Expected { action: start | stop | forward }." }, { status: 400 })
  }
}
