"use client"
import { MarkMenu, type MarkType } from "@/components/dropout-mark"

import { rttLabel } from "@/lib/rtt"

import { useEffect, useRef, useState } from "react"
import { PROGRAM_SOURCES, SOURCE_LABEL, type FailoverEvent, type FailoverSettings, type ProgramSource, type SourceHealth, hasSignal } from "@/lib/program-source"
import type { ProgramSourcesView } from "@/lib/transport"
import { disarmPlan, FEED_LABEL, feedDisarmedInView, other, type ArmScope, type Feed } from "@/lib/program-arm"

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
export function ProgramSourceSwitch({ view, active, onSwitch, onFailover, onMark, onArm, dark = false, disabled = false, pending = null, onBlocked }: {
  /** Per-feed Disarm/Arm (two taps; on-air disarm warns when the other feed isn't healthy) */
  onArm?: (op: "arm" | "disarm", feed: ArmScope) => void
  /** "⚑ Mark" menu (dropout log markers) next to the inputs */
  onMark?: (type: MarkType, note: string) => void
  view: ProgramSourcesView | null
  active: ProgramSource
  onSwitch: (source: ProgramSource) => void
  onFailover: (patch: Partial<FailoverSettings>) => void
  dark?: boolean
  disabled?: boolean
  /** A switch to this source is in flight: its button says "Switching…" and both buttons ignore taps. */
  pending?: ProgramSource | null
  /** Given: a feed with no signal stays tappable and reports why it can't switch (instead of a silent disabled button). */
  onBlocked?: (text: string) => void
}) {
  const f = view?.failover
  const [stall, setStall] = useState<string | null>(null)
  const [ret, setRet] = useState<string | null>(null)
  const [buf, setBuf] = useState<string | null>(null)
  const [xf, setXf] = useState<string | null>(null)
  // Manual switch = two taps (like the other risky buttons): the first arms "Tap again…" for 3s.
  // Auto-failover and "Return now" don't go through this.
  const [armed, setArmed] = useState<ProgramSource | null>(null)
  useEffect(() => {
    if (!armed) return
    const id = window.setTimeout(() => setArmed(null), 3000)
    return () => window.clearTimeout(id)
  }, [armed])
  const armedFor = armed !== null && armed !== active ? armed : null
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
          // Disarmed (per feed, or the whole relay when view is null): shown on the button, Arm is below.
          const off = feedDisarmedInView(view, source)
          const stateCls = state === "healthy" ? "bg-[#067647] text-white" : state === "suspect" ? "bg-[#f79009] text-black" : "bg-[#b42318] text-white"
          return (
            <button key={source} type="button" role="radio" aria-checked={on} data-testid={`program-source-${source}`} data-state={st.tone} disabled={disabled || (dead && !onBlocked)} aria-disabled={(dead && !!onBlocked) || !!pending || undefined} data-no-signal={dead || undefined} data-pending={pending === source ? "1" : undefined} title={dead ? `${SOURCE_LABEL[source]}: no signal` : undefined} data-armed={armedFor === source ? "1" : undefined} data-disarmed={off || undefined} onClick={() => {
                if (pending) return
                if (dead) { setArmed(null); onBlocked?.(`${SOURCE_LABEL[source]} has no signal, so it can't go on air. Check OBS is sending to it.`); return }
                if (on) { onSwitch(source); return }
                if (armedFor !== source) { setArmed(source); return }
                setArmed(null)
                if (notReady && typeof window !== "undefined" && !window.confirm(`${SOURCE_LABEL[source]} is not READY (${h?.issues?.join(", ")}). Switch anyway?`)) return
                onSwitch(source)
              }}
              onBlur={() => { if (armedFor === source) setArmed(null) }}
              className={`min-h-16 min-w-0 overflow-hidden rounded-xl px-2.5 py-2 text-left disabled:opacity-50 ${dead && onBlocked ? "opacity-50" : ""} ${on ? (dark ? "bg-[#D9FF43] text-black" : "bg-black text-white") : dark ? "bg-white/10 text-white" : "border border-black/15 bg-white text-black"} ${armedFor === source ? (dark ? "ring-4 ring-[#fdb022] ring-offset-2 ring-offset-[#0b0b0f]" : "ring-2 ring-[#b42318] ring-offset-2") : ""}`}>
              <span className="flex min-w-0 items-center gap-1.5">
                {view && h?.ready ? <span data-testid={`program-source-${source}-ready`} data-ready={h.readyOk ? "yes" : "no"} title={h.readyOk ? "READY: video + audio, fps stable, data fresh, 48 kHz" : `Not ready: ${h.issues?.join(", ")}`} aria-label={h.readyOk ? "READY" : "not ready"} className={`size-2.5 shrink-0 rounded-full ${h.readyOk ? "bg-[#12b76a]" : "border-2 border-[#f79009]"}`} /> : null}
                <span className="min-w-0 truncate text-[15px] font-black">{on ? "● " : ""}{SOURCE_LABEL[source]}{source === "backup" && view?.backup.pull ? " (pull)" : ""}</span>
                {off ? <span data-testid={`program-source-${source}-disarmed`} className="ml-auto shrink-0 rounded border border-current px-1 py-px font-mono text-[9px] font-bold leading-tight text-[#f79009]">DISARMED</span> : null}
                {view && state && !off ? <span data-testid={`program-source-${source}-state`} data-input-state={state} title={h?.stateReason ?? undefined} className={`ml-auto shrink-0 rounded px-1 py-px font-mono text-[9px] font-bold leading-tight ${stateCls}`}>{STATE_LABEL[state]}</span> : null}
              </span>
              {pending === source ? <span data-testid={`program-source-${source}-pending`} className={`block font-mono text-[11px] font-bold ${dark ? "text-[#fdb022]" : "text-[#b54708]"}`}>Switching…</span> : null}
              {armedFor === source && pending !== source ? <span data-testid={`program-source-${source}-confirm`} className={`block font-mono text-[11px] font-bold ${dark ? "text-[#fdb022]" : "text-[#b42318]"}`}>Tap again to switch to {SOURCE_LABEL[source]}</span> : null}
              <span data-testid={`program-source-${source}-status`} className={`block truncate font-mono text-[11px] ${on ? "" : tones[st.tone]}`}>{view && off ? "DISARMED · OBS can't publish · Arm below" : view ? (dead ? `no signal · ${st.text}` : h?.ready ? (h.readyOk ? "READY" : `not ready: ${h.issues?.join(", ")}`) : st.text) : "DISARMED · two-tap Arm below"}</span>
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
      {onArm ? <ArmControls view={view} active={active} onArm={onArm} dark={dark} disabled={disabled} /> : null}
      {onMark ? <div className="flex justify-end"><MarkMenu onMark={onMark} dark={dark} /></div> : null}
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
          <label className="flex items-center gap-1.5" title="After a Wi-Fi drop: when the on-air input comes back READY (3s stable), disarm and re-arm it once so audio and video resync. At most once per 20s.">
            <input type="checkbox" data-testid="failover-auto-rearm" checked={f.autoRearm} disabled={disabled} onChange={(e) => onFailover({ autoRearm: e.target.checked })} />
            Auto re-arm after reconnect
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
          <label className="flex items-center gap-1" title="Flapping guard (Automatic): more than N Main failures in the window → hold Backup until Main is stable this long">flapping: {">"}
            <input type="number" min={1} max={20} data-testid="failover-flap-count" disabled={disabled} defaultValue={f.flapCount} key={`fc${f.flapCount}`} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== f.flapCount) onFailover({ flapCount: v }) }} className={`w-10 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />fails in
            <input type="number" min={1} max={60} data-testid="failover-flap-window" disabled={disabled} defaultValue={f.flapWindowSec / 60} key={`fw${f.flapWindowSec}`} onBlur={(e) => { const v = Math.round(Number(e.target.value) * 60); if (v > 0 && v !== f.flapWindowSec) onFailover({ flapWindowSec: v }) }} className={`w-10 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />min → hold until stable
            <input type="number" min={5} max={1800} data-testid="failover-flap-stable" disabled={disabled} defaultValue={f.flapStableSec} key={`fs${f.flapStableSec}`} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== f.flapStableSec) onFailover({ flapStableSec: v }) }} className={`w-14 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />s
          </label>
          <label className="flex items-center gap-1">switch buffer
            <input type="number" min={0} max={5} step={0.5} data-testid="failover-switch-buffer" disabled={disabled} value={buf ?? String(f.switchBufferMs / 1000)} onChange={(e) => setBuf(e.target.value)} onBlur={() => { if (buf !== null && Number(buf) >= 0) onFailover({ switchBufferMs: Math.round(Number(buf) * 1000) }); setBuf(null) }} className={`w-12 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />s
          </label>
          <label className="flex items-center gap-1" title="Main↔Backup audio, manual and auto-failover. Crossfade blends the two inputs (equal-power) when both have audio; a dead input always cuts. The picture always cuts.">switch audio
            <select data-testid="failover-switch-audio" disabled={disabled} value={f.crossfadeMs > 0 ? "fade" : "cut"} onChange={(e) => onFailover({ crossfadeMs: e.target.value === "fade" ? 250 : 0 })} className={`rounded border px-1 ${dark ? "border-white/20 bg-black" : "border-black/20"}`}>
              <option value="cut">Hard cut</option>
              <option value="fade">Crossfade</option>
            </select>
            {f.crossfadeMs > 0 ? (
              <>
                <input type="number" min={100} max={1000} step={50} data-testid="failover-crossfade-ms" disabled={disabled} value={xf ?? String(f.crossfadeMs)} onChange={(e) => setXf(e.target.value)} onBlur={() => { const v = Number(xf); if (xf !== null && Number.isFinite(v)) onFailover({ crossfadeMs: Math.min(1000, Math.max(100, Math.round(v))) }); setXf(null) }} className={`w-14 rounded border px-1 ${dark ? "border-white/20 bg-transparent" : "border-black/20"}`} />ms
              </>
            ) : null}
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

/** POST the per-feed arm/disarm (desk + deck). */
export async function armFeed(op: "arm" | "disarm", feed: ArmScope): Promise<{ ok: boolean; text: string }> {
  const r = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: op === "arm" ? "arm-program" : "disarm-program", feed }) }).catch(() => null)
  const body = (await r?.json().catch(() => null)) as { note?: string | null; error?: string } | null
  return r?.ok ? { ok: true, text: body?.note ?? "Done" } : { ok: false, text: body?.error ?? "Failed" }
}

