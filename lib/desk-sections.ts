/**
 * Desk sections that are edited as a draft and published with Save.
 * Pure helpers (no React) so the rules are unit-tested.
 *
 * Immediate controls (test clock, pause, go live, show end/break/hold card, encoder) are NOT here:
 * they always go straight to /stream.
 */
import type { EventConfig } from "@/lib/event"
import type { StageOptions } from "@/lib/stage"

export type DeskSnapshot = { event: EventConfig; stage: StageOptions }
export type SectionId = "event" | "cta" | "look" | "socials" | "endCard" | "speakers" | "breakCard" | "holdCard" | "welcomeCard"

export const SECTIONS: Record<SectionId, { label: string; event?: (keyof EventConfig)[]; stage?: (keyof StageOptions)[] }> = {
  event: { label: "Event", event: ["name", "date", "time", "endTime", "timeZone", "venue"] },
  cta: { label: "Links & call to action", event: ["rsvpUrl", "badge", "rsvpLabel", "scanLabel", "joinLabel", "eventLink", "eventLinkLabel"] },
  look: { label: "Look", stage: ["checker", "showMeta", "showLink", "transparent", "lineSpacing", "blockGap", "clockScale", "clockText", "logoUrl", "countdownStrokePx", "countdownStrokeColor"] },
  socials: { label: "Socials", event: ["xUrl", "facebookUrl", "linkedinUrl", "instagramUrl", "youtubeUrl"], stage: ["socialSpotlight", "socialDwellMs", "socialCooldownMs", "socialStrokePx", "socialStrokeColor", "socialShowHandle"] },
  endCard: { label: "End card", stage: ["endTitle", "endSubtitle", "endDate", "endBody", "endQrUrl", "endButton", "endAt"] },
  speakers: { label: "Speakers", stage: ["speakers", "gallerySeconds", "galleryPause", "galleryOffset", "galleryScale"] },
  breakCard: { label: "Break card", stage: ["breakTitle", "breakMessage", "breakImage", "breakFit"] },
  holdCard: { label: "Hold card", stage: ["holdTitle", "holdMessage", "holdImage", "holdFit"] },
  welcomeCard: { label: "Welcome back card", stage: ["welcomeTitle", "welcomeMessage", "welcomeImage", "welcomeFit"] },
}

export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[]

/** Stage fields that are live switches, always taken from the desk's current state. */
export const IMMEDIATE_STAGE: (keyof StageOptions)[] = ["forceEnd", "holdCountdown", "overlay", "overlayAt", "deskLive", "program", "programSource"]

export type SectionValues = { event?: Partial<EventConfig>; stage?: Partial<StageOptions> }

export function pickSection(id: SectionId, snap: DeskSnapshot): SectionValues {
  const def = SECTIONS[id]
  const out: SectionValues = {}
  if (def.event) out.event = Object.fromEntries(def.event.map((k) => [k, snap.event[k]])) as Partial<EventConfig>
  if (def.stage) out.stage = Object.fromEntries(def.stage.map((k) => [k, snap.stage[k]])) as Partial<StageOptions>
  return out
}

export function sectionDirty(id: SectionId, draft: DeskSnapshot, published: DeskSnapshot): boolean {
  return JSON.stringify(pickSection(id, draft)) !== JSON.stringify(pickSection(id, published))
}

export function dirtySections(draft: DeskSnapshot, published: DeskSnapshot | null): SectionId[] {
  if (!published) return []
  return SECTION_IDS.filter((id) => sectionDirty(id, draft, published))
}

/** `target` with section `id` replaced by the values from `source` (save: source = draft; revert: source = old published). */
export function withSection(id: SectionId, target: DeskSnapshot, source: DeskSnapshot): DeskSnapshot {
  const values = pickSection(id, source)
  return {
    event: values.event ? { ...target.event, ...values.event } : target.event,
    stage: values.stage ? { ...target.stage, ...values.stage } : target.stage,
  }
}

/** What autosave sends: the published sections plus the desk's live switches. Drafts never leave the browser. */
export function savePayloadStage(published: DeskSnapshot, draft: DeskSnapshot): StageOptions {
  const stage = { ...published.stage }
  for (const key of IMMEDIATE_STAGE) (stage as Record<string, unknown>)[key] = draft.stage[key]
  return stage
}

/**
 * Another device saved. For every section whose saved values changed remotely:
 * - not dirty here (or my draft already equals theirs): take theirs silently;
 * - dirty here with a different draft: conflict, the operator picks "Load theirs" / "Keep mine".
 */
export function planRemoteSync(draft: DeskSnapshot, published: DeskSnapshot, remote: DeskSnapshot): { take: SectionId[]; conflicts: SectionId[] } {
  const take: SectionId[] = []
  const conflicts: SectionId[] = []
  for (const id of SECTION_IDS) {
    if (!sectionDirty(id, remote, published)) continue
    if (sectionDirty(id, draft, published) && sectionDirty(id, draft, remote)) conflicts.push(id)
    else take.push(id)
  }
  return { take, conflicts }
}

/** Preview clock offset from the shared clock fields. null testUntil and no pause = real time (0). */
export function previewSkew(targetMs: number, testUntil: number | null, pausedMs: number | null, current: number): number {
  if (testUntil) return targetMs - testUntil
  if (!pausedMs) return 0
  return current
}
