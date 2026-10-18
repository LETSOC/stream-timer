/**
 * Pure: decide when to auto re-arm the program input after the on-air source dropped and came back.
 * Disarm + re-arm is what the operator does by hand after a Wi-Fi drop to get A/V back in sync.
 */
export const REARM_SETTLE_MS = 3000
export const REARM_MIN_GAP_MS = 20_000
/** Our own disarm kicks OBS, so ignore the drop that follows a re-arm until it is back (or this long). */
export const REARM_SELF_MS = 60_000

export type RearmMemory = { dropped: boolean; readySince: number | null; lastAt: number; selfUntil: number }
export const FRESH_REARM: RearmMemory = { dropped: false, readySince: null, lastAt: -Infinity, selfUntil: 0 }

/** `down`: not publishing / no data / FAILED. `ready`: publishing and READY (checklist ok). */
export function rearmStep(mem: RearmMemory, input: { down: boolean; ready: boolean; now: number; enabled: boolean }): { mem: RearmMemory; fire: boolean } {
  const { down, ready, now } = input
  if (!input.enabled) return { mem: { ...mem, dropped: false, readySince: null }, fire: false }
  if (down) {
    // A drop caused by our own re-arm doesn't count.
    return { mem: { ...mem, dropped: mem.dropped || now >= mem.selfUntil, readySince: null }, fire: false }
  }
  if (!ready) return { mem: { ...mem, readySince: null }, fire: false }
  const readySince = mem.readySince ?? now
  const stable = now - readySince >= REARM_SETTLE_MS
  // Back and stable after our own re-arm: drops count again from here.
  const selfUntil = stable && now < mem.selfUntil ? 0 : mem.selfUntil
  if (mem.dropped && stable && now - mem.lastAt >= REARM_MIN_GAP_MS) {
    return { mem: { dropped: false, readySince: null, lastAt: now, selfUntil: now + REARM_SELF_MS }, fire: true }
  }
  return { mem: { ...mem, readySince, selfUntil }, fire: false }
}
