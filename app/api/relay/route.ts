import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { armProgram, disarmProgram, programObsUrl, RELAY_PATHS, relayStatus, rotateProgramCredentials, setForward, startRelay, stopRelay, type RelayPath } from "@/lib/relay"

const NO_STORE = { "Cache-Control": "no-store" }

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
  const body = (await request.json().catch(() => null)) as { action?: unknown; path?: unknown; destinationId?: unknown; on?: unknown } | null
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
    case "arm-program":
      return reply(await armProgram())
    case "disarm-program":
      return reply(await disarmProgram())
    case "rotate-program":
      return reply(await rotateProgramCredentials())
    case "reveal-program":
      // OBS settings, on demand only (POST + operator + same-origin). Never part of GET status.
      return Response.json(programObsUrl(), { headers: NO_STORE })
    default:
      return Response.json({ error: "Expected { action: start | stop | forward | arm-program | disarm-program | reveal-program | rotate-program }." }, { status: 400 })
  }
}
