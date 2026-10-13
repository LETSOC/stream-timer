import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { eventProblems } from "@/lib/event"
import { hasServerEvent, readServerState, RevConflict, validClockValue, writeServerEvent } from "@/lib/event-server"
import { testClockStale } from "@/lib/stage"

/** Inline data: images make bodies big; anything past this is a mistake or abuse. */
const MAX_BODY_BYTES = 2_000_000

export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  const state = readServerState()
  return Response.json({
    event: state.event,
    testUntil: state.testUntil,
    pausedAt: state.pausedAt,
    testSetAt: state.testSetAt,
    testStale: testClockStale(state.testSetAt),
    stage: state.stage,
    rev: state.rev,
    recovered: state.recovered ?? null,
    hasSaved: hasServerEvent(),
  })
}

export async function PUT(request: Request) {
  await connection()
  const denied = authorizeMutation(request)
  if (denied) return denied
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > MAX_BODY_BYTES) return Response.json({ error: "Save is too large (over 2 MB). Use smaller or linked images." }, { status: 413 })
  let body: unknown
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "Save is too large (over 2 MB). Use smaller or linked images." }, { status: 413 })
    body = JSON.parse(raw)
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 })
  }
  const record = body && typeof body === "object" ? (body as { event?: unknown; testUntil?: unknown; pausedAt?: unknown; stage?: unknown; rev?: unknown }) : null
  const clock = (key: "testUntil" | "pausedAt") => {
    if (!record || !(key in record)) return undefined
    const value = record[key]
    return typeof value === "number" ? value : null
  }
  const testUntil = clock("testUntil")
  const pausedAt = clock("pausedAt")
  for (const [name, value] of [["testUntil", testUntil], ["pausedAt", pausedAt]] as const) {
    if (typeof value === "number" && !validClockValue(value)) return Response.json({ error: `${name} is out of range.` }, { status: 400 })
  }
  const expectedRev = record && typeof record.rev === "number" ? record.rev : undefined
  try {
    const saved = writeServerEvent(record?.event ?? body, testUntil, pausedAt, record?.stage, expectedRev)
    if (!saved) {
      const problems = eventProblems(record?.event ?? body)
      return Response.json({ error: problems.length ? problems.join(" ") : "Event payload was not valid.", problems }, { status: 400 })
    }
    return Response.json(saved)
  } catch (error) {
    if (error instanceof RevConflict) return Response.json({ error: error.message, rev: error.current }, { status: 409 })
    throw error
  }
}
