"use client"

import { rttLabel } from "@/lib/rtt"

import { useEffect, useRef, useState } from "react"
import { PROGRAM_SOURCES, SOURCE_LABEL, type FailoverEvent, type FailoverSettings, type ProgramSource, type SourceHealth, hasSignal } from "@/lib/program-source"
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
  if (e.from === e.to) return `${SOURCE_LABEL[e.to]} on air · ${e.reason}`
  return `${e.auto ? "Auto-failover" : "Program source"}: ${SOURCE_LABEL[e.from]} → ${SOURCE_LABEL[e.to]} · ${e.reason}`
}

type Readout = NonNullable<ProgramSourcesView["main"]>
const STATE_LABEL = { healthy: "HEALTHY", suspect: "SUSPECT", failed: "FAILED" } as const
/** "30 fps · 48 kHz stereo · 3.2 Mb/s · jitter 17ms · delay 1168ms · 0.2s" */
export function readoutText(h: Readout | undefined): string {
  if (!h?.ready) return ""
  const parts: string[] = []
  const st = h.stats
  parts.push(st?.fps != null ? `${st.fps}${st.fpsNominal ? `/${st.fpsNominal}` : ""} fps` : st?.video ? "fps …" : "no video")
  parts.push(st?.audio ? `${st.audio.hz / 1000} kHz ${st.audio.channels}` : "no audio")
  if (h.kbps !== null) parts.push(h.kbps >= 1000 ? `${(h.kbps / 1000).toFixed(1)} Mb/s` : `${h.kbps} kb/s`)
  if (h.jitterMs != null) parts.push(`jitter ${h.jitterMs}ms`)
  if (h.audioDelayMs != null) parts.push(`audio delay ${h.audioDelayMs}ms`)
  if (h.offsetMs) parts.push(`offset ${h.offsetMs > 0 ? "+" : ""}${h.offsetMs}ms`)
  if (h.dataAgeMs !== null) parts.push(`data ${(h.dataAgeMs / 1000).toFixed(1)}s`)
  return parts.join(" · ")
}

