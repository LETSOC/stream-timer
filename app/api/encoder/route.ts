import { connection } from "next/server"
import { authorizeMutation, getEncoderToken, isLoopbackRequest } from "@/lib/encoder-auth"
import {
  maybeRefreshStaleSlate,
  parseStartInput,
  readStatus,
  restartEncoder,
  startEncoder,
  startRtmpStream,
  stopEncoder,
  stopRtmpStream,
} from "@/lib/encoder"

export async function GET(request: Request) {
  await connection()
  await maybeRefreshStaleSlate()
  const status = readStatus()
  if (!isLoopbackRequest(request)) return Response.json(status)
  return Response.json({ ...status, token: getEncoderToken() })
}

export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request)
  if (denied) return denied
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 })
  }
  const input = parseStartInput(body)
  if (!input) {
    return Response.json(
      { error: "Set a title, date line, and unix start time before encoding." },
      { status: 400 },
    )
  }
  const record = body as { replace?: boolean; restart?: boolean; mode?: string; rtmpUrl?: string }
  if (record.mode === "rtmp") {
    const result = await startRtmpStream(input, typeof record.rtmpUrl === "string" ? record.rtmpUrl : "")
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status })
    return Response.json(readStatus())
  }
  const result =
    record.replace || record.restart ? await restartEncoder(input) : await startEncoder(input)
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status })
  return Response.json(readStatus())
}

export async function DELETE(request: Request) {
  await connection()
  const denied = authorizeMutation(request)
  if (denied) return denied
  stopEncoder()
  if (new URL(request.url).searchParams.get("target") === "rtmp") stopRtmpStream()
  return Response.json(readStatus())
}
