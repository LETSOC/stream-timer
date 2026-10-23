import { connection } from "next/server"
import { originAllowed } from "@/lib/encoder-auth"
import { readServerState } from "@/lib/event-server"
import { isScene } from "@/lib/visuals-assets"
import { runServerTransport } from "@/lib/transport-server"

/**
 * Scene-card video ended: cut to Program.
 * Only if that card is currently on air, has a video, and autoSwitch is on.
 * Same-origin only. Cannot switch anything else.
 */
export async function POST(request: Request) {
  await connection()
  if (!originAllowed(request)) return Response.json({ error: "Cross-origin changes are not allowed." }, { status: 403 })
  const state = readServerState()
  const overlay = state.stage.overlay
  if (!isScene(overlay)) return Response.json({ ok: false, skipped: true })
  const card = state.stage.scenes[overlay]
  if (!card?.video || !card.autoSwitch) return Response.json({ ok: false, skipped: true })
  // next scene if set and not itself; otherwise Program, as before.
  const next = card.next && card.next !== overlay && (card.next === "program" || isScene(card.next)) ? card.next : "program"
  const result = runServerTransport({ type: "screen", screen: next }, undefined, Date.now(), { by: "deck" })
  return Response.json({ ok: result.ok }, { status: result.ok ? 200 : result.status })
}