/** Short label/value rows for the button grid. */
export function readoutRows(h: Readout | undefined): [string, string][] {
  if (!h?.ready) return []
  const st = h.stats
  const kb = h.kbps === null ? "…" : h.kbps >= 1000 ? `${(h.kbps / 1000).toFixed(1)}M` : `${h.kbps}k`
  return [
    ["fps", st?.fps != null ? `${Math.round(st.fps)}${st.fpsNominal ? `/${Math.round(st.fpsNominal)}` : ""}` : st?.video ? "…" : "none"],
    ["aud", st?.audio ? `${st.audio.hz / 1000}k ${st.audio.channels === "mono" ? "1ch" : st.audio.channels === "stereo" ? "2ch" : st.audio.channels}` : "none"],
    ["rate", kb],
    ["jitter", h.jitterMs != null ? `${h.jitterMs}ms` : "–"],
    ["delay", h.audioDelayMs != null ? `${(h.audioDelayMs / 1000).toFixed(2)}s${h.offsetMs ? `${h.offsetMs > 0 ? "+" : ""}${h.offsetMs}` : ""}` : h.offsetMs ? `${h.offsetMs > 0 ? "+" : ""}${h.offsetMs}ms` : "–"],
    ["age", h.dataAgeMs !== null ? `${(h.dataAgeMs / 1000).toFixed(1)}s` : "–"],
  ]
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
  const [buf, setBuf] = useState<string | null>(null)
  const muted = dark ? "text-white/60" : "text-black/60"
  const tones = { ok: dark ? "text-[#6ce9a6]" : "text-[#067647]", warn: "text-[#f79009]", off: muted }
  return (
    <div data-testid="program-source" data-active={active} className="space-y-2">
      <div role="radiogroup" aria-label="Program source" className="grid grid-cols-2 gap-2">
        {PROGRAM_SOURCES.map((source) => {
          const h = view?.[source]
          const st = sourceStatus(h)
          const on = active === source
          const dead = !!view && !on && !hasSignal(h)
          const state = h?.state
          const notReady = !!view && hasSignal(h) && h?.readyOk === false
          const stateCls = state === "healthy" ? "bg-[#067647] text-white" : state === "suspect" ? "bg-[#f79009] text-black" : "bg-[#b42318] text-white"
          return (
            <button key={source} type="button" role="radio" aria-checked={on} data-testid={`program-source-${source}`} data-state={st.tone} disabled={disabled || dead} data-no-signal={dead || undefined} title={dead ? `${SOURCE_LABEL[source]}: no signal` : undefined} onClick={() => {
                if (!on && notReady && typeof window !== "undefined" && !window.confirm(`${SOURCE_LABEL[source]} is not READY (${h?.issues?.join(", ")}). Switch anyway?`)) return
                onSwitch(source)
              }}
              className={`min-h-16 min-w-0 overflow-hidden rounded-xl px-2.5 py-2 text-left disabled:opacity-50 ${on ? (dark ? "bg-[#D9FF43] text-black" : "bg-black text-white") : dark ? "bg-white/10 text-white" : "border border-black/15 bg-white text-black"}`}>
              <span className="flex min-w-0 items-center gap-1.5">
                {view && h?.ready ? <span data-testid={`program-source-${source}-ready`} data-ready={h.readyOk ? "yes" : "no"} title={h.readyOk ? "READY: video + audio, fps stable, data fresh, 48 kHz" : `Not ready: ${h.issues?.join(", ")}`} aria-label={h.readyOk ? "READY" : "not ready"} className={`size-2.5 shrink-0 rounded-full ${h.readyOk ? "bg-[#12b76a]" : "border-2 border-[#f79009]"}`} /> : null}
                <span className="min-w-0 truncate text-[15px] font-black">{on ? "● " : ""}{SOURCE_LABEL[source]}{source === "backup" && view?.backup.pull ? " (pull)" : ""}</span>
                {view && state ? <span data-testid={`program-source-${source}-state`} data-input-state={state} title={h?.stateReason ?? undefined} className={`ml-auto shrink-0 rounded px-1 py-px font-mono text-[9px] font-bold leading-tight ${stateCls}`}>{STATE_LABEL[state]}</span> : null}
              </span>
              <span data-testid={`program-source-${source}-status`} className={`block truncate font-mono text-[11px] ${on ? "" : tones[st.tone]}`}>{view ? (dead ? `no signal · ${st.text}` : h?.ready ? (h.readyOk ? "READY" : `not ready: ${h.issues?.join(", ")}`) : st.text) : "relay not armed"}</span>
              {view && h?.ready ? (
                <span data-testid={`program-source-${source}-readout`} className="mt-1 grid grid-cols-1 gap-x-1.5 font-mono text-[10px] leading-snug opacity-80 min-[520px]:grid-cols-2">
                  {readoutRows(h).map(([k, v]) => (
                    <span key={k} className="flex min-w-0 justify-between gap-1"><span className="shrink-0 opacity-60">{k}</span><span className="min-w-0 text-right break-all" title={v}>{v}</span></span>
                  ))}
                </span>
              ) : null}
              {view ? (() => {
                const r = h?.rtt
                const tone = r?.level === "bad" || r?.level === "lost" ? "text-[#f04438]" : r?.level === "high" ? "text-[#f79009]" : ""
                return <span data-testid={`program-source-${source}-rtt`} data-level={r?.level ?? ""} title={r?.host ? `${r.host} (${r.via}) · avg ${r.avgMs ?? "–"}ms max ${r.maxMs ?? "–"}ms · loss ${r.lossPct}% over 1 min` : "no publisher"} className={`mt-0.5 block truncate font-mono text-[10px] font-bold ${tone}`}>{rttLabel(r)}</span>
              })() : null}
              {view && h?.ready && h.stateReason ? <span className="block truncate font-mono text-[10px] text-[#f79009]" title={h.stateReason}>{h.stateReason}</span> : null}
            </button>
          )
        })}
      </div>
      {view?.returnStatus?.askReturn && active === "backup" ? (
        <button type="button" data-testid="return-now" disabled={disabled} onClick={() => onSwitch("main")} className="w-full rounded-xl bg-[#12b76a] px-3 py-2 text-[15px] font-black text-black">Main ready · Return now</button>
      ) : null}
      {view?.returnStatus?.holdText && active === "backup" ? <p data-testid="flap-hold" className="rounded-lg bg-[#f79009] px-3 py-1.5 font-mono text-[12px] font-bold text-black">{view.returnStatus.holdText}</p> : null}
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
            return to Main
          </label>
          <label className="flex items-center gap-1">
            <select data-testid="failover-return-mode" disabled={disabled || !f.autoReturn} value={f.returnMode} onChange={(e) => onFailover({ returnMode: e.target.value === "ask" ? "ask" : "auto" })} className={`rounded border px-1 ${dark ? "border-white/20 bg-black" : "border-black/20"}`}>
              <option value="auto">Automatic</option>
              <option value="ask">Ask me</option>
            </select>
            after
            <input type="number" min={2} max={600} data-testid="failover-return-sec" disabled={disabled || !f.autoReturn} value={ret ?? String(f.returnSec)} onChange={(e) => setRet(e.target.value)} onBlur={() => { if (ret !== null && Number(ret) > 0) onFailover({ returnSec: Number(ret) }); setRet(null) }} className={`w-14 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />s healthy
          </label>
          <label className="flex items-center gap-1" title="Flapping guard (Automatic): more than N Main failures in the window → hold Backup until Main is stable this long">flapping: &gt;
            <input type="number" min={1} max={20} data-testid="failover-flap-count" disabled={disabled} defaultValue={f.flapCount} key={`fc${f.flapCount}`} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== f.flapCount) onFailover({ flapCount: v }) }} className={`w-10 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />fails in
            <input type="number" min={1} max={60} data-testid="failover-flap-window" disabled={disabled} defaultValue={f.flapWindowSec / 60} key={`fw${f.flapWindowSec}`} onBlur={(e) => { const v = Math.round(Number(e.target.value) * 60); if (v > 0 && v !== f.flapWindowSec) onFailover({ flapWindowSec: v }) }} className={`w-10 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />min → hold until stable
            <input type="number" min={5} max={1800} data-testid="failover-flap-stable" disabled={disabled} defaultValue={f.flapStableSec} key={`fs${f.flapStableSec}`} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== f.flapStableSec) onFailover({ flapStableSec: v }) }} className={`w-14 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />s
          </label>
          <label className="flex items-center gap-1">switch buffer
            <input type="number" min={0} max={5} step={0.5} data-testid="failover-switch-buffer" disabled={disabled} value={buf ?? String(f.switchBufferMs / 1000)} onChange={(e) => setBuf(e.target.value)} onBlur={() => { if (buf !== null && Number(buf) >= 0) onFailover({ switchBufferMs: Math.round(Number(buf) * 1000) }); setBuf(null) }} className={`w-12 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />s
          </label>
        </div>
      ) : null}
      {view?.last ? <p data-testid="program-source-last" className={`font-mono text-[11px] ${muted}`}>Last: {failoverText(view.last)} · {new Date(view.last.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</p> : null}
      {view?.history && view.history.length > 1 ? (
        <details data-testid="program-source-history" className={`font-mono text-[11px] ${muted}`}>
          <summary className="cursor-pointer">Switch history ({view.history.length})</summary>
          <ol className="mt-1 space-y-0.5">
            {view.history.map((e) => (
              <li key={`${e.at}-${e.to}`} data-testid="program-source-history-item">{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · {failoverText(e)}</li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  )
}
