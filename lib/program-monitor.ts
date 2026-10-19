import { rttView, startRttMonitor } from "@/lib/rtt-monitor"
/**
 * Server-side watcher for the two program inputs (Main /program, Backup /program-backup): keeps their
 * health fresh, runs auto-failover, and tells deck sockets when anything visible changed.
 * Started once by server.ts; state lives on globalThis (Next's bundle and server.ts share it).
 */
import { eventBus } from "@/lib/event-bus"
import { readServerState } from "@/lib/event-server"
import { failoverStep, FRESH_MEMORY, SOURCE_LABEL, type FailoverEvent, type FailoverMemory } from "@/lib/program-source"
import fs from "node:fs"
import path from "node:path"
import { syncMdns } from "@/lib/mdns"
import { FRESH_REARM, noteRelayDisruption, rearmStep, relayQuietUntil, type RearmMemory } from "@/lib/program-rearm"
import { armProgram, disarmProgram, programSourceHealth, readSettings, relayDir, wantedMdns, refreshProgramSources, verifyMediamtxConfig } from "@/lib/relay"
import type { ProgramSourcesView } from "@/lib/transport"
import { runServerTransport } from "@/lib/transport-server"
import { inputState, nextBaseline, readiness, type InputReadout } from "@/lib/input-state"
import { inputStats, syncInputProbe } from "@/lib/input-probe"
import { BACKUP_PATH, PROGRAM_PATH, relayReadUrl } from "@/lib/relay"
import { readChannelStatus } from "@/lib/encoder"
import { changeLogger, plog, PROGRAM_LOG_VERBOSE } from "@/lib/program-log"
import { dlog } from "@/lib/dropout-log"
const onChange = changeLogger()
/** First state after a server start is context, not an incident. */
const stateSeen = new Set<string>()
let verboseAt = 0
import type { ProgramSource, ReturnStatus, SourceHealth } from "@/lib/program-source"

const KEY = Symbol.for("stream-timer.program-monitor")
type Monitor = { timer: NodeJS.Timeout | null; memory: FailoverMemory; last: FailoverEvent | null; log: FailoverEvent[]; sig: string; baseline: Record<ProgramSource, number | null>; status: ReturnStatus | null; rearm?: Record<ProgramSource, RearmMemory>; downAt?: Record<ProgramSource, number | null>; rearming?: boolean }
function monitor(): Monitor {
  const holder = globalThis as { [KEY]?: Monitor }
  if (!holder[KEY]) {
    // The last switch survives a server restart: devices still see it, and an auto-failover to Backup
    // still auto-returns afterwards.
    const log = loadLog()
    const last = log.at(-1) ?? null
    holder[KEY] = { timer: null, memory: { ...FRESH_MEMORY, failedOver: Boolean(last?.auto && last.to === "backup") }, last, log, sig: "", baseline: { main: null, backup: null }, status: null }
  }
  return holder[KEY]
}
export const HISTORY_MAX = 20
const historyFile = () => path.join(relayDir(), "program-switch-history.json")
const validEvent = (e: unknown): e is FailoverEvent => Boolean(e && typeof (e as FailoverEvent).at === "number" && ((e as FailoverEvent).to === "main" || (e as FailoverEvent).to === "backup"))
function loadLog(): FailoverEvent[] {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(), "utf8")) as unknown
    if (Array.isArray(raw)) return raw.filter(validEvent).slice(-HISTORY_MAX)
  } catch { /* none yet */ }
  try { // older builds kept only the last switch
    const one = JSON.parse(fs.readFileSync(path.join(relayDir(), "program-last-switch.json"), "utf8")) as unknown
    return validEvent(one) ? [one] : []
  } catch { return [] }
}

