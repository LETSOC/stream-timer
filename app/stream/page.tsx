import { cookies, headers } from "next/headers"
import { connection } from "next/server"
import { StreamClient, type StreamInitial } from "@/components/stream-view"
import { publicState, readServerState } from "@/lib/event-server"
import { isOperator, VIEW_COOKIE } from "@/lib/auth"
import { viewKeyMatches, viewKeyRequired } from "@/lib/view-key"
import { isCaptureRequest } from "@/lib/capture-key"

/**
 * Renders the saved public state on the server so OBS never flashes the default event on reload.
 * Same gate as /api/public/state: without a valid view key nothing is embedded and the client
 * falls back to fetching (which shows the "view key required" screen).
 */
export default async function StreamPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection()
  const params = await searchParams
  const k = typeof params.k === "string" ? params.k : ""
  const cookieKey = (await cookies()).get(VIEW_COOKIE)?.value
  const requestHeaders = await headers()
  // An operator session (e.g. the phone deck's preview iframe) may view without the OBS key in the URL.
  const operator = () => isOperator(new Request("http://local/stream", { headers: requestHeaders }))
  let initial: StreamInitial | null = null
  if (!viewKeyRequired() || viewKeyMatches(k) || viewKeyMatches(cookieKey) || isCaptureRequest(requestHeaders) || operator()) {
    const { event, testUntil, pausedAt, stage } = publicState(readServerState())
    initial = { event, testUntil, pausedAt, stage }
  }
  return <StreamClient initial={initial} />
}
