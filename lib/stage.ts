/**
 * One stage parser for the server (event.json, PUT /api/event) and the browser (/stream),
 * so both always agree on defaults and ranges. Pure: safe to import from client components.
 */
import { CLOCK_SCALE_RANGE, CLOCK_TEXT_RANGE, clampSize } from "@/lib/countdown-size"
import { DEFAULT_LOGOS, DEFAULT_QR, DEFAULT_SCENES, SCENE_IDS, parseLogoIds, parseLogos, parseQr, parseScenes, type LogoId, type Logos, type QrConfig, type SceneCard, type SceneId } from "@/lib/visuals-assets"
import { DEFAULT_LAYOUT, parseVisualsLayout, type VisualsLayout } from "@/lib/visuals-layout"
import { safeUrl, sanitizeSpeakers, type SpeakerCard } from "@/lib/event"
import { clampHold, clampInset, DEFAULT_STRAPS, parseCorner, parseStrapMode, parseStrapMotion, sanitizeStraps, sanitizeTickerItems, parseTalkMode, parseTalkTimer, parseTickerType, visualText, STRAP_STYLES, DEFAULT_STRAP_DESIGNS, DEFAULT_TEXT_SCALE, parseStrapDesigns, parseTextScale, type StrapDesigns, type TextScale, type TalkMode, type TickerType, type Corner, type StrapMode, type StrapMotion, type StrapPreset, type StrapStyle } from "@/lib/visuals"

