/** Pure helpers for the phone Visuals deck (/visuals). */
import { parseTalkTimer, strapVisible, talkPillValue, TALK_MAX_SEC, type StrapMode, type TalkMode } from "@/lib/visuals"

export const TALK_PRESETS_MIN = [10, 15, 20, 30, 45] as const

/** Prev/Next speaker: wraps; no current pick → first (next) or last (prev). */
export function stepStrap(ids: readonly string[], current: string, dir: 1 | -1): string | null {
  if (!ids.length) return null
  const i = ids.indexOf(current)
  if (i < 0) return dir === 1 ? ids[0] : ids[ids.length - 1]
  return ids[(i + dir + ids.length) % ids.length]
}

/** Custom duration: "25" (min), "25:30" (min:sec) or "1:05:00" (h:m:s) → seconds; null if invalid, 0 or over 4h. */
export function parseDuration(input: string): number | null {
  const parts = input.trim().split(":")
  if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null
  const n = parts.map(Number)
  const sec = parts.length === 1 ? n[0] * 60 : parts.length === 2 ? n[0] * 60 + n[1] : n[0] * 3600 + n[1] * 60 + n[2]
  return sec > 0 && sec <= TALK_MAX_SEC ? sec : null
}

export type DeckVisuals = {
  straps: { id: string }[]
  strapId: string
  strapMode: StrapMode
  strapAt: number | null
  strapHoldSec: number
  socialsOverlay: boolean
  streamVisuals?: boolean
  talkVisible?: boolean
  talkMode?: TalkMode
  talkEndsAt?: number | null
  talkPausedMs?: number | null
  tickerVisible?: boolean
  tickerCount?: number
  qaVisible?: boolean
  sponsorVisible?: boolean
}

/** Status lights per row: on air now (what /stream shows if the layer is on). */
export function deckLights(v: DeckVisuals, now: number) {
  return {
    strap: v.straps.some((p) => p.id === v.strapId) && strapVisible(v.strapMode, v.strapAt, v.strapHoldSec, now),
    talk: v.talkVisible === true,
    ticker: v.tickerVisible === true && (v.tickerCount ?? 0) > 0,
    qa: v.qaVisible === true,
    sponsor: v.sponsorVisible === true,
    socials: v.socialsOverlay === true,
    layer: v.streamVisuals !== false,
  }
}

/** Talk timer readout on the deck (Session only; Festival = event end, shown as "event end"). */
export function talkReadout(v: DeckVisuals, now: number): { ms: number | null; state: "stopped" | "running" | "paused" | "over" } {
  const t = parseTalkTimer(v.talkEndsAt ?? null, v.talkPausedMs ?? null)
  const { ms, over } = talkPillValue("session", t, null, now)
  return { ms, state: ms === null ? "stopped" : over ? "over" : t.pausedMs !== null ? "paused" : "running" }
}
