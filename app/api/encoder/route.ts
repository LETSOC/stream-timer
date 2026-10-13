import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import {
  maybeRefreshStaleSlate,
  parseStartInput,
  readStatus,
  restartEncoder,
  startEncoder,
  startRtmpStream,
  stopEncoder,
  stopRtmpStream, stopAllRtmp,
  type RtmpSource,
} from "@/lib/encoder"
import { getViewKey } from "@/lib/view-key"
import { resolveDestination } from "@/lib/rtmp-destinations"

export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  await maybeRefreshStaleSlate()
  return Response.json(readStatus())
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
  const record = body as { replace?: boolean; restart?: boolean; mode?: string; rtmpUrl?: string; destinationId?: string }
  if (record.mode === "rtmp") {
    // The desk sends a saved destination id; the URL (with key) is resolved here and never round-trips.
    let rtmpUrl = typeof record.rtmpUrl === "string" ? record.rtmpUrl : ""
    if (typeof record.destinationId === "string") {
      const destination = resolveDestination(record.destinationId)
      if (!destination) return Response.json({ ...readStatus(), error: "That destination no longer exists. Pick another." }, { status: 404 })
      rtmpUrl = destination.url
    }
    const rec = body as { source?: unknown; captureSize?: unknown }
    let source: RtmpSource = { kind: "slate" }
    if (rec.source === "capture") {
      // Capture loads /stream from this server on loopback with the view key (never leaves the machine).
      const port = new URL(request.url).port || "43211"
      const origin = process.env.CAPTURE_ORIGIN || `http://127.0.0.1:${port}`
      source = { kind: "capture", pageUrl: `${origin}/stream?k=${encodeURIComponent(getViewKey())}`, size: rec.captureSize === "1920x1080" ? "1920x1080" : "1280x720" }
    }
    const result = await startRtmpStream(input, rtmpUrl, Date.now(), source)
    if (!result.ok) return Response.json({ ...readStatus(), error: result.error }, { status: result.status })
    return Response.json({ ...readStatus(), note: result.note ?? null })
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
  const target = new URL(request.url).searchParams.get("target")
  if (target === "rtmp-all") {
    const result = await stopAllRtmp()
    return Response.json({ ...readStatus(), note: `Stopped ${result.stopped.length} stream supervisor(s) and ${result.strays.length} stray ffmpeg publisher(s).` })
  }
  if (target === "rtmp") {
    const result = await stopRtmpStream()
    if (!result.ok) return Response.json({ ...readStatus(), error: result.error }, { status: result.status })
    await stopEncoder()
    return Response.json({ ...readStatus(), note: result.note ?? null })
  }
  await stopEncoder()
  return Response.json(readStatus())
}
