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
import { programSourceHealth, readSettings, relayDir, wantedMdns, refreshProgramSources, verifyMediamtxConfig } from "@/lib/relay"
import type { ProgramSourcesView } from "@/lib/transport"
import { runServerTransport } from "@/lib/transport-server"

const KEY = Symbol.for("stream-timer.program-monitor")
type Monitor = { timer: NodeJS.Timeout | null; memory: FailoverMemory; last: FailoverEvent | null; log: FailoverEvent[]; sig: string }
function monitor(): Monitor {
  const holder = globalThis as { [KEY]?: Monitor }
  if (!holder[KEY]) {
    // The last switch survives a server restart: devices still see it, and an auto-failover to Backup
    // still auto-returns afterwards.
    const last = loadLast()
    holder[KEY] = { timer: null, memory: { ...FRESH_MEMORY, failedOver: Boolean(last?.auto && last.to === "backup") }, last, log: last ? [last] : [], sig: "" }
  }
  return holder[KEY]
}
const lastFile = () => path.join(relayDir(), "program-last-switch.json")
function loadLast(): FailoverEvent | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lastFile(), "utf8")) as FailoverEvent
    return raw && typeof raw.at === "number" && (raw.to === "main" || raw.to === "backup") ? raw : null
  } catch { return null }
}

/** What the deck/desk show. null while the program input isn't armed. */
export function programSourcesView(now = Date.now()): ProgramSourcesView | null {
  const settings = readSettings()
  if (!settings.programArmed) return null
  return {
    main: programSourceHealth("main", now),
    backup: { ...programSourceHealth("backup", now), pull: settings.backupPullUrl !== "" },
    failover: settings.failover,
    last: monitor().last,
  }
}
export function failoverLog(): FailoverEvent[] {
  return monitor().log.slice()
}
/** Manual switches are logged too, so every device sees who changed what. */
export function noteSourceSwitch(event: FailoverEvent) {
  const m = monitor()
  m.last = event
  m.log = [...m.log, event].slice(-50)
  try { fs.writeFileSync(lastFile(), JSON.stringify(event)) } catch { /* best effort */ }
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
  if (settings.programArmed) {
    const state = readServerState()
    const active = state.stage.programSource
    const step = failoverStep({ active, main: programSourceHealth("main", now), backup: programSourceHealth("backup", now), settings: settings.failover, memory: m.memory, now })
    m.memory = step.memory
    if (step.switchTo && step.reason) {
      const result = runServerTransport({ type: "programSource", source: step.switchTo }, undefined, now, { auto: true })
      if (result.ok) {
        console.log(`[program] auto-failover ${SOURCE_LABEL[active]} → ${SOURCE_LABEL[step.switchTo]}: ${step.reason}`)
        noteSourceSwitch({ at: now, from: active, to: step.switchTo, reason: step.reason, auto: true })
      }
    }
  } else m.memory = FRESH_MEMORY
  // Push when something a person would see changed (ages in whole seconds, bitrate in 100k steps).
  const view = programSourcesView(now)
  const sig = JSON.stringify(view && [view.main.ready, view.backup.ready, Math.round((view.main.kbps ?? -1) / 100), Math.round((view.backup.kbps ?? -1) / 100), Math.floor((view.main.dataAgeMs ?? -1000) / 1000), Math.floor((view.backup.dataAgeMs ?? -1000) / 1000), view.last?.at, view.failover])
  if (sig !== m.sig) {
    m.sig = sig
    eventBus().emit("program-sources")
  }
}

export function startProgramMonitor(intervalMs = 500) {
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
