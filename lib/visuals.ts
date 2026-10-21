/**
 * Visuals overlays (OBS browser sources on transparent pages): name straps (lower thirds) and the
 * social circles on their own. Pure helpers, shared by the server parser, the overlays and the decks.
 */
export const STRAP_STYLES = ["house", "line", "block", "pill", "gradient"] as const
export type StrapStyle = (typeof STRAP_STYLES)[number]
export const STRAP_STYLE_LABEL: Record<StrapStyle, string> = { house: "House (blue + orange)", line: "Minimal line", block: "Block", pill: "Social pill", gradient: "Event gradient" }

export const STRAP_MOTIONS = ["slide-left", "slide-up", "wipe"] as const
export type StrapMotion = (typeof STRAP_MOTIONS)[number]
export const STRAP_MOTION_LABEL: Record<StrapMotion, string> = { "slide-left": "Slide left", "slide-up": "Slide up", wipe: "Wipe" }

export const PLATFORMS = ["instagram", "x", "linkedin", "youtube", "tiktok", "web", "none"] as const
export type Platform = (typeof PLATFORMS)[number]
export const PLATFORM_LABEL: Record<Platform, string> = { instagram: "Instagram", x: "X", linkedin: "LinkedIn", youtube: "YouTube", tiktok: "TikTok", web: "Web", none: "No icon" }

export const CORNERS = ["bottom-left", "top-left", "top-right", "bottom-right"] as const
export type Corner = (typeof CORNERS)[number]
export const CORNER_LABEL: Record<Corner, string> = { "bottom-left": "Bottom left", "top-left": "Top left", "top-right": "Top right", "bottom-right": "Bottom right" }

export const STRAP_MODES = ["out", "in", "loop"] as const
export type StrapMode = (typeof STRAP_MODES)[number]

export type StrapPreset = { id: string; name: string; title: string; handle: string; platform: Platform; style: StrapStyle }

/** Motion timing (ms). In 0.68s cubic-bezier(.16,1,.3,1), out 0.48s. */
export const STRAP_IN_MS = 680
export const STRAP_OUT_MS = 480
/** LOOP: gap off-screen between passes. */
export const STRAP_LOOP_GAP_MS = 4000
export const STRAP_HOLD_RANGE = { min: 3, max: 10 } as const
export const STRAP_MAX = 24
const FIELD_MAX = 120

export const DEFAULT_STRAPS: StrapPreset[] = [
  { id: "host", name: "Speaker Name", title: "Job title · Company", handle: "@onlinehyphen", platform: "instagram", style: "house" },
]

const pick = <T extends string>(list: readonly T[], value: unknown, fallback: T): T => (list.includes(value as T) ? (value as T) : fallback)
export const parseStrapStyle = (v: unknown, f: StrapStyle = "line") => pick(STRAP_STYLES, v, f)
export const parseStrapMotion = (v: unknown, f: StrapMotion = "slide-left") => pick(STRAP_MOTIONS, v, f)
export const parseCorner = (v: unknown, f: Corner = "bottom-left") => pick(CORNERS, v, f)
export const parseStrapMode = (v: unknown, f: StrapMode = "out") => pick(STRAP_MODES, v, f)
export const parsePlatform = (v: unknown, f: Platform = "none") => pick(PLATFORMS, v, f)

export function clampHold(value: unknown, fallback = 5): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(STRAP_HOLD_RANGE.max, Math.max(STRAP_HOLD_RANGE.min, n)) * 2) / 2
}

const str = (v: unknown) => (typeof v === "string" ? v.slice(0, FIELD_MAX) : "")

/** Up to 24 presets with unique safe ids; a preset needs at least a name or title. */
export function sanitizeStraps(value: unknown): StrapPreset[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: StrapPreset[] = []
  for (const item of value.slice(0, STRAP_MAX)) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
    const name = str(r.name)
    const title = str(r.title)
    if (!name.trim() && !title.trim()) continue
    let id = typeof r.id === "string" ? r.id.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) : ""
    if (!id || seen.has(id)) id = `s${out.length + 1}-${Math.abs(hash(name + title)).toString(36)}`
    while (seen.has(id)) id += "x"
    seen.add(id)
    out.push({ id, name, title, handle: str(r.handle), platform: parsePlatform(r.platform), style: parseStrapStyle(r.style) })
  }
  return out
}

function hash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

export function newStrapId(now = Date.now(), random = Math.random()) {
  return `s${now.toString(36)}${Math.floor(random * 1296).toString(36)}`
}

/**
 * Is the strap on screen (wall clock, so a reloaded OBS source lands in the right place)?
 * IN: in + hold, then it goes out by itself. LOOP: in + hold, out, gap, repeat. OUT: off.
 */
export function strapVisible(mode: StrapMode, at: number | null, holdSec: number, now: number): boolean {
  if (mode === "out" || at === null) return false
  const t = now - at
  if (t < 0) return false
  const on = STRAP_IN_MS + holdSec * 1000
  if (mode === "in") return t < on
  const cycle = on + STRAP_OUT_MS + STRAP_LOOP_GAP_MS
  return t % cycle < on
}

/**
 * Safe zone = the desk preview's "Safe zone" aid (dashed lime box, `inset: 5%`). Overlays sit with their
 * outer edge exactly on that line: 5% of 1920 = 96px from left/right, 5% of 1080 = 54px from top/bottom.
 * `inset` (desk › Visuals, default 0) pushes them further in by that many px @1080p, on both axes.
 */
