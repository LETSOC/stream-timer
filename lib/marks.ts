/**
 * Operator markers (desk / deck / phone "⚑ Mark" menu) → one "[operator]" line in the dropout log.
 * Problem marks ("!"): what the operator saw on YouTube (blackout, frozen, audio). Intentional marks
 * ("·"): stops / restarts / tests done on purpose, so the relay GONE/READY lines they cause are
 * labelled "expected" in `npm run dropouts` and the desk's Dropout log instead of counted as problems.
 * Client-safe (no fs): the menu and the API route share these.
 */
export type MarkSource = "main" | "backup"
export type MarkKind = "problem" | "stop" | "back" | "test-start" | "test-end" | "note"
export type MarkDef = { label: string; log: string; kind: MarkKind; source?: MarkSource }
export const MARK_TYPES = {
  blackout: { label: "Blackout", log: "blackout", kind: "problem" },
  frozen: { label: "Frozen/stutter", log: "frozen/stutter", kind: "problem" },
  audio: { label: "Audio problem", log: "audio problem (drop/out of sync)", kind: "problem" },
  "main-stopped": { label: "Main stopped", log: "Main stopped on purpose", kind: "stop", source: "main" },
  "backup-stopped": { label: "Backup stopped", log: "Backup stopped on purpose", kind: "stop", source: "backup" },
  "main-back": { label: "Main back on", log: "Main back on", kind: "back", source: "main" },
  "backup-back": { label: "Backup back on", log: "Backup back on", kind: "back", source: "backup" },
  "test-start": { label: "Test start", log: "test start", kind: "test-start" },
  "test-end": { label: "Test end", log: "test end", kind: "test-end" },
  note: { label: "Note", log: "note", kind: "note" },
} as const satisfies Record<string, MarkDef>
export type MarkType = keyof typeof MARK_TYPES
export const MARK_PAGES = ["desk", "deck", "phone"] as const
export type MarkPage = (typeof MARK_PAGES)[number]
export const NOTE_MAX = 120

export const isMarkType = (v: unknown): v is MarkType => typeof v === "string" && Object.hasOwn(MARK_TYPES, v)
export const isProblemType = (t: MarkType) => MARK_TYPES[t].kind === "problem"

/** Short free note: one line, no control chars, ≤ NOTE_MAX. */
export function cleanNote(note: unknown): string {
  if (typeof note !== "string") return ""
  return note.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX)
}

/** "frozen/stutter marked on phone (on air: Backup, screen: program) · note: lower third flicker" */
export function markMessage(type: MarkType, page: MarkPage, onAir: string, screen: string, note = ""): string {
  return `${MARK_TYPES[type].log} marked on ${page} (on air: ${onAir}, screen: ${screen})${note ? ` · note: ${note}` : ""}`
}

const MSG = /^(.+?) marked on (desk|deck|phone) \(on air: ([^,]*), screen: (.*?)\)(?: · note: (.*))?$/
const BY_LOG = new Map<string, MarkType>((Object.keys(MARK_TYPES) as MarkType[]).map((k) => [MARK_TYPES[k].log as string, k]))
export type ParsedMark = { type: MarkType; def: MarkDef; page: MarkPage; onAir: string; screen: string; note: string }
/** The operator line's message back to its parts (null = not a marker line). */
export function parseMarkMessage(msg: string): ParsedMark | null {
  const m = MSG.exec(msg)
  if (!m) return null
  const type = BY_LOG.get(m[1])
  if (!type) return null
  return { type, def: MARK_TYPES[type], page: m[2] as MarkPage, onAir: m[3], screen: m[4], note: m[5] ?? "" }
}
