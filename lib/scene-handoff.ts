/**
 * Scene-to-scene handoff on /stream (e.g. a Standby ⇄ Showreel loop). The outgoing scene stays
 * mounted on top, holding its last frame, until the incoming scene's video has painted its first
 * frame (or a safety timeout), so the switch never shows black or the card without its video.
 */
export type HandoffState = { current: string; leaving: string | null }

/** Longest the outgoing scene is held if the incoming video never reports a frame. */
export const HANDOFF_MAX_MS = 3000

export function handoffStart(id: string): HandoffState {
  return { current: id, leaving: null }
}

/** A new scene was picked: the one on screen becomes the cover until the new one is ready. */
export function handoffShow(s: HandoffState, next: string): HandoffState {
  if (next === s.current) return s
  // Switching again mid-handoff: keep the picture that is actually visible (the cover) on top.
  return { current: next, leaving: s.leaving ?? s.current }
}

/** A scene reports its first frame (or has no video). Only the current scene releases the cover. */
export function handoffReady(s: HandoffState, id: string): HandoffState {
  if (id !== s.current || s.leaving === null) return s
  return { current: s.current, leaving: null }
}
