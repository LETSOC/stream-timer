import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { saveVerticalSettings, startVertical, stopVertical, verticalStatus } from "@/lib/vertical"

const NO_STORE = { "Cache-Control": "no-store" }

/** Operator only. Vertical (9:16) output status. Hosts only, never a URL or key. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  return Response.json(await verticalStatus(), { headers: NO_STORE })
}

/** Operator + same-origin. { action: "start" | "stop" } or { action: "settings", settings: { destIds?, bg?, encoder?, audio? } } */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request) ?? requireOperator(request)
  if (denied) return denied
  const body = (await request.json().catch(() => null)) as { action?: unknown; settings?: unknown } | null
  const result = body?.action === "start" ? await startVertical() : body?.action === "stop" ? await stopVertical() : body?.action === "settings" ? await saveVerticalSettings(body.settings) : null
  if (!result) return Response.json({ error: "Expected { action: start | stop | settings }." }, { status: 400, headers: NO_STORE })
  const status = await verticalStatus()
  return result.ok ? Response.json({ ...status, note: result.note ?? null }, { headers: NO_STORE }) : Response.json({ ...status, error: result.error }, { status: result.status, headers: NO_STORE })
}