/** What the deck/desk show. null while the program input isn't armed. */
export function programSourcesView(now = Date.now()): ProgramSourcesView | null {
  const settings = readSettings()
  if (!settings.programArmed) return null
  type PA = { source?: string; arrivalExcessMs?: Partial<Record<ProgramSource, number>>; offsetMs?: Partial<Record<ProgramSource, number>>; delayMs?: number }
  let pa: PA | null = null
  try { const st = readChannelStatus("capture"); pa = st.running ? ((st.health as { capture?: { programAudio?: PA } }).capture?.programAudio ?? null) : null } catch { pa = null }
  const readout = (source: ProgramSource) => {
    const r = inputReadout(source, now, settings.failover.stallSec * 1000)
    return { ...r, jitterMs: (() => { const j = pa?.arrivalExcessMs?.[source]; return typeof j === "number" && j >= 0 && j < 5000 ? j : null })(), offsetMs: pa?.offsetMs?.[source] ?? null, audioDelayMs: pa?.source === source ? (pa.delayMs ?? null) : null, rtt: rttView(source, now) }
  }
  return {
    main: readout("main"),
    backup: { ...readout("backup"), pull: settings.backupPullUrl !== "" },
    returnStatus: monitor().status,
    failover: settings.failover,
    last: monitor().last,
    history: monitor().log.slice().reverse(),
  }
}
/** Health + HEALTHY/SUSPECT/FAILED + READY checklist for one input. */
export function inputReadout(source: ProgramSource, now: number, stallMs: number): InputReadout {
  const h: SourceHealth = programSourceHealth(source, now)
  const stats = h.ready ? inputStats(source, now) : null
  const st = inputState(h, stats, monitor().baseline[source], stallMs)
  const rd = readiness(h, stats)
  return { ...h, state: st.state, stateReason: st.reason, stats: stats ?? undefined, readyOk: rd.ok, issues: rd.issues, kbpsBaseline: monitor().baseline[source] }
}
export function failoverLog(): FailoverEvent[] {
  return monitor().log.slice()
}
/** Manual switches are logged too, so every device sees who changed what. */
export function noteSourceSwitch(event: FailoverEvent) {
  const m = monitor()
  const rearm = /re-arm/.test(event.reason)
  dlog(event.auto && event.from !== event.to ? "!" : "·", rearm ? "rearm" : "switch", event.from === event.to ? `${SOURCE_LABEL[event.to]}: ${event.reason}` : `${event.auto ? "auto-failover" : "switch"} ${SOURCE_LABEL[event.from]} → ${SOURCE_LABEL[event.to]}: ${event.reason}`, event.at)
  m.last = event
  m.log = [...m.log, event].slice(-HISTORY_MAX)
  try { fs.writeFileSync(historyFile(), JSON.stringify(m.log)) } catch { /* best effort */ }
  eventBus().emit("program-sources")
}
export function onProgramSources(listener: () => void): () => void {
  const bus = eventBus()
  bus.on("program-sources", listener)
  return () => bus.off("program-sources", listener)
}

export async function programMonitorTick(now = Date.now()) {
  const m = monitor()
  await refreshProgramSources()
  await verifyMediamtxConfig(now)
  // Bonjour follows LAN ingest + arm + the current LAN IP (re-announced when the IP changes).
  void syncMdns(wantedMdns(), readSettings().mdnsName).catch(() => undefined)
  const settings = readSettings()
  for (const source of ["main", "backup"] as const) {
    const h = programSourceHealth(source, now)
    syncInputProbe(source, settings.programArmed && h.ready ? relayReadUrl(source === "main" ? PROGRAM_PATH : BACKUP_PATH) : null, now)
    const st = inputState(h, h.ready ? inputStats(source, now) : null, m.baseline[source], settings.failover.stallSec * 1000)
    m.baseline[source] = h.ready ? nextBaseline(m.baseline[source], h.kbps, st.state) : null
  }
  if (settings.programArmed) {
    for (const source of ["main", "backup"] as const) {
      const r = inputReadout(source, now, settings.failover.stallSec * 1000)
      const label = SOURCE_LABEL[source]
      const a = onChange(`${source}:state`, r.state, `${label} ${r.state.toUpperCase()}${r.stateReason ? ` (${r.stateReason})` : ""}`)
      if (a) { plog(a); dlog(!stateSeen.has(source) ? "·" : r.state === "healthy" ? "+" : "!", "ingest", a) }
      stateSeen.add(source)
      const rk = r.ready ? (r.readyOk ? "ready" : `not:${r.issues.join(",")}`) : "off"
      const b = onChange(`${source}:ready`, rk, r.readyOk ? `${label} READY` : r.ready ? `${label} not READY: ${r.issues.join(", ")}` : `${label} not READY: no signal`)
      if (b) plog(b)
    }
    if (PROGRAM_LOG_VERBOSE() && now - verboseAt >= 10000) {
      verboseAt = now
      for (const source of ["main", "backup"] as const) {
        const r = inputReadout(source, now, settings.failover.stallSec * 1000)
        const st = r.stats
        plog(`${SOURCE_LABEL[source]} stats: ${r.state.toUpperCase()} ${r.readyOk ? "READY" : "not-ready"} · fps ${st?.fps ?? "–"}/${st?.fpsNominal ?? "–"} · audio ${st?.audio ? `${st.audio.hz / 1000}k ${st.audio.channels}` : "–"} · ${r.kbps ?? "–"} kb/s · age ${r.dataAgeMs ?? "–"}ms`)
      }
    }
    const state = readServerState()
    const active = state.stage.programSource
    autoRearmTick(m, active, now, settings.failover.stallSec * 1000, settings.failover.autoRearm)
    const step = failoverStep({ active, main: programSourceHealth("main", now), backup: programSourceHealth("backup", now), settings: settings.failover, memory: m.memory, now, mainReady: inputReadout("main", now, settings.failover.stallSec * 1000).readyOk })
    m.memory = step.memory
    m.status = step.status ?? null
    const fc = onChange("flaps", String(step.memory.mainFails?.length ?? 0), `Main failures in the last ${Math.round(settings.failover.flapWindowSec / 60)} min: ${step.memory.mainFails?.length ?? 0} (flapping above ${settings.failover.flapCount})`)
    if (fc) { plog(fc); dlog("·", "switch", fc) }
    const hold = onChange("hold", step.status?.holdText ? "on" : "off", step.status?.holdText ? `hold start: Main flapping, holding Backup until Main is stable ${settings.failover.flapStableSec}s` : "hold end")
    if (hold) { plog(hold); dlog("·", "switch", hold) }
    const ask = onChange("ask", step.status?.askReturn ? "on" : "off", step.status?.askReturn ? "Ask me: Main ready · waiting for the operator to return" : "Ask me: return prompt cleared")
    if (ask) plog(ask)
    if (step.note) {
      plog(step.note)
      noteSourceSwitch({ at: now, from: active, to: active, reason: step.note, auto: true })
    }
    if (step.switchTo && step.reason) {
      // Re-check the on-air input right before acting: the step may be based on a stale read, and a
      // second "Backup → Main" while already on Main must never be logged or applied.
      const fresh = readServerState().stage.programSource
      const recent = m.last && m.last.auto && m.last.to === step.switchTo && m.last.from === active && now - m.last.at < 5000
      if (fresh !== active || fresh === step.switchTo || recent) {
        if (fresh !== active) plog(`auto-failover skipped: decided on ${SOURCE_LABEL[active]} but ${SOURCE_LABEL[fresh]} is on air (${step.reason})`)
        if (fresh === step.switchTo) m.memory = { ...m.memory, failedOver: false }
      } else {
        const result = runServerTransport({ type: "programSource", source: step.switchTo }, undefined, now, { auto: true })
        if (result.ok && readServerState().stage.programSource === step.switchTo) {
          plog(`auto-failover ${SOURCE_LABEL[active]} → ${SOURCE_LABEL[step.switchTo]}: ${step.reason}`)
          noteSourceSwitch({ at: now, from: active, to: step.switchTo, reason: step.reason, auto: true })
        }
      }
    }
  } else if (!m.rearming) { m.memory = FRESH_MEMORY; m.status = null; m.rearm = undefined; m.downAt = undefined }
  // Push when something a person would see changed (ages in whole seconds, bitrate in 100k steps).
  const view = programSourcesView(now)
  const sig = JSON.stringify(view && [view.main.ready, view.backup.ready, Math.round((view.main.kbps ?? -1) / 100), Math.round((view.backup.kbps ?? -1) / 100), Math.floor((view.main.dataAgeMs ?? -1000) / 1000), Math.floor((view.backup.dataAgeMs ?? -1000) / 1000), view.last?.at, view.failover, view.main.state, view.backup.state, view.main.readyOk, view.backup.readyOk, view.returnStatus, view.main.stats?.fps, view.backup.stats?.fps])
  if (sig !== m.sig) {
    m.sig = sig
    eventBus().emit("program-sources")
  }
}

