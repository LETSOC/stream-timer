// Capture browser lifecycle for 24/7 running (pure, unit-tested in lib/chrome-life.test.ts).
//
// Why: after ~6h the /stream page hung for ~10s more and more often (07:29–08:20), and a failed
// reload made the capture give up. Now a hung/failed page relaunches the whole Chrome (fresh process
// and profile) with backoff, never giving up, and Chrome is also refreshed on a schedule while only the
// countdown/cards are up. The last good frame is held to ffmpeg throughout (same timeline, no gap).

/** Wait before relaunch attempt n (0-based): 0, 2, 4, 8, 16, 30, 30 … seconds. */
export function relaunchBackoffMs(n) {
  return n <= 0 ? 0 : Math.min(30_000, 1000 * 2 ** n)
}

/** Hold this long after a Main/Backup switch or a screen change before a planned refresh. */
export const QUIET_AFTER_SWITCH_MS = 30_000

/**
 * Planned refresh due? Only when it is enabled, Chrome is older than `hours`, /stream is NOT on the
 * program (countdown/cards/end/standby), nothing switched for 30s and no recovery is running.
 */
export function plannedRefreshDue({ now, launchedAt, hours, screen, lastSwitchAt, busy }) {
  if (!(hours > 0) || busy) return false
  if (now - launchedAt < hours * 3_600_000) return false
  if (screen === "" || screen === "program") return false
  return now - lastSwitchAt >= QUIET_AFTER_SWITCH_MS
}
