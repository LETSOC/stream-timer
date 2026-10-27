// Keep the Mac awake while the server runs, and log when it slept anyway.
//
// Why: on 26 Oct the unattended Mac slept for ~82 min (page hung 4919s, pushes timed out) and the
// stream stayed degraded for two hours after waking. `caffeinate -dimsu -w <pid>` holds the sleep
// assertions for as long as this process lives (it exits with it), costs no CPU, and does nothing
// off macOS. Set KEEP_AWAKE=0 to disable. A closed lid still sleeps a MacBook; keep it open.
import { spawn } from "node:child_process"
import { dlog } from "@/lib/dropout-log"

export const WAKE_CHECK_MS = 5_000
export const SLEEP_GAP_MS = 20_000

/** How long the process was frozen between two timer ticks (ms), or 0 when it was not. */
export function sleepGapMs(prevTickAt: number, now: number, intervalMs = WAKE_CHECK_MS, thresholdMs = SLEEP_GAP_MS): number {
  const late = now - prevTickAt - intervalMs
  return late >= thresholdMs ? late : 0
}

export const formatSleep = (ms: number): string => {
  const s = Math.round(ms / 1000)
  return s >= 120 ? `${Math.round(s / 60)} min` : `${s}s`
}

export function startKeepAwake(): void {
  const g = globalThis as { __keepAwake?: boolean }
  if (g.__keepAwake) return
  g.__keepAwake = true
  if (process.env.KEEP_AWAKE !== "0" && process.platform === "darwin") {
    try {
      const child = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" })
      child.on("error", () => dlog("!", "server", "caffeinate unavailable: the Mac may sleep (run `caffeinate -dimsu` yourself)"))
      child.unref()
      dlog("·", "server", "keep-awake on: caffeinate holds the Mac awake while the server runs")
    } catch {
      dlog("!", "server", "caffeinate failed to start: the Mac may sleep")
    }
  }
  let prev = Date.now()
  setInterval(() => {
    const now = Date.now()
    const gap = sleepGapMs(prev, now)
    prev = now
    if (gap) dlog("!", "server", `Mac was asleep or frozen for ${formatSleep(gap)}: the stream, pushes and capture were down meanwhile; expect a few minutes of catch-up`)
  }, WAKE_CHECK_MS).unref()
}
