"use client"

import { useEffect, useRef, useState } from "react"
import { PROGRAM_SOURCES, SOURCE_LABEL, type FailoverEvent, type FailoverSettings, type ProgramSource, type SourceHealth } from "@/lib/program-source"
import type { ProgramSourcesView } from "@/lib/transport"

/** "publishing · 3.2 Mb/s · 0.2s" / "stalled 4s" / "not publishing" for one input. */
export function sourceStatus(h: SourceHealth | undefined): { tone: "ok" | "warn" | "off"; text: string } {
  if (!h?.ready) return { tone: "off", text: "not publishing" }
  const age = h.dataAgeMs === null ? null : h.dataAgeMs / 1000
  if (age !== null && age >= 1.5) return { tone: "warn", text: `stalled · last data ${age.toFixed(0)}s ago` }
  const kbps = h.kbps === null ? "…" : h.kbps >= 1000 ? `${(h.kbps / 1000).toFixed(1)} Mb/s` : `${h.kbps} kb/s`
  return { tone: "ok", text: `publishing · ${kbps} · ${age === null ? "…" : `${age.toFixed(1)}s`}` }
}

export function failoverText(e: FailoverEvent): string {
  return `${e.auto ? "Auto-failover" : "Program source"}: ${SOURCE_LABEL[e.from]} → ${SOURCE_LABEL[e.to]} · ${e.reason}`
}

/** Calls `onEvent` once per new failover/switch event (not for the one already there on load). */
export function useFailoverEvents(last: FailoverEvent | null | undefined, onEvent: (e: FailoverEvent) => void) {
  const seen = useRef<number | null | undefined>(undefined)
  const cb = useRef(onEvent)
  useEffect(() => {
    cb.current = onEvent
  })
  useEffect(() => {
    const at = last?.at ?? null
    if (seen.current === undefined) { seen.current = at; return }
    if (at !== null && at !== seen.current && last) cb.current(last)
    seen.current = at
  }, [last])
}

/**
 * Main / Backup toggle with live status of each input and the auto-failover settings.
 * Used by the desk (Transport) and the phone deck (dark).
 */
export function ProgramSourceSwitch({ view, active, onSwitch, onFailover, dark = false, disabled = false }: {
  view: ProgramSourcesView | null
  active: ProgramSource
  onSwitch: (source: ProgramSource) => void
  onFailover: (patch: Partial<FailoverSettings>) => void
  dark?: boolean
  disabled?: boolean
}) {
  const f = view?.failover
  const [stall, setStall] = useState<string | null>(null)
  const [ret, setRet] = useState<string | null>(null)
  const muted = dark ? "text-white/60" : "text-black/60"
  const tones = { ok: dark ? "text-[#6ce9a6]" : "text-[#067647]", warn: "text-[#f79009]", off: muted }
  return (
    <div data-testid="program-source" data-active={active} className="space-y-2">
      <div role="radiogroup" aria-label="Program source" className="grid grid-cols-2 gap-2">
        {PROGRAM_SOURCES.map((source) => {
          const h = view?.[source]
          const st = sourceStatus(h)
          const on = active === source
          return (
            <button key={source} type="button" role="radio" aria-checked={on} data-testid={`program-source-${source}`} data-state={st.tone} disabled={disabled} onClick={() => onSwitch(source)}
              className={`min-h-16 rounded-xl px-3 py-2 text-left disabled:opacity-50 ${on ? (dark ? "bg-[#D9FF43] text-black" : "bg-black text-white") : dark ? "bg-white/10 text-white" : "border border-black/15 bg-white text-black"}`}>
              <span className="block text-[15px] font-black">{on ? "● " : ""}{SOURCE_LABEL[source]}{source === "backup" && view?.backup.pull ? " (pull)" : ""}</span>
              <span data-testid={`program-source-${source}-status`} className={`block font-mono text-[11px] ${on ? "" : tones[st.tone]}`}>{view ? st.text : "relay not armed"}</span>
            </button>
          )
        })}
      </div>
      {f ? (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] ${muted}`}>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" data-testid="failover-auto" checked={f.auto} disabled={disabled} onChange={(e) => onFailover({ auto: e.target.checked })} />
            Auto-failover
          </label>
          <label className="flex items-center gap-1">after
            <input type="number" min={1} max={60} data-testid="failover-stall" disabled={disabled} value={stall ?? String(f.stallSec)} onChange={(e) => setStall(e.target.value)} onBlur={() => { if (stall !== null && Number(stall) > 0) onFailover({ stallSec: Number(stall) }); setStall(null) }} className={`w-12 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />s stall
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" data-testid="failover-return" checked={f.autoReturn} disabled={disabled} onChange={(e) => onFailover({ autoReturn: e.target.checked })} />
            return to Main after
            <input type="number" min={2} max={600} data-testid="failover-return-sec" disabled={disabled || !f.autoReturn} value={ret ?? String(f.returnSec)} onChange={(e) => setRet(e.target.value)} onBlur={() => { if (ret !== null && Number(ret) > 0) onFailover({ returnSec: Number(ret) }); setRet(null) }} className={`w-14 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />s healthy
          </label>
        </div>
      ) : null}
      {view?.last ? <p data-testid="program-source-last" className={`font-mono text-[11px] ${muted}`}>Last: {failoverText(view.last)} · {new Date(view.last.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</p> : null}
    </div>
  )
}
