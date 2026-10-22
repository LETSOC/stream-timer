/**
 * Visuals assets from the Hyphen component system (user's design export): logos 1–5, QR codes
 * (plain/animated + Logo QR) and the extra full-screen scene cards. Pure: shared by the stage
 * parser, the /stream layer, the builder and the deck.
 *
 * Logos and pasted SVG are never injected as HTML: they render as <img src="data:image/svg+xml,…">
 * (no script can run, no external fetch) and pasted SVG is also sanitised before it is stored.
 */
import QRCode from "qrcode"

export const LOGO_IDS = ["logo1", "logo2", "logo3", "logo4", "logo5"] as const
export type LogoId = (typeof LOGO_IDS)[number]
export const LOGO_LABEL: Record<LogoId, string> = {
  logo1: "Logo 1 · Large square",
  logo2: "Logo 2 · Large circle",
  logo3: "Logo 3 · Small square",
  logo4: "Logo 4 · Small circle",
  logo5: "Logo 5 · Solo wordmark",
}
/** Designed size px @1080p at 100% (178 = the QR safe box; wordmark 517×133). */
export const LOGO_BASE: Record<LogoId, { w: number; h: number }> = {
  logo1: { w: 178, h: 178 },
  logo2: { w: 178, h: 178 },
  logo3: { w: 178, h: 178 },
  logo4: { w: 178, h: 178 },
  logo5: { w: 517, h: 137 },
}
/** The brand orange in the built-in SVGs; Colour replaces it. */
export const LOGO_BRAND = "#ef4423"

/**
 * Built-in logos from the design file (class attributes dropped). Logo 5: the design's viewBox (69 119 517 133)
 * cropped the artwork (real bbox 43.4,99.3 → 551.9,232.6), so it is the bbox + 1px margin.
 */
