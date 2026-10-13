import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { listAudioFiles, MAX_AUDIO_BYTES, saveAudioUpload } from "@/lib/audio-bed"

/** Operator-only audio bed upload. Body = raw file bytes; ?name= the original file name. Checked with ffprobe. */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request) ?? requireOperator(request)
  if (denied) return denied
  if (Number(request.headers.get("content-length") ?? 0) > MAX_AUDIO_BYTES) return Response.json({ error: `Audio is over ${MAX_AUDIO_BYTES / 1e6} MB.` }, { status: 413 })
  const bytes = new Uint8Array(await request.arrayBuffer())
  const result = saveAudioUpload(bytes, new URL(request.url).searchParams.get("name"))
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status })
  return Response.json({ file: result.file, files: listAudioFiles() })
}