export type StageOptions = {
  /** /stream audio routing (what plays in the page itself: interactive viewers and OBS browser source) */
  streamProgramAudio: boolean
  streamBedAudio: boolean
  /** Social circles (ported from the Hyphen "Social Circles" design): spotlight one circle at a time. */
  socialSpotlight: boolean
  socialDwellMs: number
  socialCooldownMs: number
  /** White ring stroke around each circle, px @1080p */
  socialStrokePx: number
  socialShowHandle: boolean
  /** Countdown unit boxes: stroke px @1080p and colour */
  countdownStrokePx: number
  countdownStrokeColor: string
  /** Countdown slate text options (date/timezone line, badge pill, event link). Defaults = the old look. */
  slateLook: SlateLook
  /** Background colours, "" = the default blue. */
  countdownBg: string
  endBg: string
  breakBg: string
  holdBg: string
  standbyBg: string
  welcomeBg: string
  /** Visuals overlays. Saved (desk › Visuals): presets + colours. */
  straps: StrapPreset[]
  strapAccent: string
  strapText: string
  /** House strap: pulsing white accent circle and the ↗ arrow badge (design toggles). Saved. */
  strapAccentCircle: boolean
  strapArrow: boolean
  /** Builder › Name strap › Design: per-design name/subline size and accents. Saved. */
  strapDesigns: StrapDesigns
  /** Builder: text size % for the ticker, talk/festival pill, Q&A and Sponsored pills. Saved. */
  textScale: TextScale
  /** Logos 1–5 (builder › Save): source (built-in / uploaded / pasted SVG), colour, caption text. */
  logos: Logos
  /** Live (deck): which logos show. */
  logosOn: LogoId[]
  /** QR (builder › Save): link, colours, captions, Logo QR badge. */
  qr: QrConfig
  /** Live (deck): animated QR and Logo QR show/hide. */
  qrOn: boolean
  qrLogoOn: boolean
  /** Extra full-screen scene cards (HOLD 05/06/07, STANDBY, SHOWREEL): texts, dot, pill, background. Saved. */
  scenes: Record<SceneId, SceneCard>
  /** Live (deck /visuals, applied at once): which strap, IN/OUT/LOOP and when, look overrides, socials overlay. */
  strapId: string
  strapMode: StrapMode
  strapAt: number | null
  strapHoldSec: number
  strapMotion: StrapMotion
  /** "" = the preset's own style */
  strapStyle: StrapStyle | ""
  strapCorner: Corner
  socialsOverlay: boolean
  socialsCorner: Corner
  /** Visuals layer on /stream (captured: reaches YouTube and Vertical). Off = OBS /overlay/* pages only. */
  streamVisuals: boolean
  /** Talk-ends pill (top-left): Session = manual timer from the deck, Festival = to the event end. */
  talkVisible: boolean
  talkMode: TalkMode
  talkEndsAt: number | null
  talkPausedMs: number | null
  talkPrefix: string
  festivalPrefix: string
  /** Bottom ticker bar (marquee). */
  tickerVisible: boolean
  tickerType: TickerType
  /** The active type's items (what the bar shows) = tickerPlannerItems or tickerSocialItems. Kept in sync. */
  tickerItems: string[]
  /** Separate saved lists per ticker type (switching type shows that type's own items). */
  tickerPlannerItems: string[]
  tickerSocialItems: string[]
  /** Q&A white pill (bottom-right) and Sponsored black pill (top-right). */
  qaVisible: boolean
  qaText: string
  sponsorVisible: boolean
  sponsorText: string
  /** Extra px @1080p in from the safe-zone line for straps, socials and timecode badges (0 = edge on the line). */
  overlayInset: number
  /** Builder › Save: per-part corner / snap / gap / size, separately for the countdown screen and program. */
  visualsLayout: VisualsLayout
  /** A/V diagnostics: labelled STREAM wall-clock timecode on /stream (TC2), live switch, default off. */
  streamTimecode: boolean
  streamTimecodeFps: number
  checker: number
  showMeta: boolean
  showLink: boolean
  transparent: boolean
  lineSpacing: number
  blockGap: number
  clockScale: number
  clockText: number
  logoUrl: string
  speakers: SpeakerCard[]
  gallerySeconds: number
  galleryPause: number
  galleryOffset: number
  galleryScale: number
  endTitle: string
  endSubtitle: string
  endDate: string
  endBody: string
  endQrUrl: string
  endButton: string
  /** End card adjustment: signed minutes from the planned Event › End time (−2 = 2 min early). 0 = as planned. */
  endOffsetMin: number
  forceEnd: boolean
  holdCountdown: boolean
  /** Break / hold overlay cards. `overlay` is the live switch; it beats the end card and countdown. */
  breakTitle: string
  breakMessage: string
  breakImage: string
  breakFit: ImageFit
  holdTitle: string
  /** Branded card on /stream when the program feed is lost (replaces the technical "Waiting for OBS"). */
  standbyTitle: string
  standbyMessage: string
  holdMessage: string
  holdImage: string
  holdFit: ImageFit
  welcomeTitle: string
  welcomeMessage: string
  welcomeImage: string
  welcomeFit: ImageFit
  /** Desk Rehearsal/Live switch, shared so every desk agrees. Not used by /stream. */
  deskLive: boolean
  overlay: Overlay
  /** Live switch: show the external OBS program feed (relay path /program). Beaten by break/hold/welcome; beats end card and countdown. */
  program: boolean
  /** Which input the program feed shows: Main (/program) or Backup (/program-backup). Live switch. */
  programSource: "main" | "backup"
  /** When the current overlay went up (ms), for the "on break" timer. */
  overlayAt: number | null
  /** Desk "Resync": when set/changed, /stream rebuilds both program players (no disarm). */
  playerResyncAt: number | null
}

export type ImageFit = "cover" | "contain"
/** Card overlays (single source of truth): the classic cards plus every scene card. Used by the stage
 * parser, the transport screens and the desk, so a new card can't be dropped back to "none" anywhere. */
export const CARD_OVERLAYS = ["break", "hold", "welcome", ...SCENE_IDS] as const
export type CardOverlay = (typeof CARD_OVERLAYS)[number]
export type Overlay = "none" | CardOverlay
export const OVERLAYS: readonly Overlay[] = ["none", ...CARD_OVERLAYS]
export const isCardOverlay = (v: unknown): v is CardOverlay => (CARD_OVERLAYS as readonly unknown[]).includes(v)
export const isOverlay = (v: unknown): v is Overlay => v === "none" || isCardOverlay(v)

