import { connection } from "next/server"
import { VIEW_COOKIE } from "@/lib/auth"
import { publicState, readServerState } from "@/lib/event-server"
import { canView, viewKeyMatches } from "@/lib/view-key"
import { programReady, readSettings } from "@/lib/relay"
import { readAudioSettings } from "@/lib/audio-bed"
import { rearmHoldLeftMs } from "@/lib/program-rearm"

/**
 * Read-only state for OBS pages (/stream, /end). Only what they render:
 * no token, no RTMP URL/state/logs, no pids.
 */
export async function GET(request: Request) {
  await connection()
  if (!canView(request)) return Response.json({ error: "View key required. Copy the OBS URL from the desk." }, { status: 401 })
  const key = new URL(request.url).searchParams.get("k")
  const headers: Record<string, string> = { "Cache-Control": "no-store" }
  // Lets the HLS player fetch /media segments (which carry no ?k=) on the same browser.
  if (viewKeyMatches(key)) headers["Set-Cookie"] = `${VIEW_COOKIE}=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
  // programReady: one boolean about the OBS feed (no URLs, logins or relay details).
  // programReady = the active input; backupReady/mainReady so /stream can prewarm both for an instant switch.
  const state = readServerState()
  const [mainReady, backupReady] = await Promise.all([programReady("main").catch(() => false), programReady("backup").catch(() => false)])
  const programReadyNow = state.stage.programSource === "backup" ? backupReady : mainReady
  // rearmHoldMs: ms left of a disarm/arm cycle (auto re-arm or the desk buttons): hold the last frame, no "Waiting for OBS".
  // In-page bed for /stream (only when routed): the capture channel's bed settings, file ids only.
  const cap = state.stage.streamBedAudio ? readAudioSettings().channels.capture : null
  const bed = cap ? { mode: cap.mode, files: cap.files, shuffle: cap.order === "shuffle", volumeDb: cap.volumeDb, toneHz: cap.toneHz, toneDb: cap.toneDb, fadeInSec: cap.fadeInSec } : null
  return Response.json({ ...publicState(state), bed, programReady: programReadyNow, mainReady, backupReady, switchBufferMs: readSettings().failover.switchBufferMs, crossfadeMs: readSettings().failover.crossfadeMs, rearmHoldMs: rearmHoldLeftMs(), build: process.env.APP_BUILD ?? null }, { headers })
}
