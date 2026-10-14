import { connection } from "next/server"
import { requireOperator } from "@/lib/auth"
import { currentDeckState } from "@/lib/transport-server"

/** Deck polling fallback (when the WebSocket is blocked): the compact transport state. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  return Response.json(currentDeckState(), { headers: { "Cache-Control": "no-store" } })
}
