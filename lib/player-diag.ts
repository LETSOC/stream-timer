"use client"
/**
 * /stream → dropout log: what the program players did (stalls, rebuilds, "Waiting for OBS", hand-overs).
 * Only in Browser capture (?capture=1 / headless) or with ?diag=1, so viewers' tabs send nothing.
 * Batched once a second to /api/diag/player (same gate as the program HLS: view key or capture key).
 */
type Level = "!" | "+" | "·"
let queue: { at: number; level: Level; msg: string }[] = []
let timer: number | null = null
let enabled: boolean | null = null
const recent = new Map<string, number>()

/** Browser capture's page (or a tab opened with ?diag=1). */
export function isCapturePage(): boolean {
  if (typeof window === "undefined") return false
  const q = new URLSearchParams(window.location.search)
  return q.get("capture") === "1" || "__programPcm" in window || (navigator.webdriver === true && window.location.pathname === "/stream")
}
function on(): boolean {
  if (enabled === null) enabled = typeof window !== "undefined" && (isCapturePage() || new URLSearchParams(window.location.search).get("diag") === "1")
  return enabled
}
function flush() {
  timer = null
  if (!queue.length) return
  const events = queue.slice(0, 40)
  queue = queue.slice(40)
  const k = new URLSearchParams(window.location.search).get("k")
  void fetch(`/api/diag/player${k ? `?k=${encodeURIComponent(k)}` : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }), keepalive: true, cache: "no-store" }).catch(() => undefined)
  if (queue.length) timer = window.setTimeout(flush, 1000)
}
/** Report one event. `dedupeMs`: drop repeats of the same `key` within this window (e.g. hls.js error storms). */
export function playerDiag(level: Level, msg: string, opts: { key?: string; dedupeMs?: number } = {}) {
  if (!on()) return
  const now = Date.now()
  if (opts.key && opts.dedupeMs) {
    const last = recent.get(opts.key)
    if (last !== undefined && now - last < opts.dedupeMs) return
    recent.set(opts.key, now)
  }
  queue.push({ at: now, level, msg: msg.slice(0, 300) })
  if (queue.length > 200) queue = queue.slice(-200)
  if (timer === null) timer = window.setTimeout(flush, 1000)
}
