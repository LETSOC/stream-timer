/**
 * /stream page side of the Main↔Backup audio crossfade (OBS Browser Source, viewer tabs). Each program
 * <video> goes through one GainNode, ramped on the AudioContext clock (equal-power curve). Never on the
 * capture page (its audio tap owns the element) and only once WebAudio is running; otherwise Hard cut.
 */
export const XFADE_MIN_MS = 100
export const XFADE_MAX_MS = 1000
export const XFADE_DEFAULT_MS = 250

/** 0 = Hard cut; anything else clamped to 100–1000 ms. */
export function crossfadeMsOf(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(Math.min(XFADE_MAX_MS, Math.max(XFADE_MIN_MS, n)))
}

/** Equal-power gain curve from the current gain to 1 (in) or 0 (out). Returns the curve and its share of the full fade. */
export function equalPowerCurve(current: number, dir: "in" | "out", steps = 64): { curve: Float32Array; share: number } {
  const c = Math.min(1, Math.max(0, current))
  // Progress g where this gain sits on the curve: in = sin(gπ/2), out = cos(gπ/2).
  const g0 = dir === "in" ? (Math.asin(c) * 2) / Math.PI : (Math.acos(c) * 2) / Math.PI
  const share = Math.max(0, 1 - g0)
  const curve = new Float32Array(steps)
  for (let i = 0; i < steps; i++) {
    const g = g0 + (share * i) / (steps - 1)
    curve[i] = dir === "in" ? Math.sin((g * Math.PI) / 2) : Math.cos((g * Math.PI) / 2)
  }
  return { curve, share }
}

/** Page fade only with crossfade on, the old input healthy (has audio) and both elements routed. */
export function pageShouldFade(i: { ms: number; outAlive: boolean; outRouted: boolean; inRouted: boolean }): boolean {
  return crossfadeMsOf(i.ms) > 0 && i.outAlive && i.outRouted && i.inRouted
}

type Slot = { el: HTMLVideoElement; gain: GainNode }
const slots = new Map<string, Slot>()
let ctx: AudioContext | null = null

function audioCtx(): AudioContext | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return null
  if (!ctx) {
    try { ctx = new AudioContext() } catch { return null }
    const wake = () => { void ctx?.resume() }
    window.addEventListener("pointerdown", wake, { passive: true })
    window.addEventListener("keydown", wake)
  }
  return ctx
}

/** Route this input's element through its GainNode (once). No-op until WebAudio runs. */
export function routeProgramAudio(source: string, el: HTMLVideoElement): boolean {
  const cur = slots.get(source)
  if (cur && cur.el === el) return true
  const c = audioCtx()
  if (!c || c.state !== "running") return false
  try {
    const gain = c.createGain()
    c.createMediaElementSource(el).connect(gain)
    gain.connect(c.destination)
    slots.set(source, { el, gain })
    return true
  } catch { return false }
}
export const programAudioRouted = (source: string) => slots.has(source) && ctx?.state === "running"

/** Ramp one input's gain in or out over ms, on the audio clock, from wherever it is now. */
export function rampProgramAudio(source: string, dir: "in" | "out", ms: number, from?: number) {
  const s = slots.get(source)
  if (!s || !ctx) return
  const t = ctx.currentTime
  const g = s.gain.gain
  hold(g, t)
  if (from !== undefined) g.setValueAtTime(from, t)
  const now = from ?? g.value
  const { curve, share } = equalPowerCurve(now, dir)
  const dur = (crossfadeMsOf(ms) / 1000) * share
  try {
    if (dur <= 0.005) throw new Error("short")
    g.setValueCurveAtTime(curve, t, dur)
  } catch { g.setValueAtTime(dir === "in" ? 1 : 0, t) }
}
/** Hard cut / end of a fade: this input at full level (its <video>.muted decides the rest). */
export function resetProgramAudio(source: string) {
  const s = slots.get(source)
  if (!s || !ctx) return
  hold(s.gain.gain, ctx.currentTime)
  s.gain.gain.setValueAtTime(1, ctx.currentTime)
}
/** Stop a running curve where it is (a mid-fade re-switch continues from here). */
function hold(g: AudioParam, t: number) {
  const v = g.value
  const p = g as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam }
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t)
  else { g.cancelScheduledValues(0); g.setValueAtTime(v, t) }
}