/**
 * After a Wi-Fi drop the on-air input comes back with A/V out of sync; disarm + re-arm (the operator's
 * manual fix, same code path as the desk buttons) resyncs it. Once READY has been stable 3s, at most once per 20s.
 */
function autoRearmTick(m: Monitor, active: ProgramSource, now: number, stallMs: number, enabled: boolean) {
  if (m.rearming) return
  const mem = m.rearm ?? { main: FRESH_REARM, backup: FRESH_REARM }
  const downAt = m.downAt ?? { main: null, backup: null }
  const reads = { main: inputReadout("main", now, stallMs), backup: inputReadout("backup", now, stallMs) }
  const isDown = (r: InputReadout) => !r.ready || r.state === "failed"
  for (const s of ["main", "backup"] as const) downAt[s] = isDown(reads[s]) ? (downAt[s] ?? now) : null
  let fire = false
  for (const s of ["main", "backup"] as const) {
    const r = reads[s]
    const step = rearmStep(mem[s], { down: isDown(r), ready: r.ready && r.readyOk && r.state !== "failed", onAir: s === active, otherDownAt: downAt[s === "main" ? "backup" : "main"], quietUntil: relayQuietUntil(), now, enabled })
    mem[s] = step.mem
    if (step.fire && s === active) fire = true
  }
  m.rearm = mem
  m.downAt = downAt
  if (!fire) return
  const label = SOURCE_LABEL[active]
  plog(`${label} reconnected → auto re-arm`)
  dlog("!", "rearm", `${label} reconnected → auto re-arm: disarming /program + /program-backup for ~1.5s (publishers kicked; OBS reconnects; /stream and the previews hold the last frame, "Waiting for OBS" only if OBS is still away after ~15s)`)
  m.rearming = true
  void (async () => {
    try {
      await disarmProgram()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const armed = await armProgram()
      if (!armed.ok) { plog(`auto re-arm: arm failed: ${armed.error ?? "unknown"}`); dlog("!", "rearm", `auto re-arm: arm failed: ${armed.error ?? "unknown"}`) }
      noteSourceSwitch({ at: Date.now(), from: active, to: active, reason: `${label} reconnected → auto re-arm (A/V resync)`, auto: true })
    } finally { m.rearming = false }
  })()
}

export function startProgramMonitor(intervalMs = 500) {
  noteRelayDisruption() // server start: publishers are still (re)connecting
  startRttMonitor()
  const m = monitor()
  if (m.timer) return
  let busy = false
  m.timer = setInterval(() => {
    if (busy) return
    busy = true
    void programMonitorTick().catch(() => undefined).finally(() => (busy = false))
  }, intervalMs)
  m.timer.unref()
}
