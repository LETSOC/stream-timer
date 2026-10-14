import { connection } from "next/server"
import { VIEW_COOKIE } from "@/lib/auth"
import { publicState, readServerState } from "@/lib/event-server"
import { canView, viewKeyMatches } from "@/lib/view-key"
import { programReady } from "@/lib/relay"

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
  return Response.json({ ...publicState(readServerState()), programReady: await programReady().catch(() => false), build: process.env.APP_BUILD ?? null }, { headers })
}
