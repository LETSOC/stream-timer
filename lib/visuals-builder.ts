/**
 * Visuals builder (/visuals/builder): pure helpers for the draft, the preview stage and the Save body.
 *
 * Two paths, never mixed:
 *  - Save path (draft → PUT /api/event): speaker presets, strap colours, the layout.
 *  - Live path (deck actions, applied at once): texts, ticker, prefixes, strap motion/style/corner…
 *    PUT /api/event overwrites live fields with the current live values, so they can't go via Save.
 */
import { parseStage, type StageOptions } from "@/lib/stage"
import { LOGO_IDS, parseLogos, parseQr, parseScenes, type LogoId, type Logos, type QrConfig, type SceneCard, type SceneId } from "@/lib/visuals-assets"
import { newStrapId, STRAP_MAX, type StrapPreset } from "@/lib/visuals"
import { parseVisualsLayout, type LayoutPart, type LayoutScreen, type PartPlace, type VisualsLayout } from "@/lib/visuals-layout"

export type BuilderDraft = {
  straps: StrapPreset[]
  strapAccent: string
  strapText: string
  strapAccentCircle: boolean
  strapArrow: boolean
  visualsLayout: VisualsLayout
  logos: Logos
  qr: QrConfig
  scenes: Record<SceneId, SceneCard>
}
export const DRAFT_KEYS = ["straps", "strapAccent", "strapText", "strapAccentCircle", "strapArrow", "visualsLayout", "logos", "qr", "scenes"] as const satisfies readonly (keyof StageOptions)[]

export function draftFrom(stage: StageOptions): BuilderDraft {
  return {
    straps: stage.straps,
    strapAccent: stage.strapAccent,
    strapText: stage.strapText,
    strapAccentCircle: stage.strapAccentCircle,
    strapArrow: stage.strapArrow,
    visualsLayout: parseVisualsLayout(stage.visualsLayout),
    logos: parseLogos(stage.logos),
    qr: parseQr(stage.qr),
    scenes: parseScenes(stage.scenes),
  }
}

export function draftDirty(stage: StageOptions, draft: BuilderDraft): boolean {
  return JSON.stringify(draftFrom(stage)) !== JSON.stringify(draft)
}

export type LoadedEvent = { event: unknown; stage: Record<string, unknown>; rev: number; testUntil: number | null; pausedAt: number | null }

/**
 * PUT /api/event body: the full event + stage + rev as loaded, the test clock sent back unchanged,
 * with only the draft (save-path) fields replaced.
 */
export function saveBody(loaded: LoadedEvent, draft: BuilderDraft) {
  return {
    event: loaded.event,
    stage: { ...loaded.stage, ...Object.fromEntries(DRAFT_KEYS.map((k) => [k, draft[k]])) },
    rev: loaded.rev,
    testUntil: loaded.testUntil,
    pausedAt: loaded.pausedAt,
  }
}

export function setPlace(layout: VisualsLayout, screen: LayoutScreen, part: LayoutPart, patch: Partial<PartPlace>): VisualsLayout {
  return parseVisualsLayout({ ...layout, [screen]: { ...layout[screen], [part]: { ...layout[screen][part], ...patch } } })
}

export function addStrap(straps: StrapPreset[], now = Date.now(), random = Math.random()): StrapPreset[] {
  if (straps.length >= STRAP_MAX) return straps
  return [...straps, { id: newStrapId(now, random), name: "New speaker", title: "Job title · Company", handle: "", platform: "none", style: "house" }]
}

export function duplicateStrap(straps: StrapPreset[], id: string, now = Date.now(), random = Math.random()): StrapPreset[] {
  const i = straps.findIndex((s) => s.id === id)
  if (i < 0 || straps.length >= STRAP_MAX) return straps
  const copy = { ...straps[i], id: newStrapId(now, random), name: `${straps[i].name} (copy)`.slice(0, 120) }
  return [...straps.slice(0, i + 1), copy, ...straps.slice(i + 1)]
}

export function deleteStrap(straps: StrapPreset[], id: string): StrapPreset[] {
  return straps.filter((s) => s.id !== id)
}

/**
 * The stage the preview draws: saved stage, then the live deck values, then the draft.
 * `showAll` forces every part on (preview only, never saved) so the layout can be judged.
 */
export function previewStage(saved: Record<string, unknown>, live: Record<string, unknown> | undefined, draft: BuilderDraft, opts: { showAll: boolean; strapId?: string; now: number; logo?: LogoId }): StageOptions {
  const base = parseStage({ ...saved, ...(live ?? {}), ...draft })
  if (!opts.showAll) return base
  const strapId = opts.strapId && base.straps.some((s) => s.id === opts.strapId) ? opts.strapId : base.straps[0]?.id ?? ""
  const timerStopped = base.talkEndsAt === null && base.talkPausedMs === null
  return {
    ...base,
    streamVisuals: true,
    strapId,
    strapMode: "in",
    strapAt: opts.now,
    talkVisible: true,
    ...(timerStopped ? { talkPausedMs: 10 * 60_000 } : {}),
    tickerVisible: true,
    tickerItems: base.tickerItems.length ? base.tickerItems : ["Ticker preview · type items in the Inspector"],
    qaVisible: true,
    sponsorVisible: true,
    socialsOverlay: true,
    // One logo at a time (they share a slot): the picked one, else Logo 1.
    logosOn: [opts.logo && LOGO_IDS.includes(opts.logo) ? opts.logo : "logo1"],
    qrOn: true,
    qrLogoOn: true,
  }
}

/**
 * Builder › Program preview: which relay input to play behind the overlays (the one on air, main or
 * backup, same as /stream), or null for the placeholder (feed toggle off, or no program arriving).
 */
export function builderProgramFeed(state: { programSource?: "main" | "backup"; programReady?: boolean | null; programSources?: { main?: { ready?: boolean }; backup?: { ready?: boolean } } | null } | null, enabled: boolean): { path: string | null; source: "main" | "backup"; signal: boolean } {
  const source = state?.programSource === "backup" ? "backup" : "main"
  const signal = state?.programSources?.[source]?.ready ?? state?.programReady === true
  return { path: enabled && signal ? (source === "backup" ? "program-backup" : "program") : null, source, signal }
}
