/**
 * Per-feed arm/disarm (Main /program, Backup /program-backup). Pure, unit-tested.
 * `programArmed` stays the master switch (true while ANY feed is armed: the relay keeps running and
 * the failover monitor runs); `disarmed` says which feed's OBS login is off while armed.
 */
export type Feed = "main" | "backup"
export type ArmScope = Feed | "both"
export type FeedDisarmed = Record<Feed, boolean>
export type ArmState = { programArmed: boolean; disarmed: FeedDisarmed }
export const FEED_LABEL: Record<Feed, string> = { main: "Main", backup: "Backup" }
export const other = (f: Feed): Feed => (f === "main" ? "backup" : "main")
export const NONE_DISARMED: FeedDisarmed = { main: false, backup: false }

export function parseDisarmed(raw: unknown): FeedDisarmed {
  const r = (raw ?? {}) as Partial<FeedDisarmed>
  return { main: r.main === true, backup: r.backup === true }
}

/** Is this feed's OBS login on? */
export const feedArmed = (s: ArmState, f: Feed) => s.programArmed && !s.disarmed[f]

/**
 * Pure, for the desk + deck: is this feed disarmed as the switch sees it? `armed` is the view's
 * per-feed flags; a null view means the relay isn't armed at all (both feeds disarmed).
 */
export function feedDisarmedInView(view: { armed?: Partial<Record<Feed, boolean>> } | null | undefined, f: Feed): boolean {
  return !view || view.armed?.[f] === false
}

/** Pure: the arm state after an arm/disarm of `scope`. Both feeds off = fully disarmed (programArmed false, as before). */
export function nextArmState(cur: ArmState, op: "arm" | "disarm", scope: ArmScope): ArmState {
  const on: FeedDisarmed = { main: feedArmed(cur, "main"), backup: feedArmed(cur, "backup") }
  const want: Record<Feed, boolean> = scope === "both" ? { main: op === "arm", backup: op === "arm" } : { ...on, [scope]: op === "arm" }
  if (!want.main && !want.backup) return { programArmed: false, disarmed: { ...NONE_DISARMED } }
  return { programArmed: true, disarmed: { main: !want.main, backup: !want.backup } }
}

/**
 * Pure: what a disarm of `scope` does to the output.
 * - standby feed: nothing on air changes;
 * - on-air feed, other healthy: hand over to the other first (normal switch, last frame held), then disarm;
 * - on-air feed, other not healthy (or both): output holds the last frame, then the standby card.
 */
export function disarmPlan(scope: ArmScope, active: Feed, otherHealthy: boolean): { handoverTo: Feed | null; affectsAir: boolean; warning: string | null } {
  if (scope === "both") return { handoverTo: null, affectsAir: true, warning: "Main and Backup both drop — output will hold/standby card" }
  if (scope !== active) return { handoverTo: null, affectsAir: false, warning: null }
  if (otherHealthy) return { handoverTo: other(scope), affectsAir: false, warning: null }
  return { handoverTo: null, affectsAir: true, warning: `${FEED_LABEL[other(scope)]} not healthy — output will hold/standby card` }
}
