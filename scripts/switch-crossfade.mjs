/**
 * Main↔Backup audio crossfade (capture mix). Pure helpers, no I/O: scripts/capture-stream.mjs owns the
 * readers. 0 ms = Hard cut (today's path). Equal-power: in = sin(g·π/2), out = cos(g·π/2).
 */
export const XFADE_MIN_MS = 100
export const XFADE_MAX_MS = 1000
export const XFADE_HINT_MS = 150

/** 0 = Hard cut; anything else clamped to 100–1000 ms. */
export function crossfadeMsOf(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(Math.min(XFADE_MAX_MS, Math.max(XFADE_MIN_MS, n)))
}

/** Equal-power gains at progress g (0…1). */
export function equalPower(g) {
  const x = Math.min(1, Math.max(0, g))
  return { gin: Math.sin((x * Math.PI) / 2), gout: Math.cos((x * Math.PI) / 2) }
}

/** Fade only when crossfade is on and BOTH inputs have audio queued; otherwise Hard cut. */
export function shouldCrossfade({ ms, outBytes, inBytes }) {
  return crossfadeMsOf(ms) > 0 && outBytes > 0 && inBytes > 0
}

/** New fade over `ms`. `fromG` > 0 continues a fade that was reversed mid-way (no jump in level). */
export function newFade(ms, rate, fromG = 0) {
  const total = Math.max(1, Math.round((crossfadeMsOf(ms) / 1000) * rate))
  return { total, pos: Math.round(Math.min(1, Math.max(0, fromG)) * total) }
}
export const fadeProgress = (f) => Math.min(1, f.pos / f.total)

/**
 * Mid-fade re-switch (always back to the outgoing input: there are only two). The outgoing input becomes
 * the incoming one, starting at the level it has now: cos(g) = sin(1−g), so the new g = 1 − g.
 */
export function reverseFade(f) {
  return { total: f.total, pos: f.total - Math.min(f.pos, f.total) }
}

/**
 * Mix n s16 stereo frames: incoming·sin + outgoing·cos, advancing the fade. inBuf/outBuf may be null
 * (silence). Returns { buf, done }.
 */
export function mixCrossfade(inBuf, outBuf, f, n) {
  const out = Buffer.alloc(n * 4)
  for (let i = 0; i < n; i++) {
    const { gin, gout } = equalPower(f.pos / f.total)
    if (f.pos < f.total) f.pos += 1
    for (let c = 0; c < 2; c++) {
      const a = inBuf ? inBuf.readInt16LE(i * 4 + c * 2) : 0
      const b = outBuf ? outBuf.readInt16LE(i * 4 + c * 2) : 0
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a * gin + b * gout))), i * 4 + c * 2)
    }
  }
  return { buf: out, done: f.pos >= f.total }
}

/** Terminal + dropout-log line for every switch. deltaMs = incoming delay − outgoing delay. */
export function switchLine({ ms, faded, deltaMs, to }) {
  const d = deltaMs === null || !Number.isFinite(deltaMs) ? "delta n/a" : `delta ${Math.round(deltaMs)}ms`
  const mode = faded ? `crossfade ${ms}ms` : ms > 0 ? "hard cut (crossfade skipped: an input has no audio queued)" : "hard cut"
  const hint = deltaMs !== null && Math.abs(deltaMs) > XFADE_HINT_MS ? ` — over ${XFADE_HINT_MS}ms: tighten the per-input offset trim, or you will hear both mixes` : ""
  return `[switch] ${mode}, ${d} → ${to}${hint}`
}