// ---------- slate text look + background colours ----------

export type FontWeight = 400 | 700 | 900
export const FONT_WEIGHTS: { value: FontWeight; label: string }[] = [{ value: 400, label: "Regular" }, { value: 700, label: "Bold" }, { value: 900, label: "Black" }]
/** size = % of the old size, opacity = % (date line / link were white at 40% / 80%). */
export type SlateLook = { metaSize: number; metaWeight: FontWeight; metaOpacity: number; badgeSize: number; badgeWeight: FontWeight; linkSize: number; linkWeight: FontWeight; linkOpacity: number }
export const DEFAULT_SLATE_LOOK: SlateLook = { metaSize: 100, metaWeight: 400, metaOpacity: 40, badgeSize: 100, badgeWeight: 700, linkSize: 100, linkWeight: 400, linkOpacity: 80 }
export const SLATE_SIZE_RANGE = { min: 50, max: 300 }

function weight(v: unknown, f: FontWeight): FontWeight {
  return v === 400 || v === 700 || v === 900 ? v : f
}

export function parseSlateLook(v: unknown): SlateLook {
  const r = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  const d = DEFAULT_SLATE_LOOK
  const size = (x: unknown, f: number) => clamp(x, SLATE_SIZE_RANGE.min, SLATE_SIZE_RANGE.max, f, true)
  const op = (x: unknown, f: number) => clamp(x, 10, 100, f, true)
  return {
    metaSize: size(r.metaSize, d.metaSize), metaWeight: weight(r.metaWeight, d.metaWeight), metaOpacity: op(r.metaOpacity, d.metaOpacity),
    badgeSize: size(r.badgeSize, d.badgeSize), badgeWeight: weight(r.badgeWeight, d.badgeWeight),
    linkSize: size(r.linkSize, d.linkSize), linkWeight: weight(r.linkWeight, d.linkWeight), linkOpacity: op(r.linkOpacity, d.linkOpacity),
  }
}

/** "" (default blue) or a #rrggbb colour. */
export function bgColor(v: unknown): string {
  return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : ""
}

/** Style for a `.stage-bg` element: unset = the default blue pulse; a colour sets the base and a slightly lighter pulse. */
export function stageBgStyle(color: string | undefined): Record<string, string> | undefined {
  const c = bgColor(color)
  return c ? { "--bg-dark": c, "--bg-light": `color-mix(in srgb, ${c} 86%, white)` } : undefined
}

