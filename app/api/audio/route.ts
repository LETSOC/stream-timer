import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { deleteAudioFile, listAudioFiles, readAudioSettings, saveAudioSettings, writeLiveAudio } from "@/lib/audio-bed"

const NO_STORE = { "Cache-Control": "no-store" }

/** Operator only. Saved per-channel audio settings (with rev for sync) + the audio library. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  return Response.json({ settings: readAudioSettings(), files: listAudioFiles() }, { headers: NO_STORE })
}

/** { action: "save", channels: { slate, capture }, baseRev } | { action: "delete", id } */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request) ?? requireOperator(request)
  if (denied) return denied
  const body = (await request.json().catch(() => null)) as { action?: unknown; channels?: unknown; baseRev?: unknown; id?: unknown } | null
  if (body?.action === "save") {
    const result = saveAudioSettings(body.channels, body.baseRev)
    // Live channels hot-swap to it (audio feeder); stopped channels use it at their next start.
    if (result.ok) for (const channel of ["slate", "capture"] as const) writeLiveAudio(channel)
    return Response.json(result.ok ? { settings: result.settings, files: listAudioFiles() } : { error: result.error, settings: result.settings, files: listAudioFiles() }, { status: result.ok ? 200 : result.status, headers: NO_STORE })
  }
  if (body?.action === "delete") {
    if (!deleteAudioFile(body.id)) return Response.json({ error: "No such file." }, { status: 404, headers: NO_STORE })
    for (const channel of ["slate", "capture"] as const) writeLiveAudio(channel)
    return Response.json({ settings: readAudioSettings(), files: listAudioFiles() }, { headers: NO_STORE })
  }
  return Response.json({ error: "Expected { action: save | delete }." }, { status: 400 })
}
