import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { eventProblems } from "@/lib/event"
import { hasServerEvent, readServerState, writeServerEvent } from "@/lib/event-server"

export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  const state = readServerState()
  const body: { event: typeof state.event; testUntil: number | null; pausedAt: number | null; stage: typeof state.stage; hasSaved: boolean } = {
    event: state.event,
    testUntil: state.testUntil,
    pausedAt: state.pausedAt,
    stage: state.stage,
    hasSaved: hasServerEvent(),
  }
  return Response.json(body)
}

export async function PUT(request: Request) {
  await connection()
  const denied = authorizeMutation(request)
  if (denied) return denied
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 })
  }
  const record = body && typeof body === "object" ? (body as { event?: unknown; testUntil?: unknown; pausedAt?: unknown; stage?: unknown }) : null
  const testUntil = record && "testUntil" in record ? (typeof record.testUntil === "number" ? record.testUntil : null) : undefined
  const pausedAt = record && "pausedAt" in record ? (typeof record.pausedAt === "number" ? record.pausedAt : null) : undefined
  const saved = writeServerEvent(record?.event ?? body, testUntil, pausedAt, record?.stage)
  if (!saved) {
    const problems = eventProblems(record?.event ?? body)
    return Response.json({ error: problems.length ? problems.join(" ") : "Event payload was not valid.", problems }, { status: 400 })
  }
  return Response.json({ event: saved })
}
