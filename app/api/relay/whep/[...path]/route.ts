import { connection } from "next/server"
import { requireOperator } from "@/lib/auth"
import { BACKUP_PATH, PROGRAM_PATH, RELAY_PATHS, relayWebrtcOrigin } from "@/lib/relay"
import { whepTarget, rewriteWhepLocation } from "@/lib/whep-proxy"

/**
 * WHEP (WebRTC read) signalling for operator previews, proxied to MediaMTX on 127.0.0.1 with the
 * server-side read login. POST <path> = offer → answer; PATCH/DELETE <path>/<session> = ICE / hang up.
 * Read-only: there is no WHIP route, and MediaMTX's WebRTC listener never leaves loopback.
 */
const ALLOWED = [...RELAY_PATHS, PROGRAM_PATH, BACKUP_PATH] as readonly string[]

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }, method: "POST" | "PATCH" | "DELETE") {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  const { path } = await context.params
  const target = whepTarget(path, method, ALLOWED)
  if (!target) return new Response("Not found", { status: 404 })
  const relay = relayWebrtcOrigin()
  if (!relay) return new Response("Fast previews are off", { status: 409 })
  let upstream: Response
  try {
    upstream = await fetch(`${relay.origin}${target}`, {
      method,
      headers: { Authorization: relay.authorization, ...(request.headers.get("content-type") ? { "Content-Type": request.headers.get("content-type")! } : {}), ...(request.headers.get("if-match") ? { "If-Match": request.headers.get("if-match")! } : {}) },
      body: method === "DELETE" ? undefined : await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    return new Response("Relay WebRTC unavailable", { status: 502 })
  }
  const headers = new Headers({ "Cache-Control": "no-store" })
  for (const h of ["content-type", "etag", "accept-patch"]) { const v = upstream.headers.get(h); if (v) headers.set(h, v) }
  const loc = rewriteWhepLocation(upstream.headers.get("location"), path[0])
  if (loc) headers.set("Location", loc)
  return new Response(method === "DELETE" ? null : await upstream.text(), { status: upstream.status, headers })
}

export const POST = (r: Request, c: { params: Promise<{ path: string[] }> }) => handle(r, c, "POST")
export const PATCH = (r: Request, c: { params: Promise<{ path: string[] }> }) => handle(r, c, "PATCH")
export const DELETE = (r: Request, c: { params: Promise<{ path: string[] }> }) => handle(r, c, "DELETE")