export const DEFAULT_LOGO_SVG: Record<LogoId, string> = {
  logo1: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"297 252 212 212\"><rect fill=\"#ef4423\" x=\"297.64\" y=\"252.17\" width=\"211.18\" height=\"211.18\"/><rect fill=\"#010101\" x=\"462.69\" y=\"397.15\" width=\"21\" height=\"21\"/><path fill=\"#fff\" d=\"M377.2,345.12h.38c7.73-10.19,18.11-17.73,32.82-17.73,16.6,0,26.79,10.38,26.79,26.41v44.71c0,5.47,2.26,7.55,7.55,7.55h10.56v12.45h-55.08v-12.45h7.17c5.28,0,7.55-2.07,7.55-7.55v-43.2c0-9.62-6.6-13.21-16.6-13.21s-21.13,10.38-21.13,26.98v29.42c0,5.47,2.26,7.55,7.54,7.55h7.36v12.45h-55.46v-12.45h10.75c5.28,0,7.55-2.07,7.55-7.55v-93.81c0-5.47-2.26-7.55-7.55-7.55h-10.75v-12.45h40.56v60.42Z\"/></svg>",
  logo2: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"297 504 212 212\"><circle fill=\"#ef4423\" cx=\"403.23\" cy=\"609.49\" r=\"105.47\"/><rect fill=\"#010101\" x=\"462.69\" y=\"648.87\" width=\"21\" height=\"21\"/><path fill=\"#fff\" d=\"M377.2,596.85h.38c7.73-10.19,18.11-17.73,32.82-17.73,16.6,0,26.79,10.38,26.79,26.41v44.71c0,5.47,2.26,7.55,7.55,7.55h10.56v12.45h-55.08v-12.45h7.17c5.28,0,7.55-2.07,7.55-7.55v-43.2c0-9.62-6.6-13.21-16.6-13.21s-21.13,10.38-21.13,26.98v29.42c0,5.47,2.26,7.55,7.54,7.55h7.36v12.45h-55.46v-12.45h10.75c5.28,0,7.55-2.07,7.55-7.55v-93.81c0-5.47-2.26-7.55-7.55-7.55h-10.75v-12.45h40.56v60.42Z\"/></svg>",
  logo3: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"53 252 212 212\"><rect fill=\"#ef4423\" x=\"53.03\" y=\"252.17\" width=\"211.18\" height=\"211.18\"/><rect fill=\"#010101\" x=\"203.02\" y=\"384.62\" width=\"15.72\" height=\"15.72\"/><path fill=\"#fff\" d=\"M139.04,345.69h.28c5.79-7.62,13.55-13.27,24.57-13.27,12.42,0,20.05,7.76,20.05,19.76v33.46c0,4.09,1.69,5.65,5.65,5.65h7.91v9.32h-41.22v-9.32h5.36c3.95,0,5.65-1.55,5.65-5.65v-32.33c0-7.2-4.94-9.88-12.42-9.88s-15.81,7.77-15.81,20.19v22.02c0,4.09,1.69,5.65,5.65,5.65h5.51v9.32h-41.51v-9.32h8.05c3.95,0,5.65-1.55,5.65-5.65v-70.21c0-4.09-1.69-5.65-5.65-5.65h-8.05v-9.32h30.35v45.22Z\"/></svg>",
  logo4: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"53 504 212 212\"><circle fill=\"#ef4423\" cx=\"158.62\" cy=\"609.49\" r=\"105.47\"/><rect fill=\"#010101\" x=\"203.05\" y=\"636.07\" width=\"15.69\" height=\"15.69\"/><path fill=\"#fff\" d=\"M139.17,597.21h.28c5.78-7.61,13.53-13.25,24.52-13.25,12.4,0,20.01,7.75,20.01,19.73v33.4c0,4.09,1.69,5.64,5.64,5.64h7.89v9.3h-41.15v-9.3h5.36c3.95,0,5.64-1.55,5.64-5.64v-32.27c0-7.19-4.93-9.87-12.4-9.87s-15.78,7.75-15.78,20.15v21.98c0,4.09,1.69,5.64,5.64,5.64h5.5v9.3h-41.44v-9.3h8.03c3.95,0,5.64-1.55,5.64-5.64v-70.09c0-4.09-1.69-5.64-5.64-5.64h-8.03v-9.3h30.3v45.15Z\"/></svg>",
  logo5: "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"517\" height=\"137\" viewBox=\"42.36 98.34 510.53 135.23\" fill=\"none\"><path fill=\"#ef4423\" d=\"M551.89,178.89h-17.35v17.41h17.35v-17.41Z\"/><path fill=\"#010101\" d=\"M468.28,140.55h.32c5.99-9.04,14.04-14.93,25.4-14.93,12.88,0,20.77,7.78,20.77,23.56v31.55c0,4.26,1.79,5.89,8.78,5.89h4.84v9.62h-42.28v-9.62h3.52c6.15,0,7.89-1.63,7.89-5.89v-30.39c0-10.94-5.84-13.3-12.83-13.3s-16.41,7.47-16.41,16.83v26.82c0,4.26,1.79,5.89,5.84,5.89h5.73v9.62h-43.02v-9.62h8.31c4.1,0,5.84-1.63,5.84-5.89v-35.23c0-6.31-1.74-7.89-9.36-7.89h-4.79v-9.78h31.39v12.73l.05.05ZM74.88,139.34h.26c5.99-7.89,14.04-13.72,25.45-13.72,12.88,0,20.77,8.05,20.77,20.51v34.55c0,4.21,1.74,5.84,5.78,5.84h8.26v9.68h-42.7v-9.68h5.57c4.05,0,5.78-1.58,5.78-5.84v-33.44c0-7.41-5.1-10.2-12.83-10.2s-16.35,8.05-16.35,20.88v22.82c0,4.21,1.74,5.84,5.78,5.84h5.78v9.68h-43.07v-9.68h8.36c4.05,0,5.78-1.58,5.78-5.84v-65.94c0-4.21-1.74-5.84-5.78-5.84h-8.31v-9.62h31.45v40.02ZM235.43,162.01c0,16.83,7.26,25.03,17.04,25.03,8.36,0,15.09-8.68,15.09-25.03-.05-18.67-7.05-24.98-15.09-24.98-9.78,0-17.09,8.15-17.09,24.98h.05ZM234.9,139.82h.32c5.89-9.99,13.3-14.2,22.98-14.2,20.3,0,28.92,18.41,28.92,36.39s-8.62,36.39-28.92,36.39c-11.57,0-19.61-7.15-22.66-12.57h-.42v25.35c0,4.42,1.31,6.47,5.78,6.47h9.26v9.62h-46.33v-9.62h8.05c4.52,0,5.78-2.1,5.78-6.47v-67.31c0-4.36-1.26-6.42-5.78-6.42h-7.62v-9.62h30.71v11.99h-.05Z\"/><path fill=\"#010101\" d=\"M315.62,139.34h.26c5.99-7.89,14.04-13.72,25.45-13.72,12.88,0,20.77,8.05,20.77,20.51v34.55c0,4.21,1.74,5.84,5.78,5.84h8.26v9.68h-42.7v-9.68h5.57c4.05,0,5.78-1.58,5.78-5.84v-33.44c0-7.41-5.1-10.2-12.83-10.2s-16.35,8.05-16.35,20.88v22.82c0,4.21,1.74,5.84,5.78,5.84h5.78v9.68h-43.02v-9.68h8.31c4.1,0,5.89-1.58,5.89-5.84v-65.94c0-4.21-1.79-5.84-5.89-5.84h-8.31v-9.62h31.45v40.02ZM419.37,154.12c.16-9.2-2.79-18.25-13.15-18.25s-13.62,9.04-14.04,18.25h27.19ZM392.19,163.8c-.42,11.36,3.05,23.66,16.67,23.66,10.52,0,15.78-5.42,17.67-15.51h12.15c-1.89,16.67-11.99,26.45-31.45,26.45-22.61,0-34.6-12.67-34.6-36.39,0-21.35,13.67-36.39,33.87-36.39,23.98,0,34.08,21.51,32.5,38.18h-46.8ZM177.11,127.83v9.62h6.31c2.63,0,4.68,1.58,4.68,3.52-.09,1.77-.54,3.51-1.31,5.1l-12.15,29.66h-.32l-13.15-30.97c-.53-1.47-1.31-3.21-1.31-4.1,0-2.16,1.79-3.16,4.21-3.16h6.31v-9.73h-42.23v9.62c7.47,0,11.57,1.89,13.3,5.73l24.72,53.06-4.15,9.15-3.42,6.94c-2.21,4.79-5.26,8.57-10.67,9.99-5.57,1.05-8.94-.89-10.36-2,3.31-.03,6.34-1.84,7.94-4.73l.21-.37c.54-1.15.83-2.41.84-3.68v-.68c-.26-5.21-4.94-8.78-10.04-8.78-7.36,0-11.25,5.73-11.25,12.88,0,11.57,9.36,17.67,19.46,17.67,11.57,0,18.77-5.63,25.66-19.09l3.16-6.36c1.05-2.1,2.1-4.36,3.16-6.84l23.66-56.27c2.37-5.57,6.73-6.63,11.99-6.63v-9.57h-35.23Z\"/></svg>",
}

