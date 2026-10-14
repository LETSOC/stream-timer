import { connection } from "next/server"
import { isOperator } from "@/lib/auth"
import { originAllowed } from "@/lib/encoder-auth"
import { parseAction } from "@/lib/transport"
import { runServerTransport } from "@/lib/transport-server"

/**
 * HTTP fallback for deck actions (same logic as the WebSocket). Operator session or local mode
 * only: the machine encoder token is deliberately not accepted for transport.
 */
export async function POST(request: Request) {
  await connection()
  if (!originAllowed(request)) return Response.json({ error: "Cross-origin changes are not allowed." }, { status: 403 })
  if (!isOperator(request)) return Response.json({ error: "Log in to the desk first.", login: "/login" }, { status: 401 })
  const raw = await request.text()
  if (raw.length > 4096) return Response.json({ error: "Too large." }, { status: 413 })
  let body: { action?: unknown; rev?: unknown } | null = null
  try {
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 })
  }
  const action = parseAction(body?.action)
  if (!action) return Response.json({ error: "Unknown action." }, { status: 400 })
  const result = runServerTransport(action, typeof body?.rev === "number" ? body.rev : undefined)
  return Response.json(result, { status: result.ok ? 200 : result.status })
}
