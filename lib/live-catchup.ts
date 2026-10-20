/**
 * On-air program player: jump back to the live edge when it has drifted too far behind.
 * hls.js's own catch-up (1.15x) only starts past liveMaxLatencyDurationCount × segment (≈12s with
 * 3s segments), so after stalls the picture sat ~8s behind OBS. Pure, unit-tested.
 */
export const LIVE_JUMP_OVER_MS = 3000
/** Latency must stay over the limit this long (one late frame is not drift). */
export const LIVE_JUMP_SUSTAIN_MS = 1000
/** No second jump sooner than this (the jump itself needs a moment to settle). */
export const LIVE_JUMP_GAP_MS = 5000

export type LiveJumpState = { overSince: number | null; lastJumpAt: number }

/** Feed one latency sample; returns whether to jump now (and mutates `st`). */
export function liveJumpTick(st: LiveJumpState, latencyMs: number | null, now: number): boolean {
  if (latencyMs === null || latencyMs <= LIVE_JUMP_OVER_MS) { st.overSince = null; return false }
  if (st.overSince === null) st.overSince = now
  if (now - st.overSince < LIVE_JUMP_SUSTAIN_MS || now - st.lastJumpAt < LIVE_JUMP_GAP_MS) return false
  st.overSince = null
  st.lastJumpAt = now
  return true
}

/** Where to seek: hls.js's live sync position, else 1s inside the end of what is buffered. */
export function liveTarget(liveSync: number | null | undefined, bufferedEnd: number | null, currentTime: number): number | null {
  const t = liveSync !== null && liveSync !== undefined && Number.isFinite(liveSync) ? liveSync : bufferedEnd !== null ? bufferedEnd - 1 : null
  return t !== null && t > currentTime + 0.5 ? t : null
}

/**
 * After a stall the on-air player can settle a little behind where it was (log 14:07: 2.1s → 3.5s, under
 * the 3s jump only just, and hls.js's live sync position already that far back so the jump was a no-op).
 * Gentle settle: the player's own best latency (its floor, ~2.1s when healthy) is the target; sitting
 * more than SETTLE_OVER_MS above it for SETTLE_SUSTAIN_MS → play at SETTLE_RATE until back within
 * SETTLE_DONE_MS. 1.05x = −50ms/s of delay, far below the 300ms/1s step that snaps program audio, so the
 * audio follows with its normal small splices. Pure, unit-tested.
 */
export const SETTLE_OVER_MS = 500
export const SETTLE_SUSTAIN_MS = 10000
export const SETTLE_DONE_MS = 200
export const SETTLE_RATE = 1.05
/** Never chase below this (a lucky sample is not the floor). */
export const SETTLE_MIN_FLOOR_MS = 1000
/** Keep this much buffered ahead while catching up (else stop: it would stall again). */
export const SETTLE_MIN_AHEAD_S = 0.6
/** After a paused settle (thin buffer = the delay is upstream, not ours), wait this long before retrying. */
export const SETTLE_RETRY_MS = 60000

export type SettleState = { floorMs: number | null; overSince: number | null; active: boolean; startedAt: number; fromMs: number; retryAt: number }
export const newSettle = (): SettleState => ({ floorMs: null, overSince: null, active: false, startedAt: 0, fromMs: 0, retryAt: 0 })

export type SettleStep = { rate: number; event: null | { kind: "start" | "done" | "abort"; fromMs: number; toMs: number; floorMs: number; tookMs: number } }

/** Feed one latency sample (+ seconds buffered ahead); returns the playbackRate to use (mutates `st`). */
export function settleTick(st: SettleState, latencyMs: number | null, aheadS: number, now: number): SettleStep {
  if (latencyMs === null) return { rate: st.active ? SETTLE_RATE : 1, event: null }
  // The floor follows the best latency seen, and creeps up slowly (1ms per sample) so a new path that is
  // genuinely slower (e.g. another input) becomes the target instead of being chased forever.
  if (!st.active) st.floorMs = st.floorMs === null ? Math.max(SETTLE_MIN_FLOOR_MS, latencyMs) : Math.max(SETTLE_MIN_FLOOR_MS, Math.min(latencyMs, st.floorMs + 1))
  const floor = st.floorMs ?? latencyMs
  if (st.active) {
    if (latencyMs <= floor + SETTLE_DONE_MS) {
      st.active = false; st.overSince = null
      return { rate: 1, event: { kind: "done", fromMs: st.fromMs, toMs: latencyMs, floorMs: floor, tookMs: now - st.startedAt } }
    }
    if (aheadS < SETTLE_MIN_AHEAD_S) {
      st.active = false; st.overSince = null; st.retryAt = now + SETTLE_RETRY_MS
      return { rate: 1, event: { kind: "abort", fromMs: st.fromMs, toMs: latencyMs, floorMs: floor, tookMs: now - st.startedAt } }
    }
    return { rate: SETTLE_RATE, event: null }
  }
  if (latencyMs <= floor + SETTLE_OVER_MS) { st.overSince = null; return { rate: 1, event: null } }
  if (st.overSince === null) st.overSince = now
  if (now - st.overSince < SETTLE_SUSTAIN_MS || now < st.retryAt || aheadS < SETTLE_MIN_AHEAD_S + 0.2) return { rate: 1, event: null }
  st.active = true; st.startedAt = now; st.fromMs = latencyMs
  return { rate: SETTLE_RATE, event: { kind: "start", fromMs: latencyMs, toMs: latencyMs, floorMs: floor, tookMs: 0 } }
}
