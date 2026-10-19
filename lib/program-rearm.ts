/**
 * Pure: decide when to auto re-arm the program input after the on-air source had a network drop and came
 * back. Disarm + re-arm is what the operator does by hand after a Wi-Fi drop to get A/V back in sync.
 *
 * A drop only counts when ALL hold:
 *  - the source was on air and READY (stable ≥ settle) right before it dropped;
 *  - it is still the on-air source (memory is per source; a failover switch starts it fresh);
 *  - it isn't inside a relay-side "quiet" window (operator arm/disarm, our own re-arm, MediaMTX
 *    start/restart or config reload, server start);
 *  - the other input didn't go down within 1s of it (both at once = relay-side, not a source's Wi-Fi).
 */
export const REARM_SETTLE_MS = 3000
export const REARM_MIN_GAP_MS = 20_000
export const BOTH_DROP_MS = 1000
export const QUIET_MS = 8000

export type RearmMemory = { live: boolean; dropped: boolean; droppedAt: number | null; readySince: number | null; lastAt: number }
export const FRESH_REARM: RearmMemory = { live: false, dropped: false, droppedAt: null, readySince: null, lastAt: -Infinity }

export type RearmInput = {
  /** not publishing / no data / FAILED */
  down: boolean
  /** publishing and READY (checklist ok) */
  ready: boolean
  /** this source is the one on air */
  onAir: boolean
  /** when the OTHER input last went down (null = it is up) */
  otherDownAt: number | null
  /** relay-side disruption window end (see noteRelayDisruption) */
  quietUntil: number
  now: number
  enabled: boolean
}

export function rearmStep(mem: RearmMemory, i: RearmInput): { mem: RearmMemory; fire: boolean } {
  const { now } = i
  if (!i.enabled || !i.onAir || now < i.quietUntil) {
    // Not eligible: forget any drop; the source must be on air + READY again before a drop counts.
    return { mem: { ...FRESH_REARM, lastAt: mem.lastAt, readySince: i.ready && i.onAir ? (mem.readySince ?? now) : null }, fire: false }
  }
  const nearOther = (at: number) => i.otherDownAt !== null && Math.abs(i.otherDownAt - at) <= BOTH_DROP_MS
  if (i.down) {
    if (mem.dropped) return { mem: nearOther(mem.droppedAt ?? now) ? { ...FRESH_REARM, lastAt: mem.lastAt } : { ...mem, readySince: null }, fire: false }
    if (mem.live && !nearOther(now)) return { mem: { ...mem, live: false, dropped: true, droppedAt: now, readySince: null }, fire: false }
    return { mem: { ...mem, live: false, readySince: null }, fire: false }
  }
  // Both-drop seen a tick late (the other went down just after this one).
  if (mem.dropped && nearOther(mem.droppedAt ?? now)) mem = { ...FRESH_REARM, lastAt: mem.lastAt }
  if (!i.ready) return { mem: { ...mem, readySince: null }, fire: false }
  const readySince = mem.readySince ?? now
  const stable = now - readySince >= REARM_SETTLE_MS
  if (!stable) return { mem: { ...mem, readySince }, fire: false }
  if (mem.dropped && now - mem.lastAt >= REARM_MIN_GAP_MS) return { mem: { ...FRESH_REARM, lastAt: now }, fire: true }
  // Stable on air: from here a drop counts (a drop inside the 20s gap is simply dropped, no queueing).
  return { mem: { ...mem, live: true, dropped: false, droppedAt: null, readySince }, fire: false }
}

// ---------- relay-side disruption window (shared by Next's bundle and server.ts via globalThis) ----------
const KEY = Symbol.for("stream-timer.relay-quiet")
type Holder = { [KEY]?: number }
/** Arm/disarm, MediaMTX (re)start or config reload, our own re-arm: drops in the next few seconds aren't Wi-Fi. */
export function noteRelayDisruption(now = Date.now(), ms = QUIET_MS) {
  const h = globalThis as Holder
  h[KEY] = Math.max(h[KEY] ?? 0, now + ms)
}
export function relayQuietUntil(): number {
  return (globalThis as Holder)[KEY] ?? 0
}

// ---------- re-arm hold: players keep the last frame instead of "Waiting for OBS" ----------
/**
 * A disarm (auto re-arm, or the operator's Disarm → Arm) kicks OBS on purpose; it reconnects a few
 * seconds later. For REARM_HOLD_MS after a disarm, /stream and the previews hold the last frame instead
 * of the "Waiting for OBS" card; then the normal rules apply (a disarm that stays off shows the card).
 */
export const REARM_HOLD_MS = 15_000
export type RearmHold = { disarmAt: number | null; until: number }
export const NO_REARM_HOLD: RearmHold = { disarmAt: null, until: 0 }
/** Pure: the hold after a disarm (a later Arm keeps that window: never past disarm + REARM_HOLD_MS). */
export const nextRearmHold = (now: number): RearmHold => ({ disarmAt: now, until: now + REARM_HOLD_MS })
export const rearmHoldLeft = (s: RearmHold, now: number) => Math.max(0, s.until - now)
const HOLD_KEY = Symbol.for("stream-timer.rearm-hold")
type HoldHolder = { [HOLD_KEY]?: RearmHold }
export function noteProgramDisarm(now = Date.now()) {
  (globalThis as HoldHolder)[HOLD_KEY] = nextRearmHold(now)
}
/** ms left in the re-arm hold (0 = none): what /api/public/state and the deck state carry. */
export function rearmHoldLeftMs(now = Date.now()): number {
  return rearmHoldLeft((globalThis as HoldHolder)[HOLD_KEY] ?? NO_REARM_HOLD, now)
}
