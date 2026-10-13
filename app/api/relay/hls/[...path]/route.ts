import { connection } from "next/server"
import { requireOperator } from "@/lib/auth"
import { RELAY_PATHS, relayHlsOrigin } from "@/lib/relay"

/**
 * LL-HLS preview of what is actually published to the relay, proxied from MediaMTX
 * (127.0.0.1 only) behind the desk's operator auth, so an iPhone on the LAN can watch it
 * without MediaMTX being reachable or its read credentials leaving the server.
 */
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  const { path } = await context.params
  if (!RELAY_PATHS.includes(path[0] as (typeof RELAY_PATHS)[number]) || path.length > 3 || path.some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || part === "..")) {
    return new Response("Not found", { status: 404 })
  }
  const { origin, authorization } = relayHlsOrigin()
  const incoming = new URL(request.url)
  let target = `${origin}/${path.join("/")}${incoming.search}`
  // MediaMTX answers the first playlist request with a cookie-check redirect; follow it here.
  for (let hop = 0; hop < 3; hop++) {
    let upstream: Response
    try {
      upstream = await fetch(target, { headers: { Authorization: authorization, }, redirect: "manual", cache: "no-store", signal: request.signal })
    } catch {
      return new Response("Relay preview unavailable", { status: 502 })
    }
    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get("location")) {
      // No cookie on the follow-up: MediaMTX then puts ?session= in the playlist URLs, which pass through this proxy.
      const next = new URL(upstream.headers.get("location")!, target)
      if (next.origin !== origin) return new Response("Bad redirect", { status: 502 })
      target = next.toString()
      continue
    }
    const headers = new Headers({ "Cache-Control": "no-store" })
    const type = upstream.headers.get("content-type")
    if (type) headers.set("Content-Type", type)
    return new Response(upstream.body, { status: upstream.status, headers })
  }
  return new Response("Too many redirects", { status: 502 })
}
