/**
 * In-memory login throttle (one instance; resets on restart).
 * 5 failures → 30s lockout, doubling per further failure up to 15 min.
 */
type Entry = { fails: number; until: number }
const entries = new Map<string, Entry>()
const FREE_TRIES = 5
const BASE_MS = 30_000
const MAX_MS = 15 * 60_000

export function lockedFor(key: string, now = Date.now()): number {
  const entry = entries.get(key)
  return entry && entry.until > now ? entry.until - now : 0
}

export function recordFailure(key: string, now = Date.now()): number {
  const entry = entries.get(key) ?? { fails: 0, until: 0 }
  entry.fails += 1
  if (entry.fails >= FREE_TRIES) {
    const lock = Math.min(MAX_MS, BASE_MS * 2 ** (entry.fails - FREE_TRIES))
    entry.until = now + lock
  }
  entries.set(key, entry)
  return lockedFor(key, now)
}

export function recordSuccess(key: string) {
  entries.delete(key)
}

export function resetRateLimit() {
  entries.clear()
}

/** Client key: rightmost X-Forwarded-For hop when TRUST_PROXY=1 (set by your proxy), else one shared bucket. */
export function clientKey(request: Request): string {
  if (process.env.TRUST_PROXY === "1") {
    const hops = (request.headers.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean)
    if (hops.length) return hops[hops.length - 1]
  }
  return "default"
}
