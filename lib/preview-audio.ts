/**
 * Preview audio state (pure). The mute choice belongs to the operator, per player ("scope"): saved per
 * device, and only `toggle`, `volume` and `hidden` change it. Source switches, remounts and the
 * WebRTC→HLS swap never do.
 */
export type AudioPref = { muted: boolean; volume: number }
export const DEFAULT_PREF: AudioPref = { muted: true, volume: 0.8 }
export type AudioEvent = { type: "toggle" } | { type: "volume"; volume: number } | { type: "hidden" } | { type: "source-switch" } | { type: "remount" } | { type: "swap" }

export function nextPref(pref: AudioPref, e: AudioEvent): AudioPref {
  switch (e.type) {
    case "toggle": return { ...pref, muted: !pref.muted }
    case "volume": return { ...pref, volume: Math.min(1, Math.max(0, e.volume)) }
    // Background/standby/other app: silence, and stay silent until the operator taps Unmute.
    case "hidden": return pref.muted ? pref : { ...pref, muted: true }
    default: return pref
  }
}

/** The element is audible only if it's the one with audio, sound is on (after a gesture) and the page is visible. */
export function elementMuted(input: { pref: AudioPref; audioOn: boolean; audioElement: boolean; pageVisible: boolean }): boolean {
  return !(input.audioElement && input.audioOn && !input.pref.muted && input.pageVisible)
}

export function parsePref(raw: unknown): AudioPref {
  const r = raw as Partial<AudioPref> | null
  return r && typeof r.muted === "boolean" && typeof r.volume === "number" ? { muted: r.muted, volume: Math.min(1, Math.max(0, r.volume)) } : DEFAULT_PREF
}
