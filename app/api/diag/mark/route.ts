import { connection } from "next/server"
import { authorizeMutation } from "@/lib/auth"
import { dlog, londonParts } from "@/lib/dropout-log"
import { readServerState } from "@/lib/event-server"
import { cleanNote, isMarkType, isProblemType, MARK_PAGES, MARK_TYPES, markMessage, type MarkPage, type MarkType } from "@/lib/marks"
import { stageScreen } from "@/lib/stage"

/**
 * ⚑ Mark (desk / deck / phone): one "[operator]" line in the dropout log with the type, page, what was
 * on air and the screen, plus an optional short note. Problem marks (blackout / frozen / audio) are "!"
 * (incidents: `npm run dropouts` and the desk's Dropout log show 15s before → 5s after, YouTube runs
 * behind); intentional ones (stopped / back on / test) are "·" and label the relay lines they cause
 * as expected. Body: { page, type?, note? } (type defaults to blackout).
 */
const last = new Map<string, number>()
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request)
  if (denied) return denied
  let page: MarkPage = "desk"
  let type: MarkType = "blackout"
  let note = ""
  try {
    const body = (await request.json()) as { page?: unknown; type?: unknown; note?: unknown }
    if (typeof body.page === "string" && (MARK_PAGES as readonly string[]).includes(body.page)) page = body.page as MarkPage
    if (body.type !== undefined) {
      if (!isMarkType(body.type)) return Response.json({ ok: false, error: "Unknown mark type" }, { status: 400 })
      type = body.type
    }
    note = cleanNote(body.note)
  } catch { /* defaults */ }
  if (type === "note" && !note) return Response.json({ ok: false, error: "Type a note first" }, { status: 400 })
  const now = Date.now()
  const prev = last.get(type) ?? 0
  // A double tap of the same marker is one mark (another type right after is its own mark).
  if (now - prev < 1000) return Response.json({ ok: true, at: prev, time: londonParts(prev).time.slice(0, 8), type, label: MARK_TYPES[type].label, repeat: true })
  last.set(type, now)
  const stage = readServerState().stage
  const onAir = stage.programSource === "backup" ? "Backup" : "Main"
  dlog(isProblemType(type) ? "!" : "·", "operator", markMessage(type, page, onAir, stageScreen(stage, false), note), now)
  return Response.json({ ok: true, at: now, time: londonParts(now).time.slice(0, 8), type, label: MARK_TYPES[type].label })
}
