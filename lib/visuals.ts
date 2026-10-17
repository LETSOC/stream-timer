/**
 * Visuals overlays (OBS browser sources on transparent pages): name straps (lower thirds) and the
 * social circles on their own. Pure helpers, shared by the server parser, the overlays and the decks.
 */
export const STRAP_STYLES = ["line", "block", "pill", "gradient"] as const
export type StrapStyle = (typeof STRAP_STYLES)[number]
export const STRAP_STYLE_LABEL: Record<StrapStyle, string> = { line: "Minimal line", block: "Block", pill: "Social pill", gradient: "Event gradient" }

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
  { id: "host", name: "Speaker Name", title: "Job title · Company", handle: "@onlinehyphen", platform: "instagram", style: "line" },
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

/** Where a 1920x1080 overlay sits: 96px in from the two edges of its corner. Top-right clears the 178px QR (32px margin + QR + 32px). */
export const CORNER_INSET_PX = 96
export const QR_CLEAR_TOP_PX = 32 + 178 + 32
export function cornerOffsets(corner: Corner): { left?: number; right?: number; top?: number; bottom?: number } {
  switch (corner) {
    case "bottom-left":
      return { left: CORNER_INSET_PX, bottom: CORNER_INSET_PX }
    case "top-left":
      return { left: CORNER_INSET_PX, top: CORNER_INSET_PX }
    case "bottom-right":
      return { right: CORNER_INSET_PX, bottom: CORNER_INSET_PX }
    case "top-right":
      return { right: CORNER_INSET_PX, top: Math.max(CORNER_INSET_PX, QR_CLEAR_TOP_PX) }
  }
}
