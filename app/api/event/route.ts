import { connection } from "next/server"
import { authorizeMutation, getEncoderToken, isLoopbackRequest } from "@/lib/encoder-auth"
import { readServerState, writeServerEvent } from "@/lib/event-server"

export async function GET(request: Request) {
  await connection()
  const state = readServerState()
  const body: { event: typeof state.event; testUntil: number | null; pausedAt: number | null; token?: string } = {
    event: state.event,
    testUntil: state.testUntil,
    pausedAt: state.pausedAt,
  }
  if (isLoopbackRequest(request)) body.token = getEncoderToken()
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
  const record = body && typeof body === "object" ? (body as { event?: unknown; testUntil?: unknown; pausedAt?: unknown }) : null
  const testUntil = record && "testUntil" in record ? (typeof record.testUntil === "number" ? record.testUntil : null) : undefined
  const pausedAt = record && "pausedAt" in record ? (typeof record.pausedAt === "number" ? record.pausedAt : null) : undefined
  const saved = writeServerEvent(record?.event ?? body, testUntil, pausedAt)
  if (!saved) return Response.json({ error: "Event payload was not valid." }, { status: 400 })
  return Response.json({ event: saved })
}
