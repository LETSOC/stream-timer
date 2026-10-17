/**
 * Social circle spotlight (ported from agent-forge lib/social-spotlight.ts + the Hyphen "Social Circles" artifact):
 * each circle is spotlit for `dwellMs` in turn, then all rest for `cooldownMs`, and the cycle repeats.
 * Driven by the wall clock so /stream, the desk preview and capture all show the same circle.
 */
export const SOCIAL_DWELL_MS = 2800
export const SOCIAL_COOLDOWN_MS = 4000

export type Spotlight = {
  /** index of the spotlit circle, or null during cooldown */
  active: number | null
  cooling: boolean
  /** 0..1 through the active circle's dwell (drives the progress stroke) */
  progress: number
  /** increments every activation, so CSS animations can restart via `key` */
  step: number
}

export function socialSpotlight(nowMs: number, count: number, dwellMs = SOCIAL_DWELL_MS, cooldownMs = SOCIAL_COOLDOWN_MS): Spotlight {
  const dwell = Math.max(1, dwellMs)
  const cool = Math.max(0, cooldownMs)
  if (count <= 0) return { active: null, cooling: false, progress: 0, step: 0 }
  if (count === 1) {
    const step = Math.floor(nowMs / dwell)
    return { active: 0, cooling: false, progress: (nowMs - step * dwell) / dwell, step }
  }
  const cycle = count * dwell + cool
  const n = Math.floor(nowMs / cycle)
  const t = nowMs - n * cycle
  if (t >= count * dwell) return { active: null, cooling: true, progress: 0, step: n * (count + 1) + count }
  const active = Math.floor(t / dwell)
  return { active, cooling: false, progress: (t - active * dwell) / dwell, step: n * (count + 1) + active }
}

/** "x.com/hyphenfest" from a URL (host without www + path, no trailing slash). */
export function socialHandle(href: string): string {
  try {
    const u = new URL(href)
    const path = u.pathname.replace(/\/+$/, "")
    return `${u.hostname.replace(/^www\./, "")}${path}`
  } catch {
    return href.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "")
  }
}