export const SAFE_ZONE_PCT = 5
export const SAFE_X_PX = (1920 * SAFE_ZONE_PCT) / 100
export const SAFE_Y_PX = (1080 * SAFE_ZONE_PCT) / 100
export const OVERLAY_INSET_RANGE = { min: 0, max: 64 } as const
export function clampInset(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(OVERLAY_INSET_RANGE.max, Math.max(OVERLAY_INSET_RANGE.min, n)))
}
export function cornerOffsets(corner: Corner, inset = 0): { left?: number; right?: number; top?: number; bottom?: number } {
  const x = SAFE_X_PX + clampInset(inset)
  const y = SAFE_Y_PX + clampInset(inset)
  return {
    ...(corner.endsWith("right") ? { right: x } : { left: x }),
    ...(corner.startsWith("top") ? { top: y } : { bottom: y }),
  }
}

// ---------- Visuals layer (on /stream and /overlay/visuals): talk-ends pill, ticker, Q&A, Sponsored ----------

export const TALK_MODES = ["session", "festival"] as const
export type TalkMode = (typeof TALK_MODES)[number]
export const TICKER_TYPES = ["planner", "social"] as const
export type TickerType = (typeof TICKER_TYPES)[number]
export const TALK_MAX_SEC = 4 * 3600
export const TICKER_ITEMS_MAX = 20
export const VISUAL_TEXT_MAX = 120
export const parseTalkMode = (v: unknown, f: TalkMode = "session") => pick(TALK_MODES, v, f)
export const parseTickerType = (v: unknown, f: TickerType = "planner") => pick(TICKER_TYPES, v, f)

/** Plain one-line text for a pill (no newlines), max 120 chars. */
export function visualText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  return value.replace(/\s+/g, " ").trim().slice(0, VISUAL_TEXT_MAX)
}

/** Ticker lines: array or newline text, trimmed, empties dropped, up to 20 × 120 chars. */
export function sanitizeTickerItems(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : []
  return list.map((x) => visualText(x, "")).filter(Boolean).slice(0, TICKER_ITEMS_MAX)
}

/**
 * Manual per-talk timer (deck): running = endsAt set; paused = pausedMs (ms left) set; stopped = both null.
 * Wall clock, so a reloaded /stream or OBS source lands on the same second.
 */
export type TalkTimer = { endsAt: number | null; pausedMs: number | null }
export const TALK_STOPPED: TalkTimer = { endsAt: null, pausedMs: null }

const clampSec = (sec: number) => Math.min(TALK_MAX_SEC, Math.max(0, Math.round(sec)))

/** ms left (0 when over), or null when stopped. */
export function talkRemainingMs(t: TalkTimer, now: number): number | null {
  if (t.pausedMs !== null) return Math.max(0, t.pausedMs)
  if (t.endsAt !== null) return Math.max(0, t.endsAt - now)
  return null
}
export function talkStart(durationSec: number, now: number): TalkTimer {
  return { endsAt: now + clampSec(durationSec) * 1000, pausedMs: null }
}
/** +1 / -1 min etc. Running or paused; never below 0, never above 4h. Stopped: no-op. */
export function talkAdjust(t: TalkTimer, deltaSec: number, now: number): TalkTimer {
  const left = talkRemainingMs(t, now)
  if (left === null) return t
  const next = Math.min(TALK_MAX_SEC * 1000, Math.max(0, left + Math.round(deltaSec) * 1000))
  return t.pausedMs !== null ? { endsAt: null, pausedMs: next } : { endsAt: now + next, pausedMs: null }
}
export function talkPause(t: TalkTimer, now: number): TalkTimer {
  const left = talkRemainingMs(t, now)
  return left === null || t.pausedMs !== null ? t : { endsAt: null, pausedMs: left }
}
export function talkResume(t: TalkTimer, now: number): TalkTimer {
  return t.pausedMs === null ? t : { endsAt: now + t.pausedMs, pausedMs: null }
}
/** Validated timer from stored values (junk = stopped). */
export function parseTalkTimer(endsAt: unknown, pausedMs: unknown): TalkTimer {
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v)
  if (ok(pausedMs)) return { endsAt: null, pausedMs: Math.min(TALK_MAX_SEC * 1000, Math.max(0, Math.round(pausedMs as number))) }
  if (ok(endsAt)) return { endsAt: Math.round(endsAt as number), pausedMs: null }
  return TALK_STOPPED
}

/** 754000 → "12:34"; over an hour "1:02:03". Rounds up so it shows 0:00 only at the end. */
export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "--:--"
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

/** What the talk-ends pill shows: Session = manual timer; Festival = to the event end. */
export function talkPillValue(mode: TalkMode, timer: TalkTimer, eventEndMs: number | null, now: number): { ms: number | null; over: boolean } {
  const ms = mode === "festival" ? (eventEndMs === null || !Number.isFinite(eventEndMs) ? null : Math.max(0, eventEndMs - now)) : talkRemainingMs(timer, now)
  return { ms, over: ms === 0 }
}

/** Ticker bar height px @1080p; bottom overlays lift above it while it shows. */
export const TICKER_H_PX = 48
export const TICKER_GAP_PX = 16
