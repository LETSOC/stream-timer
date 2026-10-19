import { connection } from "next/server"
import { requireOperator } from "@/lib/auth"
import { formatMark, markIncidents, MARK_BEFORE_MS, readDropoutEvents } from "@/lib/dropout-log"

/** Desk "Dropout log": the last operator marks (last 6 h) with their surrounding events, as text. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  const now = Date.now()
  const events = readDropoutEvents(now - 6 * 3_600_000 - MARK_BEFORE_MS, now)
  const marks = markIncidents(events).slice(-10).reverse()
  const problems = events.filter((e) => e.level === "!" && e.at >= now - 10 * 60_000 && e.cat !== "operator").length
  return Response.json({
    marks: marks.map((m) => ({ at: m.mark.at, text: formatMark(m), lines: m.context.length })),
    problemsLast10Min: problems,
  }, { headers: { "cache-control": "no-store" } })
}
