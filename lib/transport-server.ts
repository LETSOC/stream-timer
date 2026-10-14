import { readServerState, RevConflict, writeServerEvent } from "@/lib/event-server"
import { programReadyCached } from "@/lib/relay"
import { noteSourceSwitch, programSourcesView } from "@/lib/program-monitor"
import { applyTransport, deckState, type DeckState, type TransportAction } from "@/lib/transport"

export type ServerTransportResult =
  | { ok: true; state: DeckState }
  | { ok: false; status: 400 | 409 | 423; error: string; state: DeckState }

/** programReady = the ACTIVE input is publishing (what /stream will show). */
function ready(state: ReturnType<typeof readServerState>) {
  return programReadyCached(state.stage.programSource)
}
export function currentDeckState(now = Date.now()): DeckState {
  const state = readServerState()
  return deckState(state, now, ready(state), programSourcesView(now))
}

/**
 * Run one transport action through the same write path as PUT /api/event (validation, backup,
 * atomic rename, rev). `expectedRev` = the rev the client last saw: a stale deck gets a 409 plus
 * the fresh state instead of acting on a screen it hasn't seen yet.
 */
export function runServerTransport(action: TransportAction, expectedRev: number | undefined, now = Date.now(), opts: { auto?: boolean } = {}): ServerTransportResult {
  const current = readServerState()
  if (expectedRev !== undefined && expectedRev !== current.rev) {
    return { ok: false, status: 409, error: "Changed on another device. Check the state and tap again.", state: deckState(current, now, ready(current), programSourcesView(now)) }
  }
  const result = applyTransport(current, action, now)
  if (!result.ok) return { ok: false, status: current.stage.deskLive ? 423 : 400, error: result.error, state: deckState(current, now, ready(current), programSourcesView(now)) }
  try {
    const saved = writeServerEvent(result.next.event, result.next.testUntil, result.next.pausedAt, result.next.stage, expectedRev, now)
    if (!saved) return { ok: false, status: 400, error: "Event payload was not valid.", state: deckState(current, now, ready(current), programSourcesView(now)) }
  } catch (error) {
    if (error instanceof RevConflict) return { ok: false, status: 409, error: "Changed on another device. Check the state and tap again.", state: currentDeckState(now) }
    throw error
  }
  if (action.type === "programSource" && !opts.auto && current.stage.programSource !== action.source) {
    noteSourceSwitch({ at: now, from: current.stage.programSource, to: action.source, reason: "Switched by operator", auto: false })
  }
  return { ok: true, state: currentDeckState(now) }
}
