// Showreel (scene-card video) audio from the capture page: s16le stereo 48k chunks pushed by the
// page tap (window.__showreelPcm), played out delayed to line up with the captured picture.
// Contained on purpose: an empty / stale queue returns null, and the caller then mixes exactly as before.

const RATE = 48000
export const SHOWREEL_STALE_MS = 500

export function createShowreelQueue() {
  return { chunks: [], bytes: 0, at: 0, primed: false, gain: 1 }
}

/** Page sent a chunk (base64 s16 stereo). Never more than 1.5s queued. */
export function pushShowreel(q, buf, now = Date.now()) {
  q.chunks.push(buf); q.bytes += buf.length; q.at = now
  const max = Math.round(1.5 * RATE) * 4
  if (q.bytes > max) dropBytes(q, q.bytes - max)
}

export function clearShowreel(q) {
  q.chunks = []; q.bytes = 0; q.primed = false
}

function dropBytes(q, bytes) {
  let left = bytes - (bytes % 4)
  while (left > 0 && q.chunks.length) {
    const head = q.chunks[0]
    if (head.length <= left) { q.chunks.shift(); q.bytes -= head.length; left -= head.length }
    else { q.chunks[0] = head.subarray(left); q.bytes -= left; left = 0 }
  }
}

/**
 * n frames delayed by targetMs (same picture lag the program page path uses), or null when the
 * page isn't sending (stale) or the queue is (re)filling. Too far behind (>300ms) → drop to target.
 */
export function takeShowreel(q, n, targetMs, now = Date.now()) {
  if (!q.at || now - q.at > SHOWREEL_STALE_MS) { if (q.bytes) clearShowreel(q); return null }
  const targetBytes = Math.round((Math.max(0, targetMs) / 1000) * RATE) * 4
  if (!q.primed) { if (q.bytes < Math.max(targetBytes, n * 4)) return null; q.primed = true }
  if (q.bytes - targetBytes > Math.round(0.3 * RATE) * 4) dropBytes(q, q.bytes - targetBytes)
  const want = n * 4
  if (q.bytes < want) { q.primed = false; return null }
  const buf = Buffer.allocUnsafe(want)
  let at = 0
  while (at < want) {
    const head = q.chunks[0]
    const take = Math.min(head.length, want - at)
    head.copy(buf, at, 0, take)
    at += take
    if (take === head.length) q.chunks.shift()
    else q.chunks[0] = head.subarray(take)
  }
  q.bytes -= want
  return buf
}

/**
 * Bed gain under the showreel: ramps to 0 while showreel audio flows, back to 1 after (200ms).
 * Returns the per-frame gain array source; with gain at 1 and no audio it is a no-op (exact).
 */
export function showreelBedGain(q, flowing, step) {
  const target = flowing ? 0 : 1
  if (q.gain < target) q.gain = Math.min(target, q.gain + step)
  else if (q.gain > target) q.gain = Math.max(target, q.gain - step)
  return q.gain
}