export const LOGO_SOURCES = ["default", "image", "svg"] as const
export type LogoSource = (typeof LOGO_SOURCES)[number]
export type LogoConfig = { source: LogoSource; image: string; svg: string; color: string; text: string }
export type Logos = Record<LogoId, LogoConfig>
export const DEFAULT_LOGO: LogoConfig = { source: "default", image: "", svg: "", color: LOGO_BRAND, text: "" }
export const DEFAULT_LOGOS: Logos = Object.fromEntries(LOGO_IDS.map((id) => [id, DEFAULT_LOGO])) as Logos

export const SVG_MAX = 100_000
const TEXT_MAX = 120

const hex = (v: unknown, f: string) => (typeof v === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim().toLowerCase() : f)
const line = (v: unknown, f = "") => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX) : f)

/** Uploaded images only: our own /uploads/<hash>.<ext> (operator upload, data dir). */
export function uploadPath(v: unknown): string {
  return typeof v === "string" && /^\/uploads\/[a-f0-9]{32}\.(png|jpg|webp|gif|svg|mp4)$/.test(v) ? v : ""
}

/**
 * Pasted / uploaded SVG → safe SVG text, or "" when it is not a usable SVG.
 * Drops: <script>, <foreignObject>, <iframe>/<embed>/<object>/<audio>/<video>/<style>/<image>/<use> with
 * external refs, on* handlers, javascript:, external href/xlink:href and url(...) (only #local refs stay),
 * DOCTYPE/ENTITY/processing instructions. Anything still risky after stripping → "".
 */
export function sanitizeSvg(input: unknown): string {
  if (typeof input !== "string") return ""
  let s = input.trim()
  if (!s || s.length > SVG_MAX) return ""
  s = s.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, "").replace(/<!ENTITY[\s\S]*?>/gi, "")
  for (const tag of ["script", "foreignObject", "iframe", "embed", "object", "audio", "video", "style", "handler", "listener"]) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "").replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), "")
  }
  // event handlers (quoted or bare)
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
  // href / xlink:href / src: only local #fragment refs
  s = s.replace(/\s+(xlink:href|href|src)\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi, (m, _a, _v, dq, sq) => {
    const val = (dq ?? sq ?? "").trim()
    return /^#[\w-]+$/.test(val) ? m : ""
  })
  // url(...) in attributes/styles: only url(#id)
  s = s.replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, "none")
  s = s.trim()
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return ""
  if (/<(script|foreignObject|iframe|embed|object)\b|javascript:|\bon[a-z]+\s*=|<!ENTITY|@import/i.test(s)) return ""
  if (!/xmlns=/.test(s.slice(0, 400))) s = s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  return s
}

