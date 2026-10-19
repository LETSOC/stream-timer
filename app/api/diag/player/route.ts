import { connection } from "next/server"
import { canView } from "@/lib/view-key"
import { dlog } from "@/lib/dropout-log"

/**
 * /stream's program players report stalls / rebuilds / "Waiting for OBS" here (Browser capture only,
 * see lib/player-diag.ts). Same gate as the program HLS. Written to the dropout log as [player].
 */
let windowAt = 0
let windowCount = 0
export async function POST(request: Request) {
  await connection()
  if (!canView(request)) return new Response("View key required", { status: 401 })
  let body: { events?: unknown }
  try { body = JSON.parse((await request.text()).slice(0, 64_000)) } catch { return Response.json({ error: "bad json" }, { status: 400 }) }
  const events = Array.isArray(body.events) ? body.events.slice(0, 40) : []
  const now = Date.now()
  if (now - windowAt > 10_000) { windowAt = now; windowCount = 0 }
  for (const e of events) {
    if (!e || typeof e !== "object") continue
    const { at, level, msg } = e as { at?: unknown; level?: unknown; msg?: unknown }
    if (typeof msg !== "string" || (level !== "!" && level !== "+" && level !== "·")) continue
    if (++windowCount > 120) break // a runaway page can't flood the log
    // Page clock = server clock (same machine for Browser capture); clamp anything odd.
    const t = typeof at === "number" && Math.abs(at - now) < 60_000 ? at : now
    dlog(level, "player", msg.replace(/[^\x20-\x7e\u00a0-\u2fff]/g, "").slice(0, 300), t)
  }
  return Response.json({ ok: true })
}
