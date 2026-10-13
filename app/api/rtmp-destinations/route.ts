import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { addDestination, deleteDestination, listDestinations, renameDestination, resolveDestination, selectDestination } from "@/lib/rtmp-destinations"

const NO_STORE = { "Cache-Control": "no-store" }

/** Operator only. Masked list: name, host and last 4 of the key, never the full URL. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  return Response.json(listDestinations(), { headers: NO_STORE })
}

/** Operator + same-origin. { action: "add" | "rename" | "delete" | "select" | "reveal", ... } */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request) ?? requireOperator(request)
  if (denied) return denied
  const body = (await request.json().catch(() => null)) as { action?: unknown; id?: unknown; name?: unknown; url?: unknown } | null
  if (!body || typeof body.action !== "string") return Response.json({ error: "Expected { action }." }, { status: 400 })
  const respond = (result: { ok: true; value: unknown } | { ok: false; error: string; status: number }) =>
    result.ok ? Response.json({ ...listDestinations(), item: result.value }, { headers: NO_STORE }) : Response.json({ error: result.error }, { status: result.status, headers: NO_STORE })
  switch (body.action) {
    case "add":
      return respond(addDestination(body.name, body.url))
    case "rename":
      return respond(renameDestination(body.id, body.name))
    case "delete":
      return respond(deleteDestination(body.id))
    case "select":
      return respond(selectDestination(body.id ?? null))
    case "reveal": {
      const item = resolveDestination(body.id)
      if (!item) return Response.json({ error: "No such destination." }, { status: 404, headers: NO_STORE })
      return Response.json({ id: item.id, url: item.url }, { headers: NO_STORE })
    }
    default:
      return Response.json({ error: "Unknown action." }, { status: 400 })
  }
}
