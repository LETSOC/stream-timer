/**
 * What the OBS program layer shows. Pure, so /stream, the desk and the deck agree (and it is unit-tested).
 * - "video": frames are advancing (or stalled for less than STALL_HOLD_MS: hold the last frame).
 * - "standby": "Waiting for OBS". Only after a grace: not ready for > NOT_READY_MS, no first frame
 *   within FIRST_FRAME_GRACE_MS of switching, or a stall longer than STALL_HOLD_MS.
 * - "under": not covering anything yet, so the previous screen (countdown/card) stays visible.
 */
export const NOT_READY_MS = 3000
export const FIRST_FRAME_GRACE_MS = 5000
export const STALL_HOLD_MS = 4000
/** While MediaMTX still reports the input publishing, a player stall (LL-HLS hiccup) keeps the last frame this long before "Waiting for OBS". */
export const READY_STALL_TIMEOUT_MS = 20000

export type ProgramDisplay = "video" | "standby" | "under"

export type ProgramDisplayInput = {
  now: number
  /** When the program screen was selected (null = not on program). */
  activeSince: number | null
  /** programReady last seen true at (null = never). */
  readyAt: number | null
  /** programReady is currently true. */
  ready: boolean
  /** programReady went false at (null = it is true / unknown). */
  notReadySince: number | null
  /** Last time the picture advanced (null = no frame since the player (re)loaded). */
  lastFrameAt: number | null
}

export function programDisplay(input: ProgramDisplayInput): ProgramDisplay {
  const { now, activeSince, ready, notReadySince, lastFrameAt } = input
  if (activeSince === null) return "under"
  const gone = !ready && (notReadySince === null || now - notReadySince > NOT_READY_MS)
  if (lastFrameAt !== null) {
    const stalled = now - lastFrameAt
    if (stalled <= STALL_HOLD_MS) return "video"
    // Publisher still there: an LL-HLS stall, not OBS gone. Keep the last frame (the watchdog reloads).
    if (!gone && stalled <= READY_STALL_TIMEOUT_MS) return "video"
    return "standby"
  }
  if (gone && now - activeSince > Math.min(NOT_READY_MS, FIRST_FRAME_GRACE_MS)) return "standby"
  if (now - activeSince > FIRST_FRAME_GRACE_MS) return "standby"
  return "under"
}

/** Keep the HLS player loaded while OBS is (or was within NOT_READY_MS) sending: debounces readiness flicker. */
export function keepLoaded(ready: boolean, notReadySince: number | null, now: number): boolean {
  return ready || (notReadySince !== null && now - notReadySince <= NOT_READY_MS)
}

/** Default Main/Backup switch buffer: the incoming input must have played this long before it goes on air. */
export const SWITCH_BUFFER_MS = 1000
/**
 * Pure: may a Main/Backup hand-over complete now? The input on air stays on (never "Waiting for OBS"
 * mid-switch) until the incoming one has played `bufferMs` continuously; if the one on air is already
 * gone, take the incoming one as soon as it has a frame (or after 4s, then its own standby rules).
 * 30s cap so a never-arriving input can't pin the old one forever.
 */
export function handoverDone(input: { screenIsProgram: boolean; pendingSince: number; now: number; incomingVideoSince: number | null; airDisplay: ProgramDisplay; bufferMs: number }): boolean {
  const { screenIsProgram, pendingSince, now, incomingVideoSince, airDisplay, bufferMs } = input
  if (!screenIsProgram) return true
  if (incomingVideoSince !== null && now - incomingVideoSince >= bufferMs) return true
  const airGone = airDisplay !== "video"
  if (airGone && (incomingVideoSince !== null || now - pendingSince > 4000)) return true
  return now - pendingSince > 30_000
}
