/**
 * Desk fetches with a deadline. A phone that slept, switched network or ran out of connections
 * can leave a fetch pending for minutes; anything waiting on it (the save chain, a busy button)
 * then hangs until a page refresh. With a deadline the fetch rejects and the desk recovers.
 */
export const DESK_FETCH_MS = 8000

/** An AbortSignal that fires after `ms`, or when `signal` (if given) fires. */
export function deadlineSignal(ms: number, signal?: AbortSignal | null): AbortSignal {
  const timeout =
    typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(ms)
      : (() => {
          const controller = new AbortController()
          setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms)
          return controller.signal
        })()
  if (!signal) return timeout
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout])
  // Old browsers: forward the caller's abort by hand.
  const controller = new AbortController()
  const abort = (reason: unknown) => controller.abort(reason)
  if (signal.aborted) abort(signal.reason)
  else signal.addEventListener("abort", () => abort(signal.reason), { once: true })
  timeout.addEventListener("abort", () => abort(timeout.reason), { once: true })
  return controller.signal
}

/** fetch() that rejects after `ms` (default 8s) instead of waiting forever. */
export function fetchT(input: RequestInfo | URL, init: RequestInit = {}, ms = DESK_FETCH_MS): Promise<Response> {
  return fetch(input, { ...init, signal: deadlineSignal(ms, init.signal) })
}

/** Keep the old value when the new one has the same content, so a poll doesn't re-render for nothing. */
export function keepIfSame<T>(previous: T, next: T): T {
  if (previous === next) return previous
  try {
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
  } catch {
    return next
  }
}
