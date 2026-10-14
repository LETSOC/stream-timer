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
    if (now - lastFrameAt <= STALL_HOLD_MS) return "video"
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
