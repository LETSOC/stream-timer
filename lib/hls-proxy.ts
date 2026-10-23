import { relayHlsOrigin } from "@/lib/relay"
import { dlog } from "@/lib/dropout-log"

/** Safe relay HLS sub-path: `<path>/<file>` parts only, no traversal. */
export function validHlsPath(path: string[], allowed: readonly string[]): boolean {
  return allowed.includes(path[0]) && path.length <= 3 && path.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "..")
}

/** Proxy one LL-HLS request to MediaMTX (127.0.0.1) with the server-side read login. */
export async function proxyRelayHls(request: Request, path: string[]): Promise<Response> {
  const { origin, authorization } = relayHlsOrigin()
  const incoming = new URL(request.url)
  let target = `${origin}/${path.join("/")}${incoming.search}`
  const ua = /iPhone|iPad|Android/.test(request.headers.get("user-agent") ?? "") ? "mobile" : "desktop"
  const t0 = performance.now()
  // MediaMTX answers the first playlist request with a cookie-check redirect; follow it here.
  for (let hop = 0; hop < 3; hop++) {
    let upstream: Response
    try {
      upstream = await fetch(target, { headers: { Authorization: authorization, }, redirect: "manual", cache: "no-store", signal: request.signal })
    } catch {
      const ms = Math.round(performance.now() - t0)
      dlog("!", "relay", `hls proxy ${path.join("/")}: ${request.signal.aborted ? `client gave up after ${ms}ms (upstream had not answered)` : `upstream failed after ${ms}ms`} [${ua}]`)
      return new Response("Relay preview unavailable", { status: 502 })
    }
    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.get("location")) {
      // No cookie on the follow-up: MediaMTX then puts ?session= in the playlist URLs, which pass through this proxy.
      const next = new URL(upstream.headers.get("location")!, target)
      if (next.origin !== origin) return new Response("Bad redirect", { status: 502 })
      target = next.toString()
      continue
    }
    const ms = Math.round(performance.now() - t0)
    if (ms > 2000) dlog("·", "relay", `hls proxy ${path.join("/")}: upstream answered in ${ms}ms [${ua}]`)
    const headers = new Headers({ "Cache-Control": "no-store" })
    const type = upstream.headers.get("content-type")
    if (type) headers.set("Content-Type", type)
    return new Response(upstream.body, { status: upstream.status, headers })
  }
  return new Response("Too many redirects", { status: 502 })
}
