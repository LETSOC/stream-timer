/**
 * Mac load alert (app only, read-only): on when the 1-min load average is over 4 or the capture
 * encoder runs under 0.95x for ~30s; off again only after ~30s calm (load under 3.5 and speed 0.98x+).
 * While on, the desk hides its /stream previews and multiview players (manual "show anyway").
 * Changes nothing about capture, ffmpeg or the relay.
 */
export const LOAD_ON = 4
export const LOAD_OFF = 3.5
export const SPEED_ON = 0.95
export const SPEED_OFF = 0.98
export const SUSTAIN_MS = 30_000

export type LoadAlertState = { on: boolean; since: number | null; hotSince: number | null; coolSince: number | null; reason: string }
export const initialLoadAlert = (): LoadAlertState => ({ on: false, since: null, hotSince: null, coolSince: null, reason: "" })

/** Pure: one sample (1-min load, encoder speed or null when capture isn't running) → next state. */
export function stepLoadAlert(s: LoadAlertState, sample: { load: number; speed: number | null }, now: number): { state: LoadAlertState; changed: "on" | "off" | null } {
  const { load, speed } = sample
  const hot = load > LOAD_ON || (speed !== null && speed < SPEED_ON)
  const cool = load < LOAD_OFF && (speed === null || speed >= SPEED_OFF)
  const why = [load > LOAD_ON ? `load ${load.toFixed(2)} > ${LOAD_ON}` : "", speed !== null && speed < SPEED_ON ? `encoder ${speed.toFixed(2)}x < ${SPEED_ON}x` : ""].filter(Boolean).join(", ")
  if (!s.on) {
    const hotSince = hot ? (s.hotSince ?? now) : null
    if (hot && hotSince !== null && now - hotSince >= SUSTAIN_MS) return { state: { on: true, since: now, hotSince: null, coolSince: null, reason: why }, changed: "on" }
    return { state: { ...s, hotSince }, changed: null }
  }
  const coolSince = cool ? (s.coolSince ?? now) : null
  if (cool && coolSince !== null && now - coolSince >= SUSTAIN_MS) return { state: initialLoadAlert(), changed: "off" }
  return { state: { ...s, coolSince, reason: hot ? why : s.reason }, changed: null }
}

const g = globalThis as { __loadAlert?: LoadAlertState }
export function loadAlertSnapshot(): { on: boolean; since: number | null; reason: string } {
  const s = g.__loadAlert ?? initialLoadAlert()
  return { on: s.on, since: s.since, reason: s.reason }
}
/** Server: feed one sample; returns what changed (for the dropout log). */
export function noteLoadSample(sample: { load: number; speed: number | null }, now = Date.now()) {
  const r = stepLoadAlert(g.__loadAlert ?? initialLoadAlert(), sample, now)
  g.__loadAlert = r.state
  return r
}

/** Client: previews hidden while the alert is on, unless the operator chose "show anyway" for this alert. */
export function previewsPaused(alert: { on: boolean; since: number | null } | null, showAnywaySince: number | null): boolean {
  return alert?.on === true && showAnywaySince !== alert.since
}
