// Capture browser lifecycle for 24/7 running (pure, unit-tested in lib/chrome-life.test.ts).
//
// Why: after ~6h the /stream page hung for ~10s more and more often (07:29–08:20), and a failed
// reload made the capture give up. Now a hung/failed page relaunches the whole Chrome (fresh process
// and profile) with backoff, never giving up, and Chrome is also refreshed on a schedule while only the
// countdown/cards are up. The last good frame is held to ffmpeg throughout (same timeline, no gap).
//
// Long program runs (overnight Backup test, 27 Oct): the page heap grew to ~100MB and from ~07:30 the
// page stalled 4–6s, by 09:45 about once a minute, freezing YouTube. The planned refresh never ran
// because the program was on air the whole time. CAPTURE_CHROME_REFRESH_ON_PROGRAM=1 lets the planned
// refresh also run on the program: same relaunch (pushes keep running, audio continues, the last good
// frame is held until the new page shows the program), only 30s+ after a Main/Backup switch.

/** Wait before relaunch attempt n (0-based): 0, 2, 4, 8, 16, 30, 30 … seconds. */
export function relaunchBackoffMs(n) {
  return n <= 0 ? 0 : Math.min(30_000, 1000 * 2 ** n)
}

/** Hold this long after a Main/Backup switch or a screen change before a planned refresh. */
export const QUIET_AFTER_SWITCH_MS = 30_000

/** Env opt-in: planned refresh may also run while the program is on air (default off). */
export function refreshOnProgramFromEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim())
}
export const REFRESH_ON_PROGRAM = refreshOnProgramFromEnv(process.env.CAPTURE_CHROME_REFRESH_ON_PROGRAM)

/**
 * Planned refresh due? Only when it is enabled, Chrome is older than `hours`, nothing switched for 30s
 * and no recovery is running. /stream must be on the countdown/cards/end/standby, or on the program
 * when `onProgram` (CAPTURE_CHROME_REFRESH_ON_PROGRAM=1). Never while the screen is unknown.
 */
export function plannedRefreshDue({ now, launchedAt, hours, screen, lastSwitchAt, busy, onProgram = REFRESH_ON_PROGRAM }) {
  if (!(hours > 0) || busy) return false
  if (now - launchedAt < hours * 3_600_000) return false
  if (screen === "") return false
  if (screen === "program" && !onProgram) return false
  return now - lastSwitchAt >= QUIET_AFTER_SWITCH_MS
}
