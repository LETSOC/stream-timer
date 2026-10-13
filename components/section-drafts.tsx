"use client"

import { useEffect, useMemo, useRef } from "react"
import { dirtySections, pickSection, SECTIONS, type DeskSnapshot, type SectionId, type SectionValues } from "@/lib/desk-sections"

export const DRAFTS_KEY = "hyphen-desk-drafts"

/** Saved drafts from a previous visit (applied on top of the server state after load). */
export function readStoredDrafts(): Partial<Record<SectionId, SectionValues>> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? "{}") as unknown
    return raw && typeof raw === "object" ? (raw as Partial<Record<SectionId, SectionValues>>) : {}
  } catch {
    return {}
  }
}

/**
 * Per-section draft bookkeeping: which sections differ from what /stream has,
 * keeps those drafts in localStorage (survives reload and 409 "reload latest"),
 * and warns before leaving with unsaved work.
 */
export function useSectionDrafts(draft: DeskSnapshot, published: DeskSnapshot | null, enabled: boolean) {
  const dirty = useMemo(() => dirtySections(draft, published), [draft, published])
  const dirtyKey = dirty.join(",")
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  })

  useEffect(() => {
    if (!enabled) return
    const stored: Partial<Record<SectionId, SectionValues>> = {}
    for (const id of dirty) stored[id] = pickSection(id, draft)
    if (dirty.length) window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(stored))
    else window.localStorage.removeItem(DRAFTS_KEY)
  }, [enabled, dirty, draft])

  useEffect(() => {
    if (!dirtyKey) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirtyKey])

  return { dirty, isDirty: (id: SectionId) => dirty.includes(id) }
}

/** Save / Discard strip shown at the top of a section while it has a draft. */
export function DraftBar({ id, dirty, canSave, onSave, onDiscard, pillClass }: { id: SectionId; dirty: boolean; canSave: boolean; onSave: () => void; onDiscard: () => void; pillClass: (tone: "live" | "outline", size: "sm") => string }) {
  if (!dirty) return null
  return (
    <div data-testid={`draft-bar-${id}`} className="flex flex-wrap items-center gap-2 rounded-2xl border border-[#b45309]/40 bg-[#b45309]/10 p-3">
      <span className="font-mono text-[12px] font-bold text-[#7a3b06]">Draft: {SECTIONS[id].label} is not on /stream until you save.</span>
      <button type="button" data-testid={`save-${id}`} className={pillClass("live", "sm")} disabled={!canSave} onClick={onSave}>Save</button>
      <button type="button" data-testid={`discard-${id}`} className={pillClass("outline", "sm")} onClick={onDiscard}>Discard</button>
    </div>
  )
}
