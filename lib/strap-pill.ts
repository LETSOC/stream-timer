/**
 * Social pill name strap: extra layout options (builder › Name strap › Design › Social pill).
 * Stored as StrapDesign.pill; absent = the classic pill exactly as before (live dot, icon, two lines).
 * Every number is px at 1920x1080 (× --px, so it scales with the name size like the rest of the strap).
 */
export const PILL_LAYOUTS = ["stack", "inline"] as const
export type PillLayout = (typeof PILL_LAYOUTS)[number]
export const PILL_LAYOUT_LABEL: Record<PillLayout, string> = { stack: "Two lines", inline: "One line" }

export const PILL_ORDERS = ["auto", "dot-icon-text", "icon-dot-text", "icon-text-dot", "dot-text-icon"] as const
export type PillOrder = (typeof PILL_ORDERS)[number]
export const PILL_ORDER_LABEL: Record<PillOrder, string> = { auto: "Auto", "dot-icon-text": "Dot · Icon · Text", "icon-dot-text": "Icon · Dot · Text", "icon-text-dot": "Icon · Text · Dot", "dot-text-icon": "Dot · Text · Icon" }

export const PILL_ICON_MODES = ["inline", "full"] as const
export type PillIconMode = (typeof PILL_ICON_MODES)[number]
export const PILL_ICON_MODE_LABEL: Record<PillIconMode, string> = { inline: "Inline", full: "Full-bleed" }

export const PILL_BOXES = ["solid", "glass", "outline"] as const
export type PillBox = (typeof PILL_BOXES)[number]
export const PILL_BOX_LABEL: Record<PillBox, string> = { solid: "Solid", glass: "Glass · blur", outline: "Outline" }

export const PILL_NUMS = ["padY", "padX", "gap", "lineGap", "iconSize", "iconInset", "dotSize", "border", "blur"] as const
export type PillNum = (typeof PILL_NUMS)[number]
export const PILL_NUM_LABEL: Record<PillNum, string> = { padY: "Padding Y", padX: "Padding X", gap: "Gap", lineGap: "Line gap", iconSize: "Icon size (inline)", iconInset: "Icon inset (full-bleed)", dotSize: "Live dot size", border: "Border", blur: "Blur (glass)" }
export const PILL_NUM_RANGE: Record<PillNum, { min: number; max: number }> = {
  padY: { min: 4, max: 48 }, padX: { min: 8, max: 80 }, gap: { min: 0, max: 48 }, lineGap: { min: 0, max: 24 },
  iconSize: { min: 24, max: 140 }, iconInset: { min: 0, max: 16 }, dotSize: { min: 6, max: 40 }, border: { min: 0, max: 10 }, blur: { min: 0, max: 40 },
}

export type PillDesign = {
  layout: PillLayout
  order: PillOrder
  icon: PillIconMode
  box: PillBox
  /** hide the handle / title line (name only) */
  hideSub: boolean
} & Record<PillNum, number>

/** = the classic pill's CSS (globals.css .strap-pill), so turning the options on changes nothing until edited. */
export const DEFAULT_PILL: PillDesign = { layout: "stack", order: "auto", icon: "inline", box: "solid", hideSub: false, padY: 16, padX: 32, gap: 18, lineGap: 4, iconSize: 72, iconInset: 0, dotSize: 16, border: 2, blur: 16 }

const pick = <T extends string>(list: readonly T[], v: unknown, fb: T): T => (list.includes(v as T) ? (v as T) : fb)
function num(v: unknown, r: { min: number; max: number }, fb: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.round(Math.min(r.max, Math.max(r.min, n))) : fb
}

/** Junk-tolerant; undefined when there is nothing to parse (classic pill). */
export function parsePillDesign(value: unknown): PillDesign | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const r = value as Record<string, unknown>
  const out = {
    layout: pick(PILL_LAYOUTS, r.layout, DEFAULT_PILL.layout),
    order: pick(PILL_ORDERS, r.order, DEFAULT_PILL.order),
    icon: pick(PILL_ICON_MODES, r.icon, DEFAULT_PILL.icon),
    box: pick(PILL_BOXES, r.box, DEFAULT_PILL.box),
    hideSub: r.hideSub === true,
  } as PillDesign
  for (const k of PILL_NUMS) out[k] = num(r[k], PILL_NUM_RANGE[k], DEFAULT_PILL[k])
  return out
}

export type PillPart = "dot" | "icon" | "text"
/** Draw order with hidden parts dropped. Auto = Dot · Icon · Text (inline icon) or Icon · Dot · Text (full-bleed). */
export function pillOrder(p: Pick<PillDesign, "order" | "icon">, show: { dot: boolean; icon: boolean }): PillPart[] {
  const key = p.order === "auto" ? (p.icon === "full" ? "icon-dot-text" : "dot-icon-text") : p.order
  return (key.split("-") as PillPart[]).filter((x) => (x === "dot" ? show.dot : x === "icon" ? show.icon : true))
}

/** Where the icon ends up: full-bleed hugs that side of the pill (inset padding instead of Padding X). */
export function pillIconSide(parts: PillPart[]): "first" | "last" | "mid" | "none" {
  if (!parts.includes("icon")) return "none"
  return parts[0] === "icon" ? "first" : parts[parts.length - 1] === "icon" ? "last" : "mid"
}

/** Body padding (px @1080p, top right bottom left). */
export function pillPadding(p: PillDesign, side: ReturnType<typeof pillIconSide>): [number, number, number, number] {
  if (p.icon !== "full" || side === "none") return [p.padY, p.padX, p.padY, p.padX]
  const i = p.iconInset
  return [i, side === "last" ? i : p.padX, i, side === "first" ? i : p.padX]
}
