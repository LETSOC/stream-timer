import { connection } from "next/server"
import { requireOperator } from "@/lib/auth"
import { annotateExpected, formatMark, formatMarkers, isMark, isRealProblem, markIncidents, OPEN_WINDOW_MS, readDropoutEvents } from "@/lib/dropout-log"

/**
 * Desk "Dropout log": the last problem marks (last 6 h) with their surrounding events, the intentional
 * markers (stops / back on / tests / notes), and a `copy` text with both (the Copy all button).
 */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  const now = Date.now()
  const since = now - 6 * 3_600_000
  // Read further back so a stop / test marked earlier still labels the lines after it.
  const events = annotateExpected(readDropoutEvents(since - OPEN_WINDOW_MS, now))
  const recent = events.filter((e) => e.at >= since)
  const marks = markIncidents(events).filter((m) => m.mark.at >= since).slice(-10).reverse()
  const markers = formatMarkers(events, "", since).filter((_, i, all) => i >= all.length - 20).reverse()
  const tenMin = recent.filter((e) => e.at >= now - 10 * 60_000)
  const problems = tenMin.filter(isRealProblem).length
  const expected = tenMin.filter((e) => e.level === "!" && e.expected && !isMark(e)).length
  const markTexts = marks.map((m) => formatMark(m))
  const copy = [
    ...markTexts,
    markers.length ? `Operator markers (on purpose; their relay lines are labelled expected):\n${markers.map((l) => `  ${l}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n")
  return Response.json({
    marks: marks.map((m, i) => ({ at: m.mark.at, text: markTexts[i], lines: m.context.length })),
    markers,
    problemsLast10Min: problems,
    expectedLast10Min: expected,
    copy,
  }, { headers: { "cache-control": "no-store" } })
}
