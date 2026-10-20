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
