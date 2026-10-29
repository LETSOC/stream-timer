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

/**
 * Program → scene: the program picture (the input on air, still playing) stays on top of the incoming
 * scene until that scene's video has painted (or HANDOFF_MAX_MS), so the cut never shows black or the
 * card's bare background and text. Returns the scene being covered, or null for no cover.
 */
export function programCoverNext(input: { cover: string | null; from: string; to: string; toIsScene: boolean; programVideo: boolean }): string | null {
  if (!input.toIsScene) return null
  if (input.from === "program") return input.programVideo ? input.to : null
  // Scene → scene while the program still covers: keep covering, now for the newest scene.
  return input.cover !== null ? input.to : null
}

/** A scene reports its first frame: only the covered scene drops the program cover. */
export function programCoverReady(cover: string | null, id: string): string | null {
  return cover === id ? null : cover
}

/** Scene → program: the scene stays mounted under the program feed's fade-in this long (no black dip). */
export const PROGRAM_FADE_TAIL_MS = 400

export function sceneTailNext(input: { from: string; to: string; fromIsScene: boolean }): string | null {
  return input.to === "program" && input.fromIsScene ? input.from : null
}
