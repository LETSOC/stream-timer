import fs from "node:fs"
import { Readable } from "node:stream"
import { connection } from "next/server"
import { audioFilePath, listAudioFiles, readAudioSettings } from "@/lib/audio-bed"
import { readServerState } from "@/lib/event-server"
import { canView } from "@/lib/view-key"

const TYPES: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac" }

/** Bed file for /stream's in-page audio (view auth). Only files in the capture playlist, only while the bed is routed to /stream. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  await connection()
  if (!canView(request)) return new Response("View key required", { status: 401 })
  if (!readServerState().stage.streamBedAudio) return new Response("Not routed", { status: 404 })
  const { id } = await context.params
  if (!readAudioSettings().channels.capture.files.includes(id)) return new Response("Not found", { status: 404 })
  const file = listAudioFiles().find((item) => item.id === id)
  if (!file) return new Response("Not found", { status: 404 })
  const target = audioFilePath(file)
  let size = 0
  try { size = fs.statSync(/* turbopackIgnore: true */ target).size } catch { return new Response("Missing", { status: 404 }) }
  const headers = { "Content-Type": TYPES[file.ext] ?? "application/octet-stream", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "")
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } })
    return new Response(Readable.toWeb(fs.createReadStream(/* turbopackIgnore: true */ target, { start, end })) as ReadableStream, { status: 206, headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` } })
  }
  return new Response(Readable.toWeb(fs.createReadStream(/* turbopackIgnore: true */ target)) as ReadableStream, { headers: { ...headers, "Content-Length": String(size) } })
}