export function parseLogo(v: unknown, f: LogoConfig = DEFAULT_LOGO): LogoConfig {
  const r = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  const source = LOGO_SOURCES.includes(r.source as LogoSource) ? (r.source as LogoSource) : f.source
  return {
    source,
    image: "image" in r ? uploadPath(r.image) : f.image,
    svg: "svg" in r ? sanitizeSvg(r.svg) : f.svg,
    color: hex(r.color, f.color),
    text: "text" in r ? line(r.text) : f.text,
  }
}
export function parseLogos(v: unknown, base: Logos = DEFAULT_LOGOS): Logos {
  const r = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  return Object.fromEntries(LOGO_IDS.map((id) => [id, parseLogo(r[id], base[id])])) as Logos
}
export function parseLogoIds(v: unknown): LogoId[] {
  return Array.isArray(v) ? LOGO_IDS.filter((id) => v.includes(id)) : []
}

export const svgDataUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/** What the logo <img> shows: built-in SVG (recoloured), pasted SVG, or the uploaded image. "" = nothing to show. */
export function logoSrc(id: LogoId, cfg: LogoConfig): string {
  if (cfg.source === "image") return cfg.image
  if (cfg.source === "svg") return cfg.svg ? svgDataUrl(cfg.svg) : ""
  const svg = cfg.color === LOGO_BRAND ? DEFAULT_LOGO_SVG[id] : DEFAULT_LOGO_SVG[id].split(`fill="${LOGO_BRAND}"`).join(`fill="${cfg.color}"`)
  return svgDataUrl(svg)
}

// ---------- QR ----------

export type QrConfig = {
  url: string
  /** module colour (on white) */
  color: string
  /** animated variant: the stepping accent cell around the code */
  accent: string
  caption: string
  caption2: string
  /** Logo QR centre badge */
  badgeText: string
  badgeColor: string
}
export const DEFAULT_QR: QrConfig = { url: "https://linktr.ee/onlinehyphen", color: "#000000", accent: "#ff6a00", caption: "hyphen.link/live", caption2: "", badgeText: "h.", badgeColor: LOGO_BRAND }
export const QR_BASE_PX = 178

function qrUrl(v: unknown, f: string): string {
  if (typeof v !== "string") return f
  const t = v.trim().slice(0, 500)
  if (!t) return ""
  try {
    const u = new URL(t)
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : f
  } catch {
    return f
  }
}
export function parseQr(v: unknown, f: QrConfig = DEFAULT_QR): QrConfig {
  const r = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  return {
    url: "url" in r ? qrUrl(r.url, f.url) : f.url,
    color: hex(r.color, f.color),
    accent: hex(r.accent, f.accent),
    caption: "caption" in r ? line(r.caption) : f.caption,
    caption2: "caption2" in r ? line(r.caption2) : f.caption2,
    badgeText: "badgeText" in r ? line(r.badgeText).slice(0, 4) : f.badgeText,
    badgeColor: hex(r.badgeColor, f.badgeColor),
  }
}

export type QrMatrix = { size: number; dark: boolean[] }
const qrCache = new Map<string, QrMatrix | null>()
/** Real QR modules (ECC M plain, H for the Logo QR so the centre badge can cover ~10% and still scan). */
export function qrMatrix(url: string, ecc: "M" | "H"): QrMatrix | null {
  const key = `${ecc}|${url}`
  if (qrCache.has(key)) return qrCache.get(key) ?? null
  let out: QrMatrix | null = null
  if (url.trim()) {
    try {
      const qr = QRCode.create(url.trim(), { errorCorrectionLevel: ecc })
      const size = qr.modules.size
      const dark: boolean[] = []
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark.push(Boolean(qr.modules.get(x, y)))
      out = { size, dark }
    } catch {
      out = null
    }
  }
  qrCache.set(key, out)
  return out
}
/** Centre badge box in modules (≈26% of the side, like the design; ≤ ~7% of the area: safe at ECC H). */
export function qrBadgeBox(size: number): { x: number; y: number; w: number } {
  const w = Math.max(3, Math.round(size * 0.26) | 1)
  const x = Math.floor((size - w) / 2)
  return { x, y: x, w }
}
/** Animated QR: the accent cell steps around the quiet-zone ring once a second (never over the code). */
export function qrRingCell(size: number, step: number): { x: number; y: number } {
  const n = size + 1 // ring at -1 .. size, side length size+2 → perimeter 4*(size+1)
  const i = ((step % (4 * n)) + 4 * n) % (4 * n)
  if (i < n) return { x: -1 + i, y: -1 }
  if (i < 2 * n) return { x: size, y: -1 + (i - n) }
  if (i < 3 * n) return { x: size - (i - 2 * n), y: size }
  return { x: -1, y: size - (i - 3 * n) }
}