export const DEFAULT_STAGE: StageOptions = {
  checker: 6,
  showMeta: true,
  showLink: true,
  transparent: false,
  streamProgramAudio: true,
  streamBedAudio: false,
  socialSpotlight: true,
  socialDwellMs: 2800,
  socialCooldownMs: 4000,
  socialStrokePx: 3,
  socialShowHandle: true,
  countdownStrokePx: 2,
  countdownStrokeColor: "#ffffff",
  slateLook: DEFAULT_SLATE_LOOK,
  countdownBg: "",
  endBg: "",
  breakBg: "",
  holdBg: "",
  standbyBg: "",
  welcomeBg: "",
  straps: DEFAULT_STRAPS,
  strapAccent: "#d9ff43",
  strapText: "#ffffff",
  strapAccentCircle: true,
  strapArrow: true,
  strapDesigns: DEFAULT_STRAP_DESIGNS,
  textScale: DEFAULT_TEXT_SCALE,
  logos: DEFAULT_LOGOS,
  logosOn: [],
  qr: DEFAULT_QR,
  qrOn: false,
  qrLogoOn: false,
  scenes: DEFAULT_SCENES,
  strapId: "",
  strapMode: "out",
  strapAt: null,
  strapHoldSec: 5,
  strapMotion: "slide-left",
  strapStyle: "",
  strapCorner: "bottom-left",
  socialsOverlay: false,
  socialsCorner: "bottom-left",
  overlayInset: 0,
  visualsLayout: DEFAULT_LAYOUT,
  streamVisuals: true,
  talkVisible: false,
  talkMode: "session",
  talkEndsAt: null,
  talkPausedMs: null,
  talkPrefix: "Talk ends in",
  festivalPrefix: "Festival ends in",
  tickerVisible: false,
  tickerType: "planner",
  tickerItems: [],
  tickerPlannerItems: [],
  tickerSocialItems: [],
  qaVisible: false,
  qaText: "Q&A · Ask a question →",
  sponsorVisible: false,
  sponsorText: "Sponsored · Studio Partner",
  streamTimecode: false,
  streamTimecodeFps: 30,
  lineSpacing: 1.14,
  blockGap: 1.2,
  clockScale: 1,
  clockText: 1,
  logoUrl: "",
  speakers: [],
  gallerySeconds: 4,
  galleryPause: 6,
  galleryOffset: -86,
  galleryScale: 80,
  endTitle: "Thank you for joining",
  endSubtitle: "Hyphen Festival 2026",
  endDate: "Wed, 04 Nov, 2026",
  endBody: "The stream has ended. Thank you to all speakers, partners and attendees. Recordings will be available shortly.",
  endQrUrl: "https://linktr.ee/onlinehyphen",
  endButton: "Watch replay — coming soon",
  endOffsetMin: 0,
  forceEnd: false,
  holdCountdown: false,
  breakTitle: "We'll be right back",
  breakMessage: "",
  breakImage: "",
  breakFit: "cover",
  holdTitle: "Please stand by",
  standbyTitle: "We'll be right back",
  standbyMessage: "The stream will continue in a moment.",
  holdMessage: "",
  holdImage: "",
  holdFit: "cover",
  welcomeTitle: "Welcome back",
  welcomeMessage: "",
  welcomeImage: "",
  welcomeFit: "cover",
  deskLive: false,
  overlay: "none",
  program: false,
  programSource: "main",
  overlayAt: null,
  playerResyncAt: null,
}

export const TEXT_MAX = 200
export const BODY_MAX = 1000

/** A real number from a number or numeric string; null, "" and junk are not numbers (Number(null) is 0). */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function clamp(value: unknown, min: number, max: number, fallback: number, round = false) {
  const n = num(value)
  if (n === null) return fallback
  const v = Math.min(max, Math.max(min, n))
  return round ? Math.round(v) : v
}

export function clampChecker(value: unknown, fallback = DEFAULT_STAGE.checker) {
  return clamp(value, 4, 12, fallback, true)
}

function text(value: unknown, fallback: string, max = TEXT_MAX) {
  return typeof value === "string" && value.trim() ? value.slice(0, max) : fallback
}

/** Max end adjustment either way (minutes). */
export const END_OFFSET_MAX = 720
/** Whole minutes in ±END_OFFSET_MAX (numeric strings accepted); anything else falls back. */
export function parseEndOffset(value: unknown, fallback = 0): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback
  return Math.max(-END_OFFSET_MAX, Math.min(END_OFFSET_MAX, Math.round(n)))
}

/**
 * Sanitise a (possibly partial) stage. Fields missing from `raw` keep the `base` value,
 * so a partial PUT never resets the rest of the stage.
 */
