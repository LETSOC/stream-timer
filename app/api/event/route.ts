import { connection } from "next/server"
import { authorizeMutation, getEncoderToken, isLoopbackRequest } from "@/lib/encoder-auth"
import { readServerEvent, writeServerEvent } from "@/lib/event-server"

export async function GET(request: Request) {
  await connection()
  const body: { event: ReturnType<typeof readServerEvent>; token?: string } = {
    event: readServerEvent(),
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
  const record = body && typeof body === "object" ? (body as { event?: unknown }) : null
  const saved = writeServerEvent(record?.event ?? body)
  if (!saved) return Response.json({ error: "Event payload was not valid." }, { status: 400 })
  return Response.json({ event: saved })
}
