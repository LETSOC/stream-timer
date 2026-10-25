/**
 * /stream page health (Browser capture's dropout log):
 *  - the 150ms player tick notices when the page itself hung (main thread blocked), so the
 *    "picture stuck" watchdog doesn't rebuild the player for a stall the player didn't cause;
 *  - throttles for the frame/latency React state (fewer re-renders per second);
 *  - a once-a-minute "[mem]" line: JS heap, live hls.js players, <video> elements, AudioContexts, rebuilds.
 * Pure helpers are exported for tests; the counters are module-level (one page).
 */

/** On-air watchdog: rebuild the player after the picture is stuck this long (was 3s). */
export const ON_AIR_STUCK_MS = 5000
/** A gap this long between two 150ms ticks = the page itself hung, not the player. */
export const PAGE_HUNG_GAP_MS = 2000
/** Frame-time state: at most this often (freeze detection works at 700ms, so not 1/s). */
export const FRAME_STATE_MS = 250
/** Latency state: when it moves this much, or at least once a second. */
export const LATENCY_STEP_MS = 100
export const LATENCY_STATE_MS = 1000
export const MEM_LOG_MS = 60_000

/** Tick gap → page hung? */
export function pageHung(prevTickAt: number | null, now: number, gapMs = PAGE_HUNG_GAP_MS): boolean {
  return prevTickAt !== null && now - prevTickAt > gapMs
}

export function frameStateDue(lastSetAt: number | null, now: number): boolean {
  return lastSetAt === null || now - lastSetAt >= FRAME_STATE_MS
}

export function latencyStateDue(prev: { value: number | null; at: number } | null, value: number | null, now: number): boolean {
  if (prev === null) return true
  if ((prev.value === null) !== (value === null)) return true
  if (prev.value !== null && value !== null && Math.abs(value - prev.value) >= LATENCY_STEP_MS) return true
  return now - prev.at >= LATENCY_STATE_MS && prev.value !== value
}

export type MemSample = { usedBytes: number | null; totalBytes: number | null; hls: number; video: number; ctx: number; rebuilds: number }

const mb = (b: number) => Math.round(b / 1048576)
export function memLine(s: MemSample): string {
  const heap = s.usedBytes !== null && s.totalBytes !== null ? `heap ${mb(s.usedBytes)}/${mb(s.totalBytes)}MB` : "heap n/a"
  return `[mem] ${heap} · hls ${s.hls} · video ${s.video} · ctx ${s.ctx} · rebuilds ${s.rebuilds}`
}

// ---- counters (one page) ----
let liveHls = 0
let rebuilds = 0
let liveCtx = 0
export const hlsCreated = () => { liveHls += 1 }
export const hlsDestroyed = () => { liveHls = Math.max(0, liveHls - 1) }
export const playerRebuilt = () => { rebuilds += 1 }

let ctxPatched = false
/** Count live AudioContexts (created minus closed) by wrapping the constructor once. */
export function countAudioContexts() {
  if (ctxPatched || typeof window === "undefined") return
  ctxPatched = true
  const w = window as unknown as { AudioContext?: typeof AudioContext }
  const Orig = w.AudioContext
  if (!Orig) return
  class Counted extends Orig {
    constructor(opts?: AudioContextOptions) {
      super(opts)
      liveCtx += 1
      let counted = true
      this.addEventListener("statechange", () => { if (counted && this.state === "closed") { counted = false; liveCtx = Math.max(0, liveCtx - 1) } })
    }
  }
  w.AudioContext = Counted
}

export function sampleMem(): MemSample {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory
  return { usedBytes: m?.usedJSHeapSize ?? null, totalBytes: m?.totalJSHeapSize ?? null, hls: liveHls, video: document.querySelectorAll("video").length, ctx: liveCtx, rebuilds }
}

let memTimer: number | null = null
/** Start the once-a-minute [mem] line (idempotent). `report` posts to the dropout log. */
export function startMemLog(report: (line: string) => void) {
  if (memTimer !== null || typeof window === "undefined") return
  memTimer = window.setInterval(() => report(memLine(sampleMem())), MEM_LOG_MS)
}
