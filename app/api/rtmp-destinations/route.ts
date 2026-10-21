import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { destinationFingerprint, directChannelDests } from "@/lib/encoder"
import { reconcileRelay, relayForwardFingerprints } from "@/lib/relay"
import { addDestination, deleteDestination, destinationEditInfo, listDestinations, renameDestination, resolveDestination, selectDestination, setDestinationTimer, updateDestination } from "@/lib/rtmp-destinations"

const NO_STORE = { "Cache-Control": "no-store" }

/** Operator only. Masked list: name, host and last 4 of the key, never the full URL. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  return Response.json(listDestinations(), { headers: NO_STORE })
}

const CHANNEL_LABEL = { slate: "Slate", capture: "Browser capture" } as const

/**
 * Edit a destination. A new URL hot-restarts only the relay forwards ticked for it (their process tag
 * carries the URL fingerprint, so reconcile replaces exactly those); Browser capture, Vertical and the
 * other forwards keep running. A channel publishing to it directly is not restarted (it says so).
 */
async function update(body: { id?: unknown; name?: unknown; server?: unknown; key?: unknown }) {
  const before = resolveDestination(body.id)
  const forwards = before ? relayForwardFingerprints().filter((f) => f.destId === before.id).map((f) => f.path) : []
  const direct = before ? directChannelDests().filter((c) => c.running && !c.relay && c.dest === destinationFingerprint(before.url)).map((c) => c.channel) : []
  const result = updateDestination(body.id, { name: body.name, server: body.server, key: body.key })
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status, headers: NO_STORE })
  const notes: string[] = []
  if (result.changed) {
    if (forwards.length) {
      try {
        await reconcileRelay(true)
        notes.push(`Restarted ${forwards.map((p) => (p === "vertical" ? "Vertical" : `HD /${p}`)).join(" + ")} forward with the new key (nothing else restarted).`)
      } catch {
        notes.push("Saved. The forward restarts with the new key within a few seconds.")
      }
    }
    for (const ch of direct) notes.push(`${CHANNEL_LABEL[ch]} publishes straight to this destination: Stop and Start it to use the new key.`)
  }
  return Response.json({ ...listDestinations(), item: result.value, changed: result.changed === true, note: notes.join(" ") || (result.changed ? "Saved." : "Saved (no change).") }, { headers: NO_STORE })
}

/** Operator + same-origin. { action: "add" | "rename" | "update" | "edit-info" | "delete" | "select" | "reveal" | "set-timer", ... } */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request) ?? requireOperator(request)
  if (denied) return denied
  const body = (await request.json().catch(() => null)) as { action?: unknown; id?: unknown; name?: unknown; url?: unknown; channel?: unknown; server?: unknown; key?: unknown; activateAt?: unknown; timerPath?: unknown } | null
  if (!body || typeof body.action !== "string") return Response.json({ error: "Expected { action }." }, { status: 400 })
  const respond = (result: { ok: true; value: unknown } | { ok: false; error: string; status: number }) =>
    result.ok ? Response.json({ ...listDestinations(), item: result.value }, { headers: NO_STORE }) : Response.json({ error: result.error }, { status: result.status, headers: NO_STORE })
  switch (body.action) {
    case "add":
      return respond(addDestination(body.name, body.url))
    case "rename":
      return respond(renameDestination(body.id, body.name))
    case "update":
      return update(body)
    case "edit-info": {
      const info = destinationEditInfo(body.id)
      return info ? Response.json(info, { headers: NO_STORE }) : Response.json({ error: "No such destination." }, { status: 404, headers: NO_STORE })
    }
    case "delete":
      return respond(deleteDestination(body.id))
    case "select":
      return respond(selectDestination(body.id ?? null, body.channel === "capture" ? "capture" : "slate"))
    case "reveal": {
      const item = resolveDestination(body.id)
      if (!item) return Response.json({ error: "No such destination." }, { status: 404, headers: NO_STORE })
      return Response.json({ id: item.id, url: item.url }, { headers: NO_STORE })
    }
    case "set-timer": {
      const at = body.activateAt === null || body.activateAt === undefined ? null : Number(body.activateAt)
      const path = body.timerPath === "slate" || body.timerPath === "capture" || body.timerPath === "vertical" ? body.timerPath : null
      return respond(setDestinationTimer(body.id, at, path))
    }
    default:
      return Response.json({ error: "Unknown action." }, { status: 400 })
  }
}