export function parseStage(raw: unknown, base: StageOptions = DEFAULT_STAGE): StageOptions {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const has = (key: keyof StageOptions) => key in r && r[key] !== undefined
  const pick = <K extends keyof StageOptions>(key: K, parse: (value: unknown, fallback: StageOptions[K]) => StageOptions[K]): StageOptions[K] =>
    has(key) ? parse(r[key], base[key]) : base[key]
  return {
    checker: pick("checker", (v, f) => clampChecker(v, f)),
    showMeta: pick("showMeta", (v) => v !== false),
    showLink: pick("showLink", (v) => v !== false),
    transparent: pick("transparent", (v) => v === true),
    streamProgramAudio: pick("streamProgramAudio", (v) => v !== false),
    streamBedAudio: pick("streamBedAudio", (v) => v === true),
    socialSpotlight: pick("socialSpotlight", (v) => v !== false),
    socialDwellMs: pick("socialDwellMs", (v, f) => Math.round(clamp(v, 500, 15000, f))),
    socialCooldownMs: pick("socialCooldownMs", (v, f) => Math.round(clamp(v, 0, 15000, f))),
    socialStrokePx: pick("socialStrokePx", (v, f) => Math.round(clamp(v, 0, 12, f) * 2) / 2),
    socialShowHandle: pick("socialShowHandle", (v) => v !== false),
    countdownStrokePx: pick("countdownStrokePx", (v, f) => Math.round(clamp(v, 0, 12, f) * 2) / 2),
    countdownStrokeColor: pick("countdownStrokeColor", (v, f) => hexColor(v, f)),
    slateLook: pick("slateLook", (v) => parseSlateLook(v)),
    countdownBg: pick("countdownBg", (v) => bgColor(v)),
    endBg: pick("endBg", (v) => bgColor(v)),
    breakBg: pick("breakBg", (v) => bgColor(v)),
    holdBg: pick("holdBg", (v) => bgColor(v)),
    standbyBg: pick("standbyBg", (v) => bgColor(v)),
    welcomeBg: pick("welcomeBg", (v) => bgColor(v)),
    straps: pick("straps", (v) => sanitizeStraps(v)),
    strapAccent: pick("strapAccent", (v, f) => hexColor(v, f)),
    strapText: pick("strapText", (v, f) => hexColor(v, f)),
    strapAccentCircle: pick("strapAccentCircle", (v) => v !== false),
    strapArrow: pick("strapArrow", (v) => v !== false),
    // Before designs existed the house toggles were strapAccentCircle / strapArrow: they seed the house design.
    strapDesigns: has("strapDesigns") ? parseStrapDesigns(r.strapDesigns) : has("strapAccentCircle") || has("strapArrow") ? { ...base.strapDesigns, house: { ...base.strapDesigns.house, off: parseStrapDesigns(undefined, { circle: r.strapAccentCircle !== false, arrow: r.strapArrow !== false }).house.off } } : base.strapDesigns,
    textScale: pick("textScale", (v) => parseTextScale(v)),
    logos: pick("logos", (v, f) => parseLogos(v, f)),
    logosOn: pick("logosOn", (v) => parseLogoIds(v)),
    qr: pick("qr", (v, f) => parseQr(v, f)),
    qrOn: pick("qrOn", (v) => v === true),
    qrLogoOn: pick("qrLogoOn", (v) => v === true),
    scenes: pick("scenes", (v, f) => parseScenes(v, f)),
    strapId: pick("strapId", (v) => (typeof v === "string" ? v.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) : "")),
    strapMode: pick("strapMode", (v) => parseStrapMode(v)),
    strapAt: pick("strapAt", (v) => (typeof v === "number" && Number.isFinite(v) ? v : null)),
    strapHoldSec: pick("strapHoldSec", (v, f) => clampHold(v, f)),
    strapMotion: pick("strapMotion", (v) => parseStrapMotion(v)),
    strapStyle: pick("strapStyle", (v) => (STRAP_STYLES.includes(v as StrapStyle) ? (v as StrapStyle) : "")),
    strapCorner: pick("strapCorner", (v) => parseCorner(v)),
    socialsOverlay: pick("socialsOverlay", (v) => v === true),
    socialsCorner: pick("socialsCorner", (v) => parseCorner(v)),
    overlayInset: pick("overlayInset", (v, f) => clampInset(v, f)),
    visualsLayout: pick("visualsLayout", (v) => parseVisualsLayout(v)),
    streamVisuals: pick("streamVisuals", (v) => v !== false),
    talkVisible: pick("talkVisible", (v) => v === true),
    talkMode: pick("talkMode", (v) => parseTalkMode(v)),
    ...(() => {
      // endsAt / pausedMs are one timer: validate them together (paused wins).
      if (!has("talkEndsAt") && !has("talkPausedMs")) return { talkEndsAt: base.talkEndsAt, talkPausedMs: base.talkPausedMs }
      const t = parseTalkTimer(has("talkEndsAt") ? r.talkEndsAt : base.talkEndsAt, has("talkPausedMs") ? r.talkPausedMs : base.talkPausedMs)
      return { talkEndsAt: t.endsAt, talkPausedMs: t.pausedMs }
    })(),
    talkPrefix: pick("talkPrefix", (v, f) => visualText(v, f) || f),
    festivalPrefix: pick("festivalPrefix", (v, f) => visualText(v, f) || f),
    tickerVisible: pick("tickerVisible", (v) => v === true),
    tickerType: pick("tickerType", (v) => parseTickerType(v)),
    ...(() => {
      // Per-type lists; an old single list (tickerItems only) migrates into the current type.
      const type = has("tickerType") ? parseTickerType(r.tickerType) : base.tickerType
      let planner = has("tickerPlannerItems") ? sanitizeTickerItems(r.tickerPlannerItems) : base.tickerPlannerItems
      let social = has("tickerSocialItems") ? sanitizeTickerItems(r.tickerSocialItems) : base.tickerSocialItems
      if (has("tickerItems") && !has("tickerPlannerItems") && !has("tickerSocialItems")) {
        const legacy = sanitizeTickerItems(r.tickerItems)
        if (type === "social") social = legacy
        else planner = legacy
      }
      planner = planner ?? []
      social = social ?? []
      return { tickerPlannerItems: planner, tickerSocialItems: social, tickerItems: type === "social" ? social : planner }
    })(),
    qaVisible: pick("qaVisible", (v) => v === true),
    qaText: pick("qaText", (v, f) => visualText(v, f) || f),
    sponsorVisible: pick("sponsorVisible", (v) => v === true),
    sponsorText: pick("sponsorText", (v, f) => visualText(v, f) || f),
    streamTimecode: pick("streamTimecode", (v) => v === true),
    streamTimecodeFps: pick("streamTimecodeFps", (v) => ([25, 30, 50, 60].includes(Number(v)) ? Number(v) : 30)),
    lineSpacing: pick("lineSpacing", (v, f) => clamp(v, 0.8, 2.4, f)),
    blockGap: pick("blockGap", (v, f) => clamp(v, 0, 8, f)),
    clockScale: pick("clockScale", (v, f) => clampSize(v, CLOCK_SCALE_RANGE, f)),
    clockText: pick("clockText", (v, f) => clampSize(v, CLOCK_TEXT_RANGE, f)),
    logoUrl: pick("logoUrl", (v) => safeUrl(v, "", { relative: true, dataImage: true })),
    speakers: pick("speakers", (v) => sanitizeSpeakers(v).map((s) => ({ ...s, name: s.name.slice(0, TEXT_MAX), description: s.description.slice(0, BODY_MAX) }))),
    gallerySeconds: pick("gallerySeconds", (v, f) => clamp(v, 2, 30, f, true)),
    galleryPause: pick("galleryPause", (v, f) => clamp(v, 2, 30, f, true)),
    galleryOffset: pick("galleryOffset", (v, f) => clamp(v, -600, 400, f, true)),
    galleryScale: pick("galleryScale", (v, f) => clamp(v, 40, 200, f, true)),
    endTitle: pick("endTitle", (v) => text(v, DEFAULT_STAGE.endTitle)),
    endSubtitle: pick("endSubtitle", (v) => text(v, DEFAULT_STAGE.endSubtitle)),
    endDate: pick("endDate", (v) => text(v, DEFAULT_STAGE.endDate)),
    endBody: pick("endBody", (v) => text(v, DEFAULT_STAGE.endBody, BODY_MAX)),
    endQrUrl: pick("endQrUrl", (v) => safeUrl(v, DEFAULT_STAGE.endQrUrl)),
    endButton: pick("endButton", (v) => text(v, DEFAULT_STAGE.endButton)),
    // Old clock-time `endAt` (no date: could carry over to another day) is dropped, not converted.
    endOffsetMin: pick("endOffsetMin", (v, f) => parseEndOffset(v, f)),
    forceEnd: pick("forceEnd", (v) => v === true),
    holdCountdown: pick("holdCountdown", (v) => v === true),
    breakTitle: pick("breakTitle", (v) => text(v, DEFAULT_STAGE.breakTitle)),
    breakMessage: pick("breakMessage", (v) => (typeof v === "string" ? v.slice(0, BODY_MAX) : "")),
    breakImage: pick("breakImage", (v) => safeUrl(v, "", { relative: true, dataImage: true })),
    breakFit: pick("breakFit", (v) => (v === "contain" ? "contain" : "cover")),
    holdTitle: pick("holdTitle", (v) => text(v, DEFAULT_STAGE.holdTitle)),
    standbyTitle: pick("standbyTitle", (v) => text(v, DEFAULT_STAGE.standbyTitle)),
    standbyMessage: pick("standbyMessage", (v) => (typeof v === "string" ? v.slice(0, BODY_MAX) : DEFAULT_STAGE.standbyMessage)),
    holdMessage: pick("holdMessage", (v) => (typeof v === "string" ? v.slice(0, BODY_MAX) : "")),
    holdImage: pick("holdImage", (v) => safeUrl(v, "", { relative: true, dataImage: true })),
    holdFit: pick("holdFit", (v) => (v === "contain" ? "contain" : "cover")),
    welcomeTitle: pick("welcomeTitle", (v) => text(v, DEFAULT_STAGE.welcomeTitle)),
    welcomeMessage: pick("welcomeMessage", (v) => (typeof v === "string" ? v.slice(0, BODY_MAX) : "")),
    welcomeImage: pick("welcomeImage", (v) => safeUrl(v, "", { relative: true, dataImage: true })),
    welcomeFit: pick("welcomeFit", (v) => (v === "contain" ? "contain" : "cover")),
    deskLive: pick("deskLive", (v) => v === true),
    overlay: pick("overlay", (v) => (isOverlay(v) ? v : "none")),
    program: pick("program", (v) => v === true),
    programSource: pick("programSource", (v) => (v === "backup" ? "backup" : "main")),
    overlayAt: pick("overlayAt", (v) => (typeof v === "number" && Number.isFinite(v) ? v : null)),
    playerResyncAt: pick("playerResyncAt", (v) => (typeof v === "number" && Number.isFinite(v) ? v : null)),
  }
}


