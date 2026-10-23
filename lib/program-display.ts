/**
 * What the OBS program layer shows. Pure, so /stream, the desk and the deck agree (and it is unit-tested).
 * - "video": frames are advancing (or stalled for less than STALL_HOLD_MS: hold the last frame).
 * - "standby": "Waiting for OBS". Only after a grace: not ready for > NOT_READY_MS, no first frame
 *   within FIRST_FRAME_GRACE_MS of switching, or a stall longer than STALL_HOLD_MS. While the relay
 *   reports the publisher (ready), only after READY_STALL_TIMEOUT_MS without a frame.
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
  /** A last good frame is available to hold on top (the player's cover canvas). */
  held?: boolean
  /** A disarm/arm cycle is in progress (auto re-arm or the desk buttons, ≤ REARM_HOLD_MS): OBS was kicked on purpose. */
  rearmHold?: boolean
}

export function programDisplay(input: ProgramDisplayInput): ProgramDisplay {
  const { now, activeSince, ready, notReadySince, lastFrameAt } = input
  if (activeSince === null) return "under"
  // Re-arm in progress: OBS was kicked on purpose and is reconnecting. Freeze on the last frame (the
  // element's, or the cover canvas after a teardown) instead of "Waiting for OBS"; afterwards, the rules below.
  if (input.rearmHold && (lastFrameAt !== null || input.held)) return "video"
  const gone = !ready && (notReadySince === null || now - notReadySince > NOT_READY_MS)
  if (lastFrameAt !== null) {
    const stalled = now - lastFrameAt
    if (stalled <= STALL_HOLD_MS) return "video"
    // Publisher still there: an LL-HLS stall, not OBS gone. Keep the last frame (the watchdog reloads).
    if (!gone && stalled <= READY_STALL_TIMEOUT_MS) return "video"
    return "standby"
  }
  if (gone && now - activeSince > Math.min(NOT_READY_MS, FIRST_FRAME_GRACE_MS)) return "standby"
  // No frame yet but the relay reports the publisher (OBS just reconnected after a disarm/arm or a drop;
  // the rebuilt player needs a few seconds for its first frame): never "Waiting for OBS". Hold the last
  // frame if there is one, else keep the previous screen; standby only if it never plays.
  if (ready) {
    const waiting = now - Math.max(activeSince, input.readyAt ?? activeSince)
    if (waiting <= READY_STALL_TIMEOUT_MS) return input.held ? "video" : "under"
    return "standby"
  }
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
 * gone or not advancing (frozen, torn down, publisher gone), take the incoming one as soon as it has a frame (or after 4s, then its own standby rules).
 * 30s cap so a never-arriving input can't pin the old one forever.
 */
export function handoverDone(input: { screenIsProgram: boolean; pendingSince: number; now: number; incomingVideoSince: number | null; airDisplay: ProgramDisplay; bufferMs: number; /** the input on air is still advancing and its publisher is there (false = frozen, torn down, erroring or gone) */ airAlive?: boolean }): boolean {
  const { screenIsProgram, pendingSince, now, incomingVideoSince, airDisplay, bufferMs, airAlive = true } = input
  if (!screenIsProgram) return true
  if (incomingVideoSince !== null && now - incomingVideoSince >= bufferMs) return true
  // Old input dead/stalled (failover, publisher gone, player torn down): the overlap only protects a
  // healthy picture, so cut to the new input at its first frame instead of holding a frozen/black one.
  if (!airAlive && incomingVideoSince !== null) return true
  const airGone = airDisplay !== "video"
  if (airGone && (incomingVideoSince !== null || now - pendingSince > 4000)) return true
  return now - pendingSince > 30_000
}

/**
 * Operator previews (desk/deck players, not /stream): "Waiting for OBS" only once the path has had no
 * publisher for NOT_READY_MS — never for a player stall, a reload, a WebRTC→HLS swap or a re-arm. Short gaps
 * keep the last frame with a small "reconnecting" badge.
 */
export type PreviewDisplay = "video" | "connecting" | "reconnecting" | "standby"
export const PREVIEW_GAP_MS = 1500
export function previewDisplay(input: { now: number; ready: boolean; notReadySince: number | null; lastFrameAt: number | null; /** disarm/arm cycle in progress: "reconnecting", never the card */ rearmHold?: boolean }): PreviewDisplay {
  const { now, ready, notReadySince, lastFrameAt } = input
  const gone = !ready && notReadySince !== null && now - notReadySince > NOT_READY_MS && !input.rearmHold
  if (gone) return "standby"
  if (lastFrameAt === null) return "connecting"
  return now - lastFrameAt > PREVIEW_GAP_MS ? "reconnecting" : "video"
}

/**
 * /stream's standby input (prewarmed, not on air, not the hand-over target): paused with a warm buffer
 * in a plain tab (one decode instead of two). Browser capture keeps it playing: it takes each input's
 * audio from its own element, so a switch must find the other input's audio already flowing.
 */
export function holdStandby(i: { onAir: boolean; incoming: boolean; captureTap: boolean }): boolean {
  return !i.onAir && !i.incoming && !i.captureTap
}

/**
 * /stream on a phone/tablet inside an operator preview (?mute=1: the deck's and the builder's
 * iframes): use the gentle HLS profile (standard HLS, ~3s buffer, no catch-up). The on-air
 * low-latency profile starves a phone on Wi-Fi (constant rebuffering). OBS and browser capture
 * never pass ?mute=1 on touch hardware, so on-air behaviour is unchanged.
 */
export function previewGentle(i: { mute: boolean; touch: boolean; capturePage: boolean }): boolean {
  return i.mute && i.touch && !i.capturePage
}

/** Dropout-log tag so a phone preview's player lines are distinct from desktop / capture. */
export function phoneDiagPrefix(i: { touch: boolean; capturePage: boolean }): string {
  return i.touch && !i.capturePage ? "[phone] " : ""
}

/** Phone muted preview mounts only the on-air input (and the hand-over target). Desktop/OBS/capture prewarm both. */
export function previewMountSource(i: { gentle: boolean; live: boolean }): boolean {
  return !i.gentle || i.live
}

/**
 * Browser capture start (<html data-stream-ready>, which scripts/capture-stream.mjs waits for before its
 * first screenshot / screencast frame): when the operator has Program up, wait for the program layer to
 * cover the screen (first frame, or its own standby rules) so a (re)started capture never opens on the
 * countdown underneath. Capped well under the script's 15s wait.
 */
export const CAPTURE_FIRST_FRAME_WAIT_MS = 8000
export function captureStartReady(i: { capturePage: boolean; blocked: boolean; screen: string; shownScreen: string; waitedMs: number }): boolean {
  if (!i.capturePage || i.blocked || i.screen !== "program") return true
  return i.shownScreen === "program" || i.waitedMs >= CAPTURE_FIRST_FRAME_WAIT_MS
}
