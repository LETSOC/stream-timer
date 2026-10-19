"use client"
/**
 * "Mark blackout": the operator saw a dropout on YouTube → one "! [operator]" line in the dropout log
 * (POST /api/diag/mark). The desk's "Dropout log" section lists the last marks with what happened in
 * the 15s before / 5s after, with a Copy button (paste it into the chat, no terminal needed).
 */
import { useState } from "react"
import { copyText } from "@/lib/copy-text"

export type MarkPage = "desk" | "deck" | "phone"
export async function markBlackout(page: MarkPage): Promise<{ ok: true; time: string } | { ok: false; error: string }> {
  try {
    const r = await fetch("/api/diag/mark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page }), cache: "no-store" })
    const body = (await r.json().catch(() => ({}))) as { time?: string; error?: string }
    return r.ok && body.time ? { ok: true, time: body.time } : { ok: false, error: body.error ?? `Mark failed (${r.status})` }
  } catch {
    return { ok: false, error: "Mark failed: server not reachable" }
  }
}

export function MarkBlackoutButton({ onMark, dark = false, disabled = false }: { onMark: () => void; dark?: boolean; disabled?: boolean }) {
  return (
    <button type="button" data-testid="mark-blackout" disabled={disabled} onClick={onMark} title="Saw a black/frozen picture on YouTube? Tap: marks the time in the dropout log (npm run dropouts / Dropout log)."
      className={`rounded-full px-2 py-0.5 font-mono text-[11px] disabled:opacity-50 ${dark ? "bg-white/10 text-white/70" : "border border-black/15 text-black/60"}`}>
      ⚑ Mark blackout
    </button>
  )
}

export function DropoutLogPanel({ onToast, refresh = 0 }: { onToast: (tone: "ok" | "error", text: string) => void; refresh?: number }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ marks: { at: number; text: string }[]; problemsLast10Min: number } | null>(null)
  const [loadedFor, setLoadedFor] = useState(-1)
  const load = () => {
    void fetch("/api/diag/log", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((b) => setData(b)).catch(() => setData(null))
  }
  if (open && loadedFor !== refresh) { setLoadedFor(refresh); load() }
  const all = data?.marks.map((m) => m.text).join("\n\n") ?? ""
  return (
    <details data-testid="dropout-log" className="font-mono text-[11px] text-black/70" onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; setOpen(o); if (o) load() }}>
      <summary className="cursor-pointer">Dropout log{data ? ` · ${data.marks.length} mark${data.marks.length === 1 ? "" : "s"} · ${data.problemsLast10Min} problem lines in 10 min` : ""}</summary>
      {open ? (
        <div className="mt-1 space-y-1.5">
          <div className="flex gap-2">
            <button type="button" data-testid="dropout-log-copy" disabled={!all} className="rounded-full border border-black/15 px-2 py-0.5 disabled:opacity-40" onClick={() => { void copyText(all).then((r) => onToast(r === "copied" ? "ok" : "error", r === "copied" ? "Dropout log copied" : "Copy blocked: select the text")) }}>Copy all</button>
            <button type="button" className="rounded-full border border-black/15 px-2 py-0.5" onClick={load}>Refresh</button>
          </div>
          {data && !data.marks.length ? <p>No marks yet (last 6 h). Tap ⚑ Mark blackout when YouTube goes black/frozen.</p> : null}
          {data?.marks.map((m) => (
            <pre key={m.at} data-testid="dropout-log-mark" className="max-h-64 overflow-auto rounded bg-black/[0.04] p-1.5 text-[10px] leading-snug whitespace-pre-wrap select-all">{m.text}</pre>
          ))}
        </div>
      ) : null}
    </details>
  )
}
