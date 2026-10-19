import { connection } from "next/server"
import { authorizeMutation } from "@/lib/auth"
import { dlog, londonParts } from "@/lib/dropout-log"
import { readServerState } from "@/lib/event-server"
import { stageScreen } from "@/lib/stage"

/**
 * "Mark blackout" (desk / deck): the operator saw a dropout on YouTube. One "! [operator]" line in the
 * dropout log with what was on air, so `npm run dropouts` and the desk's Dropout log can show what
 * happened in the seconds before (YouTube runs behind the local output).
 */
const PAGES = new Set(["desk", "deck", "phone"])
let lastAt = 0
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request)
  if (denied) return denied
  let page = "desk"
  try {
    const body = (await request.json()) as { page?: unknown }
    if (typeof body.page === "string" && PAGES.has(body.page)) page = body.page
  } catch { /* default */ }
  const now = Date.now()
  if (now - lastAt < 1000) return Response.json({ ok: true, at: lastAt, time: londonParts(lastAt).time.slice(0, 8), repeat: true })
  lastAt = now
  const state = readServerState()
  const stage = state.stage
  const screen = stageScreen(stage, false)
  dlog("!", "operator", `blackout marked on ${page} (on air: ${stage.programSource === "backup" ? "Backup" : "Main"}, screen: ${screen})`, now)
  return Response.json({ ok: true, at: now, time: londonParts(now).time.slice(0, 8) })
}
