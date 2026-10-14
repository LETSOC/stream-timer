import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "@/lib/encoder"
import { emitSaved } from "@/lib/event-bus"
import { asEventConfig, DEFAULT_EVENT, type EventConfig, type SpeakerCard } from "@/lib/event"
import { DEFAULT_STAGE, parseStage, testClockStale, type StageOptions } from "@/lib/stage"

// Read at call time so tests can point STREAM_DATA_DIR at a temp folder.
function dataDir() {
  return process.env.STREAM_DATA_DIR || DATA_DIR
}
function eventFile() {
  return path.join(dataDir(), "event.json")
}

export function readServerEvent(): EventConfig {
  return readServerState().event
}

export type { SpeakerCard }

export type { StageOptions }

export type ServerState = {
  event: EventConfig
  testUntil: number | null
  pausedAt: number | null
  /** When the current test clock was set (ms). Null when no test clock is active. */
  testSetAt: number | null
  stage: StageOptions
  /** Bumped on every write; the desk sends it back so stale tabs get a 409. */
  rev: number
  /** Set when event.json could not be read: "backup" = restored from event.json.bak, "defaults" = nothing usable. */
  recovered?: "backup" | "defaults"
}

/** Test clock values must sit within this window around now (rejects garbage like 0 or year 3000). */
const CLOCK_PAST_MS = 2 * 365 * 24 * 3600_000
const CLOCK_FUTURE_MS = 400 * 24 * 3600_000

export function validClockValue(value: number, now = Date.now()): boolean {
  return Number.isFinite(value) && value >= now - CLOCK_PAST_MS && value <= now + CLOCK_FUTURE_MS
}

function parseFile(file: string): Omit<ServerState, "recovered"> {
  const raw = fs.readFileSync(file, "utf8")
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (!parsed || typeof parsed !== "object") throw new Error("event.json is not an object")
  const event = asEventConfig(parsed.event ?? parsed)
  if (!event) throw new Error("event.json has no valid event")
  const testUntil = typeof parsed.testUntil === "number" ? parsed.testUntil : null
  const pausedAt = typeof parsed.pausedAt === "number" ? parsed.pausedAt : null
  let testSetAt = typeof parsed.testSetAt === "number" ? parsed.testSetAt : null
  // Files from before testSetAt existed: date the clock by the file's last write.
  if (testSetAt === null && (testUntil !== null || pausedAt !== null)) testSetAt = fs.statSync(file).mtimeMs
  if (testUntil === null && pausedAt === null) testSetAt = null
  return {
    event,
    testUntil,
    pausedAt,
    testSetAt,
    stage: parseStage(parsed.stage),
    rev: typeof parsed.rev === "number" && Number.isInteger(parsed.rev) ? parsed.rev : 0,
  }
}

function defaults(): Omit<ServerState, "recovered"> {
  return { event: { ...DEFAULT_EVENT }, testUntil: null, pausedAt: null, testSetAt: null, stage: { ...DEFAULT_STAGE }, rev: 0 }
}

export function readServerState(): ServerState {
  const file = eventFile()
  if (!fs.existsSync(file)) return defaults()
  try {
    return parseFile(file)
  } catch (error) {
    console.warn("Could not read event.json; trying event.json.bak.", error)
  }
  try {
    return { ...parseFile(`${file}.bak`), recovered: "backup" }
  } catch {
    console.warn("event.json.bak is missing or unreadable too; using the default event.")
    return { ...defaults(), recovered: "defaults" }
  }
}

/** What OBS pages see: a test clock older than 2 hours is dropped so a forgotten rehearsal can't go out live. */
export function publicState(state: ServerState, now = Date.now()) {
  const stale = testClockStale(state.testSetAt, now)
  return {
    event: state.event,
    testUntil: stale ? null : state.testUntil,
    pausedAt: stale ? null : state.pausedAt,
    stage: state.stage,
    rev: state.rev,
  }
}

export class RevConflict extends Error {
  constructor(public current: number) {
    super("The desk was changed in another tab or device.")
  }
}

export function writeServerEvent(
  value: unknown,
  testUntil?: number | null,
  pausedAt?: number | null,
  stage?: unknown,
  expectedRev?: number,
  now = Date.now(),
): { event: EventConfig; rev: number } | null {
  const event = asEventConfig(value)
  if (!event) return null
  fs.mkdirSync(dataDir(), { recursive: true })
  const file = eventFile()
  const current = readServerState()
  const nextUntil = testUntil === undefined ? current.testUntil : testUntil
  const nextPaused = pausedAt === undefined ? current.pausedAt : pausedAt
  const nextStage = stage === undefined ? current.stage : parseStage(stage, current.stage)
  // Same content as what's saved: nothing to write and nothing to conflict with. Keeps rev still,
  // so two synced desks echoing the same values never ping-pong revisions.
  if (
    !current.recovered &&
    fs.existsSync(file) &&
    JSON.stringify([event, nextUntil, nextPaused, nextStage]) === JSON.stringify([current.event, current.testUntil, current.pausedAt, current.stage])
  ) {
    return { event, rev: current.rev }
  }
  if (expectedRev !== undefined && expectedRev !== current.rev) throw new RevConflict(current.rev)
  const clockChanged = nextUntil !== current.testUntil || nextPaused !== current.pausedAt
  const testSetAt = nextUntil === null && nextPaused === null ? null : clockChanged ? now : current.testSetAt ?? now
  const rev = current.rev + 1
  const payload = JSON.stringify(
    {
      rev,
      event,
      testUntil: nextUntil,
      pausedAt: nextPaused,
      testSetAt,
      stage: nextStage,
    },
    null,
    2,
  )
  // Keep the last good file as event.json.bak (never overwrite a good backup with a broken file).
  if (!current.recovered && fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`)
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, payload)
  fs.renameSync(temporary, file)
  emitSaved(rev)
  return { event, rev }
}

/** True once an operator has saved at least once (data/event.json exists). */
export function hasServerEvent(): boolean {
  return fs.existsSync(eventFile())
}