// ---------- Scene cards (full screen) ----------

/** Extra full-screen cards from the design. Break, Hold, Welcome and End are the existing cards. */
export const SCENE_IDS = ["hold05", "hold06", "hold07", "standby", "showreel"] as const
export type SceneId = (typeof SCENE_IDS)[number]
export const SCENE_LABEL: Record<SceneId, string> = { hold05: "HOLD 05", hold06: "HOLD 06", hold07: "HOLD 07", standby: "STANDBY", showreel: "SHOWREEL" }
export const SCENE_BG_MODES = ["solid", "image", "hero"] as const
export type SceneBgMode = (typeof SCENE_BG_MODES)[number]
export type SceneCard = { label: string; sub: string; dot: string; pill: string; bgMode: SceneBgMode; bg: string; gradient: boolean; image: string; dim: number; showQr: boolean; /** Local mp4 (/uploads/…). Plays with audio. */ video: string; /** When the video ends, cut to Program. */ autoSwitch: boolean; /** Video above the card text / QR. */ videoFront: boolean }

const scene = (label: string, sub: string, dot: string, pill: string, extra: Partial<SceneCard> = {}): SceneCard => ({ label, sub, dot, pill, bgMode: "solid", bg: "#0a0a0a", gradient: false, image: "", dim: 30, showQr: true, video: "", autoSwitch: false, videoFront: false, ...extra })
export const DEFAULT_SCENES: Record<SceneId, SceneCard> = {
  hold05: scene("Break", "Stretch • Refill • 15 min", "#c6ff00", "HOLD 05 • BREAK"),
  hold06: scene("Starting Soon", "Doors opening • Get comfy", "#ffd400", "HOLD 06 • STARTING SOON"),
  hold07: scene("Be Right Back", "We’ll be back shortly", "#ff6a00", "HOLD 07 • TECH PAUSE"),
  standby: scene("Stand By", "We’re getting ready • Stay tuned", "#ffd400", "STANDBY • HOLD"),
  showreel: scene("Showreel", "Hyphen Studio Work • 2026", "#ffffff", "SHOWREEL • PLAY", { gradient: true }),
}
/** Pill text and dot for the existing cards, from the design. */
export const CLASSIC_PILL = {
  break: { pill: "BREAK • BACK SOON", dot: "#d9ff43" },
  hold: { pill: "HOLD • PAUSE", dot: "#ff6a00" },
  welcome: { pill: "WELCOME • DOORS OPEN", dot: "#d9ff43" },
  end: { pill: "END • THANK YOU", dot: "#d9ff43" },
} as const

export function parseScene(v: unknown, f: SceneCard): SceneCard {
  const r = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  const dim = typeof r.dim === "number" && Number.isFinite(r.dim) ? Math.round(Math.min(90, Math.max(0, r.dim))) : f.dim
  return {
    label: "label" in r ? line(r.label) || f.label : f.label,
    sub: "sub" in r ? line(r.sub) : f.sub,
    dot: hex(r.dot, f.dot),
    pill: "pill" in r ? line(r.pill) : f.pill,
    bgMode: SCENE_BG_MODES.includes(r.bgMode as SceneBgMode) ? (r.bgMode as SceneBgMode) : f.bgMode,
    bg: hex(r.bg, f.bg),
    gradient: typeof r.gradient === "boolean" ? r.gradient : f.gradient,
    image: "image" in r ? uploadPath(r.image) : f.image,
    dim,
    showQr: typeof r.showQr === "boolean" ? r.showQr : f.showQr,
    video: "video" in r ? uploadPath(r.video) : f.video,
    autoSwitch: typeof r.autoSwitch === "boolean" ? r.autoSwitch : f.autoSwitch,
    videoFront: typeof r.videoFront === "boolean" ? r.videoFront : f.videoFront,
  }
}
export function parseScenes(v: unknown, base: Record<SceneId, SceneCard> = DEFAULT_SCENES): Record<SceneId, SceneCard> {
  const r = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  return Object.fromEntries(SCENE_IDS.map((id) => [id, parseScene(r[id], base[id])])) as Record<SceneId, SceneCard>
}
export const isScene = (v: unknown): v is SceneId => SCENE_IDS.includes(v as SceneId)
