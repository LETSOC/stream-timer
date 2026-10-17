import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { liveFromStatus, makeSample, samplesToCsv } from "@/lib/av-diagnostics"
import { appendAvSample, archiveAvLog, readAvSamples } from "@/lib/av-log"
import { readAudioSettings } from "@/lib/audio-bed"
import { readServerState } from "@/lib/event-server"
import { mediamtxPathStats, relayStatus } from "@/lib/relay"

const NO_STORE = { "Cache-Control": "no-store" }

async function live() {
  const status = await relayStatus().catch(() => null)
  const source = status?.paths.capture?.source as { capture?: { programAudio?: Record<string, unknown> } } | null | undefined
  const cap = readAudioSettings().channels.capture
  return liveFromStatus(source?.capture?.programAudio ?? null, { avOffsetMs: cap.avOffsetMs ?? 0, programOffsetMs: cap.programOffsetMs ?? { main: 0, backup: 0 } }, readServerState().stage.programSource)
}

/** Read-only A/V numbers + MediaMTX path stats + the drift log. ?format=csv downloads the log. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  const url = new URL(request.url)
  if (url.searchParams.get("format") === "csv") {
    return new Response(samplesToCsv(readAvSamples()), { headers: { ...NO_STORE, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="av-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv"` } })
  }
  const [now, mtx] = await Promise.all([live(), mediamtxPathStats()])
  const samples = readAvSamples()
  return Response.json({
    serverNow: Date.now(),
    live: now,
    mediamtx: mtx ? { api: "on", url: mtx.url, paths: mtx.paths } : { api: "off", url: process.env.MEDIAMTX_API_URL || null, paths: [] },
    samples: samples.slice(-20),
    count: samples.length,
  }, { headers: NO_STORE })
}

/** { action: "mark", readingMs?, note? } logs one sample; { action: "new" } archives the log and starts fresh. */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request) ?? requireOperator(request)
  if (denied) return denied
  const body = (await request.json().catch(() => null)) as { action?: unknown; readingMs?: unknown; note?: unknown } | null
  if (body?.action === "mark") {
    const sample = makeSample(await live(), body)
    appendAvSample(sample)
    return Response.json({ ok: true, sample, count: readAvSamples().length }, { headers: NO_STORE })
  }
  if (body?.action === "new") return Response.json({ ok: true, archived: archiveAvLog() }, { headers: NO_STORE })
  return Response.json({ error: "Expected { action: mark | new }." }, { status: 400 })
}