// ---------- test clock ----------

/** A test clock older than this is ignored by /stream, so a forgotten rehearsal can't go out live. */
export const TEST_CLOCK_TTL_MS = 2 * 60 * 60 * 1000

export function testClockStale(testSetAt: number | null, now = Date.now()): boolean {
  return testSetAt !== null && now - testSetAt > TEST_CLOCK_TTL_MS
}

/** Same speakers in the same order (used to tell a desk draft from the published list). */
export function sameSpeakers(a: readonly SpeakerCard[], b: readonly SpeakerCard[]): boolean {
  return a.length === b.length && a.every((item, i) => item.image === b[i].image && item.name === b[i].name && item.description === b[i].description)
}

/**
 * What /stream shows, in order of precedence:
 * break/hold/welcome overlay  >  forced end / due end-card override  >  OBS program feed  >  end card (past Event › End time unless held)  >  countdown.
 *
 * End card override (ported from agent-forge): when an adjusted end (`endOffsetMin` ≠ 0, e.g. deck −1/+5) is due, or End is
 * forced, the end card cuts over Program. The plain Event › End time does NOT pre-empt Program (a running show is never
 * cut by the schedule alone). After it fires, tap Program or Countdown to stay past the end: that sets holdCountdown.
 */
export function stageScreen(stage: Pick<StageOptions, "overlay" | "forceEnd" | "holdCountdown"> & { program?: boolean; endOffsetMin?: number }, pastEnd: boolean): "break" | "hold" | "welcome" | SceneId | "program" | "end" | "countdown" {
  if (stage.overlay !== "none") return stage.overlay
  if (stage.forceEnd) return "end"
  // An adjusted end (offset ≠ 0) is an operator decision: when due it cuts over Program, as the old override did.
  if (stage.endOffsetMin && pastEnd && !stage.holdCountdown) return "end"
  if (stage.program) return "program"
  if (!stage.holdCountdown && pastEnd) return "end"
  return "countdown"
}

