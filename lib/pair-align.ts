/**
 * Capture page only: keep the standby input's player at the same distance from live as the on-air one,
 * so a Main↔Backup switch doesn't make the capture mix jump its audio delay (the "[switch] delta").
 * Only the standby player is corrected (it's silent and invisible): a small playbackRate trim for small
 * drift, a seek inside its buffer for big drift. The on-air player is never touched here.
 */
export const ALIGN_DEADBAND_MS = 60
export const ALIGN_SEEK_MS = 500
export const ALIGN_RATE_FAST = 1.05
export const ALIGN_RATE_SLOW = 0.95
export const ALIGN_SEEK_GAP_MS = 3000
export const ALIGN_FRESH_MS = 1500
/** Never pull the standby more than this behind its own normal delay: a much slower on-air input is matched by the capture's resync at the switch instead. */
export const ALIGN_MAX_PULL_MS = 1500

/** diffMs limited so the standby (ahead: diff < 0) is slowed at most to ownBase + ALIGN_MAX_PULL_MS. */
export function cappedDiff(diffMs: number | null, ownLatMs: number | null, ownBaseMs: number | null): number | null {
  if (diffMs === null || diffMs >= 0 || ownLatMs === null || ownBaseMs === null) return diffMs
  const room = Math.max(0, ownBaseMs + ALIGN_MAX_PULL_MS - ownLatMs)
  return -Math.min(-diffMs, room)
}

type Entry = { latMs: number; onAir: boolean; at: number }
const players = new Map<string, Entry>()
export function reportPlayerLatency(label: string, latMs: number | null, onAir: boolean, now: number) {
  if (latMs === null || !Number.isFinite(latMs)) { players.delete(label); return }
  players.set(label, { latMs, onAir, at: now })
}
export function forgetPlayer(label: string) { players.delete(label) }
/** The on-air player's latency (fresh only), or null. */
export function onAirLatency(self: string, now: number): number | null {
  for (const [k, e] of players) if (k !== self && e.onAir && now - e.at <= ALIGN_FRESH_MS) return e.latMs
  return null
}

export type AlignState = { lastSeekAt: number; mode: "ok" | "fast" | "slow" }
export const newAlign = (): AlignState => ({ lastSeekAt: -Infinity, mode: "ok" })
/**
 * One tick for the standby player. diffMs = standby latency − on-air latency (> 0: standby is behind).
 * aheadSec / behindSec: buffered media after / before currentTime. Returns the rate and an optional seek (sec, relative).
 */
export function alignTick(st: AlignState, diffMs: number | null, aheadSec: number, behindSec: number, now: number): { rate: number; seekSec: number | null; event: string | null } {
  if (diffMs === null) { const was = st.mode; st.mode = "ok"; return { rate: 1, seekSec: null, event: was !== "ok" ? "no on-air latency: rate 1" : null } }
  const abs = Math.abs(diffMs)
  if (abs > ALIGN_SEEK_MS && now - st.lastSeekAt >= ALIGN_SEEK_GAP_MS) {
    const sec = diffMs / 1000
    // Behind → forward inside the buffer (keep 0.3s ahead); ahead → back inside what's still buffered.
    const ok = sec > 0 ? aheadSec - sec >= 0.3 : behindSec >= -sec
    if (ok) { st.lastSeekAt = now; st.mode = "ok"; return { rate: 1, seekSec: sec, event: `seek ${sec > 0 ? "+" : ""}${Math.round(diffMs)}ms` } }
  }
  let mode: AlignState["mode"] = st.mode
  if (abs <= ALIGN_DEADBAND_MS / 2) mode = "ok"
  else if (abs > ALIGN_DEADBAND_MS) mode = diffMs > 0 ? (aheadSec > 0.5 ? "fast" : "ok") : "slow"
  const event = mode !== st.mode ? (mode === "ok" ? `aligned (${Math.round(diffMs)}ms)` : `rate ${mode === "fast" ? ALIGN_RATE_FAST : ALIGN_RATE_SLOW}x (${Math.round(diffMs)}ms off)`) : null
  st.mode = mode
  return { rate: mode === "fast" ? ALIGN_RATE_FAST : mode === "slow" ? ALIGN_RATE_SLOW : 1, seekSec: null, event }
}
