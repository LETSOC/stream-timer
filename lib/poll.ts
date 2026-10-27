/**
 * Polling without pile-ups: the next tick is scheduled only after the previous one finished, so a
 * slow server or network never stacks requests (browsers allow 6 connections per host over plain
 * HTTP; stacked polls starve the operator's taps). Paused while the page is hidden, resumed at
 * once when it is visible again, and backed off after failures (up to 8× the interval, max 15s).
 */
export type PollDoc = {
  visibilityState: DocumentVisibilityState
  addEventListener: (type: "visibilitychange", listener: () => void) => void
  removeEventListener: (type: "visibilitychange", listener: () => void) => void
}

export type PollOptions = {
  /** Upper bound for the back-off delay (ms). */
  maxDelayMs?: number
  doc?: PollDoc | null
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

/** Delay before the next tick after `failures` failed ticks in a row. */
export function pollDelay(ms: number, failures: number, maxDelayMs = 15_000): number {
  if (failures <= 0) return ms
  return Math.max(ms, Math.min(maxDelayMs, ms * 2 ** Math.min(3, failures)))
}

/**
 * Run `tick` now and then every `ms` after it settles. A tick that throws or returns false counts
 * as a failure. Returns a stop function.
 */
export function startPoll(tick: () => Promise<unknown> | unknown, ms: number, options: PollOptions = {}): () => void {
  const doc = options.doc === undefined ? (typeof document === "undefined" ? null : document) : options.doc
  const setTimer = options.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay))
  const clearTimer = options.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>))
  let stopped = false
  let running = false
  let failures = 0
  let timer: unknown = null
  const schedule = (delay: number) => {
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void run()
    }, delay)
  }
  const run = async () => {
    if (stopped || running) return
    // Hidden page: stop here; the visibility listener starts it again.
    if (doc && doc.visibilityState === "hidden") return
    running = true
    let ok = true
    try {
      ok = (await tick()) !== false
    } catch {
      ok = false
    }
    running = false
    if (stopped) return
    failures = ok ? 0 : failures + 1
    schedule(pollDelay(ms, failures, options.maxDelayMs))
  }
  const onVisible = () => {
    if (stopped || !doc || doc.visibilityState !== "visible" || running) return
    if (timer !== null) clearTimer(timer)
    timer = null
    failures = 0
    void run()
  }
  doc?.addEventListener("visibilitychange", onVisible)
  void run()
  return () => {
    stopped = true
    if (timer !== null) clearTimer(timer)
    timer = null
    doc?.removeEventListener("visibilitychange", onVisible)
  }
}
