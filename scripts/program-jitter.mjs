// Program-audio jitter buffer helpers for capture-stream (pure, unit-tested in lib/program-jitter.test.ts).
//
// Why: a remote OBS (other network) delivers audio in bursts with irregular timestamps. The old
// controller kept the queue at its target by resampling up to ±16% from a ~120ms-smoothed level, so
// burst noise became continuous pitch wobble ("record player"). Now:
//   * the queue level is averaged over ~2s and its burst spread (jitter) is measured per input,
//   * nothing is corrected inside a dead band that scales with that jitter,
//   * outside it, timing is fixed by short splices (drop or repeat ≤5ms with a 5ms crossfade) —
//     never by changing playback rate, so pitch never moves,
//   * big jumps (player stall/resync) still drop once / hold silence as before.

/** Rolling min/max of the queue level (ms) over `windowMs`: spread = burstiness of arrivals. */
export function createJitterMeter(windowMs = 3000) {
  let cur = { start: 0, min: Infinity, max: -Infinity }
  let prev = null
  return {
    add(levelMs, now) {
      if (now - cur.start >= windowMs) { prev = cur.min <= cur.max ? cur : prev; cur = { start: now, min: levelMs, max: levelMs } }
      cur.min = Math.min(cur.min, levelMs); cur.max = Math.max(cur.max, levelMs)
    },
    /** spread over the last full window and the current one */
    spreadMs() {
      const lo = Math.min(cur.min, prev?.min ?? Infinity), hi = Math.max(cur.max, prev?.max ?? -Infinity)
      return Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : 0
    },
    reset() { cur = { start: 0, min: Infinity, max: -Infinity }; prev = null },
  }
}

/**
 * Dead band (ms) for the level controller. The level is already a ~2s average, so bursts are filtered
 * there; a wide band (it was spread/2, ~190ms for a remote input) left the queue that much above its
 * target = audio late by that much. Now 15..40ms: within the 40ms sync target.
 */
export function deadBandMs(spreadMs) {
  return Math.max(15, Math.min(40, 15 + spreadMs / 20))
}

/**
 * Frames to splice this block: + = drop (queue too full), - = repeat (too empty), 0 = leave alone.
 * At most `maxFrames` per splice, and only outside the dead band.
 */
export function spliceFrames(errMs, bandMs, rate, maxFrames) {
  if (Math.abs(errMs) <= bandMs) return 0
  const want = Math.round(((Math.abs(errMs) - bandMs / 2) / 1000) * rate)
  return Math.sign(errMs) * Math.max(1, Math.min(maxFrames, want))
}

/**
 * n stereo s16 frames out of `raw` (n + d frames; d>0 drop, d<0 repeat) with one crossfaded splice in
 * the middle. Pitch is untouched: samples are copied 1:1 on both sides of the splice.
 */
export function splice(raw, n, d, fade = 240) {
  const m = raw.length / 4
  if (m !== n + d) throw new Error(`splice: have ${m} frames, need ${n + d}`)
  const out = Buffer.allocUnsafe(n * 4)
  if (d === 0) { raw.copy(out, 0, 0, n * 4); return out }
  const L = Math.max(1, Math.min(fade, Math.floor((Math.min(n, m) - Math.abs(d)) / 2)))
  const at = (i, c) => raw.readInt16LE(i * 4 + c * 2)
  if (d > 0) {
    // drop d frames: out[i] = raw[i] → crossfade → raw[i + d]
    const p = Math.max(0, Math.floor((n - L) / 2))
    for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) {
      let v
      if (i < p) v = at(i, c)
      else if (i < p + L) { const t = (i - p + 1) / (L + 1); v = at(i, c) * (1 - t) + at(i + d, c) * t }
      else v = at(i + d, c)
      out.writeInt16LE(Math.round(v), i * 4 + c * 2)
    }
  } else {
    // repeat |d| frames: out[i] = raw[i] → crossfade → raw[i - |d|]
    const k = -d
    const p = Math.max(k, Math.floor((n - L) / 2))
    for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) {
      let v
      if (i < p) v = at(i, c)
      else if (i < p + L) { const t = (i - p + 1) / (L + 1); v = at(Math.min(i, m - 1), c) * (1 - t) + at(i - k, c) * t }
      else v = at(i - k, c)
      out.writeInt16LE(Math.round(v), i * 4 + c * 2)
    }
  }
  return out
}

/**
 * Hard-resync threshold (ms): queue this far off target → drop to target / hold silence at once.
 * The jitter-widened band is capped at 1s: during a night of 1–2s ingest gaps it grew to 2–3s and
 * left audio that late, fixed only by ≤5ms splices (~50ms/s).
 */
export function resyncThresholdMs(spreadMs) {
  return Math.min(1000, Math.max(300, spreadMs * 1.5))
}

/**
 * What to do with the program-audio queue this block. `force` = the picture just jumped (player rebuilt,
 * jumped to live, page hung): re-align on the raw queue now instead of waiting for the 2s average.
 * Returns "drop" (cut to target), "hold" (silence until the queue reaches target) or "none".
 */
export function resyncAction({ levelMs, queuedMs, targetMs, spreadMs, force = false }) {
  if (force) {
    const e = queuedMs - targetMs
    return e > 40 ? "drop" : e < -40 ? "hold" : "none"
  }
  const t = resyncThresholdMs(spreadMs)
  const err = levelMs - targetMs
  return err > t ? "drop" : err < -t ? "hold" : "none"
}

/** How long after a resync signal the latency is taken raw (no smoothing) and the queue force-aligned. */
export const RESYNC_WINDOW_MS = 1500

/** Snap when the target delay moves more than this between samples (~1s apart). */
export const TARGET_SNAP_MS = 300

/**
 * Pure: feed one target-delay sample (ms) at `now`; true when it differs from the sample ~1s earlier
 * by more than TARGET_SNAP_MS (a stepwise latency change the slow splices would take ~30s to follow).
 * `hist` is mutated (kept to the last ~1.5s).
 */
export function targetJumped(hist, now, targetMs, windowMs = 1000) {
  hist.push({ at: now, t: targetMs })
  while (hist.length > 1 && now - hist[1].at >= windowMs) hist.shift()
  const ref = hist[0]
  if (now - ref.at < windowMs * 0.5) return false
  if (Math.abs(targetMs - ref.t) <= TARGET_SNAP_MS) return false
  hist.length = 0
  hist.push({ at: now, t: targetMs })
  return true
}
