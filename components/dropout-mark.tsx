"use client"
/**
 * ⚑ Mark (desk / deck / phone): a small menu of operator markers → one "[operator]" line in the dropout
 * log (POST /api/diag/mark). Problem marks (blackout / frozen / audio) become incidents (15s before → 5s
 * after, YouTube runs behind); on-purpose marks (stopped / back on / test) label the relay lines they
 * cause as expected. The desk's "Dropout log" section lists them with a Copy all button.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react"
import { copyText } from "@/lib/copy-text"
import { MARK_TYPES, NOTE_MAX, type MarkPage, type MarkType } from "@/lib/marks"

export type { MarkPage, MarkType }
export type MarkResult = { ok: true; time: string; label: string } | { ok: false; error: string }
export async function markDropout(page: MarkPage, type: MarkType = "blackout", note = ""): Promise<MarkResult> {
  try {
    const r = await fetch("/api/diag/mark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page, type, note }), cache: "no-store" })
    const body = (await r.json().catch(() => ({}))) as { time?: string; label?: string; error?: string }
    return r.ok && body.time ? { ok: true, time: body.time, label: body.label ?? MARK_TYPES[type].label } : { ok: false, error: body.error ?? `Mark failed (${r.status})` }
  } catch {
    return { ok: false, error: "Mark failed: server not reachable" }
  }
}
/** "Marked 11:41:03 · Frozen/stutter" (the shared toast). */
export const markToast = (r: Extract<MarkResult, { ok: true }>) => `Marked ${r.time} · ${r.label}`

const GROUPS: { title: string; types: MarkType[]; problem?: boolean }[] = [
  { title: "Seen on YouTube", types: ["blackout", "frozen", "audio"], problem: true },
  { title: "On purpose", types: ["main-stopped", "backup-stopped", "main-back", "backup-back"] },
  { title: "On purpose · outputs", types: ["capture-stopped", "vertical-stopped", "capture-back", "vertical-back"] },
  { title: "Test", types: ["test-start", "test-end"] },
]

