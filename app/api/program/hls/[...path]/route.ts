import { connection } from "next/server"
import { BACKUP_PATH, PROGRAM_PATH } from "@/lib/relay"
import { proxyRelayHls, validHlsPath } from "@/lib/hls-proxy"
import { canView } from "@/lib/view-key"

/**
 * The OBS program feed for /stream viewers (OBS Browser Source, Browser capture): LL-HLS of the
 * relay's /program path only, behind the same gate as /api/public/state (view key cookie/?k=,
 * operator session, or the internal capture key). MediaMTX's read login never leaves the server.
 */
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  await connection()
  if (!canView(request)) return new Response("View key required", { status: 401 })
  const { path } = await context.params
  if (!validHlsPath(path, [PROGRAM_PATH, BACKUP_PATH])) return new Response("Not found", { status: 404 })
  return proxyRelayHls(request, path)
}
