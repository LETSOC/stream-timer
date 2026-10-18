"use client"
/**
 * The one toast: a small dark pill bottom-left (dot + short text), mirroring the top nav's status
 * chips. Never blocks taps (pointer-events-none) except its Undo link, and a "select this" text
 * (clipboard blocked) which must stay selectable.
 */
export const TOAST_MS = 2500
export const TOAST_UNDO_MS = 6000

export function StatusToast({ tone, text, testid = "toast", undoTestid, onUndo, selectable = false, kind }: {
  tone: "ok" | "error" | "warn"
  text: string
  testid?: string
  undoTestid?: string
  onUndo?: () => void
  /** keep the text selectable (copy fallback) */
  selectable?: boolean
  kind?: string
}) {
  const dot = tone === "error" ? "bg-[#f04438]" : tone === "warn" ? "bg-[#f79009]" : "bg-[#12b76a]"
  return (
    <p role="status" aria-live="polite" data-testid={testid} data-tone={tone} data-kind={kind}
      className={`${selectable ? "" : "pointer-events-none"} fixed bottom-[max(12px,env(safe-area-inset-bottom))] left-[max(12px,env(safe-area-inset-left))] z-[60] inline-flex max-w-[calc(100vw-24px)] items-center gap-1.5 rounded-full bg-black/80 px-2.5 py-1 font-mono text-[12px] text-white/85 backdrop-blur ${tone === "error" ? "ring-1 ring-[#f04438]/50" : "ring-1 ring-white/10"}`}>
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
      <span className={selectable ? "break-all select-all" : "truncate"}>{text}</span>
      {onUndo ? <> · <button type="button" data-testid={undoTestid} className="pointer-events-auto underline underline-offset-4" onClick={onUndo}>Undo</button></> : null}
    </p>
  )
}
