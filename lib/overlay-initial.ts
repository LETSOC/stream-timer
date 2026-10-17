import { cookies, headers } from "next/headers"
import { publicState, readServerState } from "@/lib/event-server"
import { isOperator, VIEW_COOKIE } from "@/lib/auth"
import { viewKeyMatches, viewKeyRequired } from "@/lib/view-key"
import { isCaptureRequest } from "@/lib/capture-key"

/** Same gate as /stream: embed the saved state only for a valid view key, cookie, operator or capture browser. */
export async function overlayInitial(params: Record<string, string | string[] | undefined>) {
  const k = typeof params.k === "string" ? params.k : ""
  const cookieKey = (await cookies()).get(VIEW_COOKIE)?.value
  const requestHeaders = await headers()
  const operator = () => isOperator(new Request("http://local/overlay", { headers: requestHeaders }))
  if (!viewKeyRequired() || viewKeyMatches(k) || viewKeyMatches(cookieKey) || isCaptureRequest(requestHeaders) || operator()) {
    const { event, stage } = publicState(readServerState())
    return { event, stage }
  }
  return null
}
