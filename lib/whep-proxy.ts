/** Pure helpers for the WHEP proxy (app/api/relay/whep). */
const SESSION = /^[A-Za-z0-9-]{8,64}$/

/** Upstream MediaMTX path for a proxied WHEP request, or null if not allowed. */
export function whepTarget(path: string[], method: "POST" | "PATCH" | "DELETE", allowed: readonly string[]): string | null {
  if (!allowed.includes(path[0])) return null
  if (method === "POST") return path.length === 1 ? `/${path[0]}/whep` : null
  return path.length === 2 && SESSION.test(path[1]) ? `/${path[0]}/whep/${path[1]}` : null
}

/** MediaMTX answers Location: /<path>/whep/<session> → our /api/relay/whep/<path>/<session>. */
export function rewriteWhepLocation(location: string | null, path: string): string | null {
  if (!location) return null
  const m = /\/whep\/([A-Za-z0-9-]{8,64})$/.exec(location)
  return m ? `/api/relay/whep/${path}/${m[1]}` : null
}
