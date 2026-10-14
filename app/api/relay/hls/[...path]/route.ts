import { connection } from "next/server"
import { requireOperator } from "@/lib/auth"
import { PROGRAM_PATH, RELAY_PATHS } from "@/lib/relay"
import { proxyRelayHls, validHlsPath } from "@/lib/hls-proxy"

/**
 * LL-HLS preview of what is actually published to the relay, proxied from MediaMTX
 * (127.0.0.1 only) behind the desk's operator auth, so an iPhone on the LAN can watch it
 * without MediaMTX being reachable or its read credentials leaving the server.
 */
export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  const { path } = await context.params
  if (!validHlsPath(path, [...RELAY_PATHS, PROGRAM_PATH])) {
    return new Response("Not found", { status: 404 })
  }
  return proxyRelayHls(request, path)
}