/** The test clock a desk should use from a server body: none once it is stale (same TTL as /stream). */
export function serverClock(body: { testUntil?: unknown; pausedAt?: unknown; testSetAt?: unknown; testStale?: unknown }, now = Date.now()): { testUntil: number | null; pausedAt: number | null; testSetAt: number | null } {
  const setAt = typeof body.testSetAt === "number" ? body.testSetAt : null
  if (body.testStale === true || testClockStale(setAt, now)) return { testUntil: null, pausedAt: null, testSetAt: null }
  return { testUntil: typeof body.testUntil === "number" ? body.testUntil : null, pausedAt: typeof body.pausedAt === "number" ? body.pausedAt : null, testSetAt: setAt }
}
/** The desk's localStorage clock fallback: dropped when it was saved longer ago than the TTL (or undated). */
export function localClock(raw: string | null, now = Date.now()): { testUntil: number | null; pausedAt: number | null } {
  try {
    const c = raw ? (JSON.parse(raw) as { testUntil?: unknown; pausedAt?: unknown; savedAt?: unknown }) : null
    if (!c || typeof c.savedAt !== "number" || testClockStale(c.savedAt, now)) return { testUntil: null, pausedAt: null }
    return { testUntil: typeof c.testUntil === "number" ? c.testUntil : null, pausedAt: typeof c.pausedAt === "number" ? c.pausedAt : null }
  } catch { return { testUntil: null, pausedAt: null } }
}

/** #rgb / #rrggbb only (goes into inline styles). */
export function hexColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback
}

/** The SocialCircles look from stage options. */
export function socialLook(stage: StageOptions) {
  return {
    spotlight: stage.socialSpotlight,
    dwellMs: stage.socialDwellMs,
    cooldownMs: stage.socialCooldownMs,
    strokePx: stage.socialStrokePx,
    showHandle: stage.socialShowHandle,
  }
}

/** Stage fields the deck owns live (Visuals). A desk saving its whole stage must not write stale copies back. */
export const LIVE_VISUAL_KEYS = ["strapId", "strapMode", "strapAt", "strapHoldSec", "strapMotion", "strapStyle", "strapCorner", "socialsOverlay", "socialsCorner", "streamTimecode", "streamTimecodeFps", "streamVisuals", "talkVisible", "talkMode", "talkEndsAt", "talkPausedMs", "talkPrefix", "festivalPrefix", "tickerVisible", "tickerType", "tickerItems", "tickerPlannerItems", "tickerSocialItems", "qaVisible", "qaText", "sponsorVisible", "sponsorText", "logosOn", "qrOn", "qrLogoOn"] as const satisfies readonly (keyof StageOptions)[]