/** The small "⚑ Mark" pill and its menu (chips + optional note). `onMark` writes and toasts. */
export function MarkMenu({ onMark, dark = false, disabled = false }: { onMark: (type: MarkType, note: string) => void; dark?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState("")
  // Fixed to the viewport (anchored to the pill): the desk cards clip (overflow-hidden), and the menu
  // is taller than the space under the pill. Opens upward when there is more room above.
  const pillRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<CSSProperties>({})
  const place = () => {
    const r = pillRef.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom
    const right = Math.max(8, window.innerWidth - r.right)
    setPos(below >= 420 || below >= r.top ? { top: r.bottom + 4, right, maxHeight: below - 12 } : { bottom: window.innerHeight - r.top + 4, right, maxHeight: r.top - 12 })
  }
  const toggle = () => { if (!open) place(); setOpen((o) => !o) }
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    // Follow the pill if the page scrolls / resizes (phone keyboard for the note) instead of closing.
    window.addEventListener("keydown", key)
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place) }
  }, [open])
  const pick = (type: MarkType) => { onMark(type, note.trim()); setNote(""); setOpen(false) }
  const t = dark
    ? { pill: "bg-white/10 text-white/70", menu: "bg-[#1b1b22] text-white ring-1 ring-white/15", head: "text-white/45", chip: "bg-white/10 text-white", bad: "bg-[#f04438]/20 text-[#fda29b]", field: "bg-white/10 text-white placeholder:text-white/35" }
    : { pill: "border border-black/15 text-black/60", menu: "bg-white text-black ring-1 ring-black/10 shadow-lg", head: "text-black/45", chip: "bg-[#f1f0ec] text-black", bad: "bg-[#b42318]/10 text-[#b42318]", field: "bg-[#f1f0ec] text-black placeholder:text-black/35" }
  return (
    <div className="relative">
      <button ref={pillRef} type="button" data-testid="mark-menu" aria-expanded={open} aria-haspopup="menu" disabled={disabled} onClick={toggle}
        title="Saw something on YouTube, or stopping something on purpose? Mark the time in the dropout log (npm run dropouts / Dropout log)."
        className={`rounded-full px-2 py-0.5 font-mono text-[11px] disabled:opacity-50 ${t.pill}`}>
        ⚑ Mark
      </button>
      {open ? (
        <>
          <button type="button" aria-label="Close" tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
          <div role="menu" data-testid="mark-menu-panel" style={pos} className={`fixed z-40 w-72 max-w-[calc(100vw-16px)] space-y-2 overflow-y-auto overscroll-contain rounded-xl p-2.5 font-mono text-[11px] ${t.menu}`}>
            {GROUPS.map((g) => (
              <div key={g.title}>
                <p className={`mb-1 text-[10px] tracking-[0.1em] uppercase ${t.head}`}>{g.title}</p>
                <div className="flex flex-wrap gap-1">
                  {g.types.map((type) => (
                    <button key={type} type="button" role="menuitem" data-testid={`mark-${type}`} onClick={() => pick(type)}
                      className={`rounded-full px-2 py-1 ${g.problem ? t.bad : t.chip}`}>{MARK_TYPES[type].label}</button>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex gap-1">
              <input type="text" data-testid="mark-note" maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note…" title="Added to the next mark you tap (Enter or Note = note only)"
                onKeyDown={(e) => { if (e.key === "Enter" && note.trim()) pick("note") }}
                className={`min-w-0 flex-1 rounded-full px-2 py-1 outline-none ${t.field}`} />
              <button type="button" data-testid="mark-note-only" disabled={!note.trim()} onClick={() => pick("note")} className={`rounded-full px-2 py-1 disabled:opacity-40 ${t.chip}`}>Note</button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

export function DropoutLogPanel({ onToast, refresh = 0 }: { onToast: (tone: "ok" | "error", text: string) => void; refresh?: number }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ marks: { at: number; text: string }[]; markers: string[]; problemsLast10Min: number; expectedLast10Min: number; copy: string } | null>(null)
  const [loadedFor, setLoadedFor] = useState(-1)
  const load = () => {
    void fetch("/api/diag/log", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((b) => setData(b)).catch(() => setData(null))
  }
  if (open && loadedFor !== refresh) { setLoadedFor(refresh); load() }
  const all = data?.copy ?? ""
  return (
    <details data-testid="dropout-log" className="font-mono text-[11px] text-black/70" onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; setOpen(o); if (o) load() }}>
      <summary className="cursor-pointer">Dropout log{data ? ` · ${data.marks.length} mark${data.marks.length === 1 ? "" : "s"}${data.markers.length ? ` · ${data.markers.length} on purpose` : ""} · ${data.problemsLast10Min} problem lines in 10 min${data.expectedLast10Min ? ` (+${data.expectedLast10Min} expected)` : ""}` : ""}</summary>
      {open ? (
        <div className="mt-1 space-y-1.5">
          <div className="flex gap-2">
            <button type="button" data-testid="dropout-log-copy" disabled={!all} className="rounded-full border border-black/15 px-2 py-0.5 disabled:opacity-40" onClick={() => { void copyText(all).then((r) => onToast(r === "copied" ? "ok" : "error", r === "copied" ? "Dropout log copied" : "Copy blocked: select the text")) }}>Copy all</button>
            <button type="button" className="rounded-full border border-black/15 px-2 py-0.5" onClick={load}>Refresh</button>
          </div>
          {data && !data.marks.length && !data.markers.length ? <p>No marks yet (last 6 h). Tap ⚑ Mark when YouTube goes black / freezes / loses audio, or before stopping something on purpose.</p> : null}
          {data?.marks.map((m) => (
            <pre key={m.at} data-testid="dropout-log-mark" className="max-h-64 overflow-auto rounded bg-black/[0.04] p-1.5 text-[10px] leading-snug whitespace-pre-wrap select-all">{m.text}</pre>
          ))}
          {data?.markers.length ? (
            <pre data-testid="dropout-log-markers" className="max-h-40 overflow-auto rounded bg-black/[0.04] p-1.5 text-[10px] leading-snug whitespace-pre-wrap select-all">{`On purpose (relay lines labelled expected):\n${data.markers.join("\n")}`}</pre>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}
