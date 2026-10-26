import { connection } from "next/server"
import { requireOperator } from "@/lib/auth"
import { loadAlertSnapshot } from "@/lib/load-alert"

/** Read-only: is the Mac overloaded (lib/load-alert)? The desk hides its previews while it is. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  return Response.json(loadAlertSnapshot(), { headers: { "Cache-Control": "no-store" } })
}
