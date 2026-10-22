/**
 * Visuals layout (builder › Save): where each overlay part sits, separately for the countdown screen and
 * for program. Pure: shared by the stage parser, the layer on /stream and the builder.
 *
 * Each part: corner, snap (safe = the 5% safe-zone line, edge = 32px from the frame), X/Y gap in from that
 * line (px @1080p) and size (% of the designed size). On program, the strap and socials corners stay
 * on the deck's corner buttons (live): the layout gives them snap, gap and size only.
 */
import { CORNERS, SAFE_X_PX, SAFE_Y_PX, type Corner } from "@/lib/visuals"

export const LAYOUT_PARTS = ["strap", "talk", "qa", "sponsor", "socials", "logo1", "logo2", "logo3", "logo4", "logo5", "qr", "qrLogo"] as const
export type LayoutPart = (typeof LAYOUT_PARTS)[number]
export const LAYOUT_PART_LABEL: Record<LayoutPart, string> = { strap: "Name strap", talk: "Talk timer pill", qa: "Q&A pill", sponsor: "Sponsored pill", socials: "Social circles", logo1: "Logo 1 · Large square", logo2: "Logo 2 · Large circle", logo3: "Logo 3 · Small square", logo4: "Logo 4 · Small circle", logo5: "Logo 5 · Wordmark", qr: "QR (animated)", qrLogo: "Logo QR" }
export const LAYOUT_SCREENS = ["countdown", "program"] as const
export type LayoutScreen = (typeof LAYOUT_SCREENS)[number]
export const SNAPS = ["safe", "edge"] as const
export type Snap = (typeof SNAPS)[number]
/** Edge snap: this far from the frame (same 32px margin as the countdown stage). */
export const EDGE_PX = 32
export const GAP_X_RANGE = { min: 0, max: 900 } as const
export const GAP_Y_RANGE = { min: 0, max: 500 } as const
export const SIZE_RANGE = { min: 50, max: 200 } as const

export type PartPlace = { corner: Corner; snap: Snap; dx: number; dy: number; size: number }
export type ScreenLayout = Record<LayoutPart, PartPlace>
export type VisualsLayout = Record<LayoutScreen, ScreenLayout>

const place = (corner: Corner, dx = 0, dy = 0, size = 100, snap: Snap = "safe"): PartPlace => ({ corner, snap, dx, dy, size })

/**
 * Countdown defaults keep clear of the countdown screen (1920x1080): the left column (badge line
 * "LIVE COUNTDOWN" from y=96, social icons at the bottom of the column), the rolling QR top-right
 * (x 1710–1888, y 32–~250) and the speaker gallery mid-right.
 *  - talk pill, Sponsored, Q&A: top-right, to the left of the QR, stacked (above the logo)
 *  - strap: bottom-right at 90%, under the gallery link (not over the social icons bottom-left)
 */
export const DEFAULT_LAYOUT: VisualsLayout = {
  countdown: {
    talk: place("top-right", 150, 0),
    sponsor: place("top-right", 150, 84),
    qa: place("top-right", 150, 168),
    strap: place("bottom-right", 0, 0, 90),
    socials: place("bottom-right", 0, 0),
    // Logos: the free slot bottom-middle (right of the social icons, left of the strap).
    logo1: place("bottom-left", 720, 0),
    logo2: place("bottom-left", 720, 0),
    logo3: place("bottom-left", 720, 0),
    logo4: place("bottom-left", 720, 0),
    logo5: place("bottom-left", 720, 0, 60),
    // QR: bottom-right between the speaker gallery and the strap, at half size.
    qr: place("bottom-right", 0, 130, 50),
    qrLogo: place("bottom-right", 100, 130, 50),
  },
  program: {
    talk: place("top-left"),
    sponsor: place("top-right"),
    qa: place("bottom-right"),
    strap: place("bottom-left"),
    socials: place("bottom-left"),
    // Design: logos/QR on the 32px edge (178 = QR safe box). Logos top-left under the talk pill,
    // animated QR top-right under the Sponsored pill, Logo QR bottom-right above the Q&A pill.
    logo1: place("top-left", 0, 90, 100, "edge"),
    logo2: place("top-left", 0, 90, 100, "edge"),
    logo3: place("top-left", 0, 90, 100, "edge"),
    logo4: place("top-left", 0, 90, 100, "edge"),
    logo5: place("top-left", 0, 90, 60, "edge"),
    qr: place("top-right", 0, 90, 100, "edge"),
    qrLogo: place("bottom-right", 0, 110, 100, "edge"),
  },
}

function num(v: unknown, range: { min: number; max: number }, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(range.max, Math.max(range.min, n)))
}

export function parsePlace(value: unknown, fallback: PartPlace): PartPlace {
  const r = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  return {
    corner: CORNERS.includes(r.corner as Corner) ? (r.corner as Corner) : fallback.corner,
    snap: SNAPS.includes(r.snap as Snap) ? (r.snap as Snap) : fallback.snap,
    dx: num(r.dx, GAP_X_RANGE, fallback.dx),
    dy: num(r.dy, GAP_Y_RANGE, fallback.dy),
    size: num(r.size, SIZE_RANGE, fallback.size),
  }
}

/** Junk-tolerant: missing screens/parts/fields fall back to the defaults. */
export function parseVisualsLayout(value: unknown): VisualsLayout {
  const r = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const screen = (s: LayoutScreen): ScreenLayout => {
    const v = r[s] && typeof r[s] === "object" ? (r[s] as Record<string, unknown>) : {}
    return Object.fromEntries(LAYOUT_PARTS.map((p) => [p, parsePlace(v[p], DEFAULT_LAYOUT[s][p])])) as ScreenLayout
  }
  return { countdown: screen("countdown"), program: screen("program") }
}

/** Which layout a layer screen uses (OBS overlay page = program). */
export function layoutScreen(screen: string): LayoutScreen {
  return screen === "countdown" ? "countdown" : "program"
}

/**
 * Absolute offsets (px @1080p) of a part's outer corner. `inset` = desk overlayInset (both axes),
 * `lift` = extra bottom offset while the ticker shows.
 */
export function placeOffsets(p: PartPlace, inset = 0, lift = 0, corner: Corner = p.corner): { left?: number; right?: number; top?: number; bottom?: number } {
  const bx = (p.snap === "edge" ? EDGE_PX : SAFE_X_PX) + inset + p.dx
  const by = (p.snap === "edge" ? EDGE_PX : SAFE_Y_PX) + inset + p.dy
  return {
    ...(corner.endsWith("right") ? { right: bx } : { left: bx }),
    ...(corner.startsWith("top") ? { top: by } : { bottom: by + lift }),
  }
}

/** CSS transform-origin for scaling a part from its anchored corner. */
export function cornerOrigin(corner: Corner): string {
  return `${corner.startsWith("top") ? "top" : "bottom"} ${corner.endsWith("right") ? "right" : "left"}`
}

/** Program strap/socials follow the deck corner buttons; everything else uses the layout corner. */
export function partCorner(screen: LayoutScreen, part: LayoutPart, layout: VisualsLayout, deck: { strapCorner: Corner; socialsCorner: Corner }): Corner {
  if (screen === "program" && part === "strap") return deck.strapCorner
  if (screen === "program" && part === "socials") return deck.socialsCorner
  return layout[screen][part].corner
}

/** Axis-aligned box overlap (used by tests to keep the countdown defaults clear). */
export type Box = { x: number; y: number; w: number; h: number }
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