/** Healthy for a hand-over: publishing, READY, HEALTHY (same rule as the server). */
const healthy = (h: Readout | undefined) => Boolean(h?.ready && h.readyOk && h.state === "healthy")

/** Pure: the second-tap label of a disarm (the warning when it will hit the output). */
export function disarmConfirmText(scope: ArmScope, active: Feed, view: ProgramSourcesView | null): string {
  const plan = disarmPlan(scope, active, scope === "both" ? false : healthy(view?.[other(scope)]))
  if (plan.warning) return `${plan.warning} · tap again`
  if (plan.handoverTo) return `Switch to ${FEED_LABEL[plan.handoverTo]}, then disarm ${FEED_LABEL[scope as Feed]} · tap again`
  return `Disarm ${scope === "both" ? "both" : FEED_LABEL[scope]} (standby, no on-air effect) · tap again`
}

/** Main / Backup / Both Disarm–Arm row, two taps each. */
function ArmControls({ view, active, onArm, dark, disabled }: { view: ProgramSourcesView | null; active: Feed; onArm: (op: "arm" | "disarm", feed: ArmScope) => void; dark: boolean; disabled: boolean }) {
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    if (!armed) return
    const id = window.setTimeout(() => setArmed(null), 3000)
    return () => window.clearTimeout(id)
  }, [armed])
  const on = { main: view !== null && view.armed?.main !== false, backup: view !== null && view.armed?.backup !== false }
  const base = `min-h-11 rounded-xl px-2 py-1.5 text-[13px] font-bold leading-tight disabled:opacity-40`
  const tone = (danger: boolean, warn: boolean) => (warn ? "bg-[#fdb022] text-black" : danger ? (dark ? "bg-[#b42318] text-white" : "bg-[#b42318] text-white") : dark ? "bg-white/10 text-white" : "border border-black/15 bg-white text-black")
  const btn = (key: string, op: "arm" | "disarm", scope: ArmScope, label: string) => {
    const isArmed = armed === key
    const confirm = op === "disarm" ? disarmConfirmText(scope, active, view) : `Arm ${scope === "both" ? "both" : FEED_LABEL[scope]} · tap again`
    return (
      <button key={key} type="button" data-testid={`program-${op}-${scope}`} data-armed={isArmed ? "1" : undefined} disabled={disabled}
        onClick={() => { if (!isArmed) { setArmed(key); return } setArmed(null); onArm(op, scope) }}
        onBlur={() => { if (isArmed) setArmed(null) }}
        className={`${base} ${tone(op === "disarm" && !isArmed, isArmed)}`}>{isArmed ? confirm : label}</button>
    )
  }
  return (
    <div data-testid="program-arm-controls" className="grid grid-cols-3 gap-2">
      {(["main", "backup"] as const).map((f) => (on[f] ? btn(`d-${f}`, "disarm", f, `Disarm ${FEED_LABEL[f]}`) : btn(`a-${f}`, "arm", f, `Arm ${FEED_LABEL[f]}`)))}
      {on.main || on.backup ? btn("d-both", "disarm", "both", "Disarm both") : btn("a-both", "arm", "both", "Arm both")}
    </div>
  )
}
