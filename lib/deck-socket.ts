import type { IncomingMessage } from "node:http"
import type { WebSocket, WebSocketServer } from "ws"
import { getSession, isOperator, SESSION_COOKIE, readCookie } from "@/lib/auth"
import { originAllowed } from "@/lib/encoder-auth"
import { onSaved } from "@/lib/event-bus"
import { parseAction } from "@/lib/transport"
import { currentDeckState, runServerTransport } from "@/lib/transport-server"

export const DECK_WS_PATH = "/api/deck/ws"

/**
 * Build a fetch Request from an upgrade request so the WebSocket uses exactly the same auth code
 * as HTTP routes. The real socket address is appended to X-Forwarded-For (never trusted from the
 * client alone), so "local mode" only applies when every hop, including the socket, is loopback.
 */
export function upgradeRequest(req: Pick<IncomingMessage, "headers" | "url">, remoteAddress: string | undefined): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(", ") : value)
  }
  const socket = (remoteAddress ?? "").replace(/^::ffff:/, "")
  const xff = headers.get("x-forwarded-for")
  headers.set("x-forwarded-for", xff ? `${xff}, ${socket || "unknown"}` : socket || "unknown")
  return new Request(`http://${headers.get("host") || "invalid"}${req.url ?? "/"}`, { headers })
}

/**
 * Upgrade gate: a browser Origin that is same-origin/loopback (blocks cross-site WebSocket
 * hijacking, which cookies alone don't), then an operator session or local mode. No encoder
 * token: the deck is a browser surface. Returns an HTTP status to refuse with, or null.
 */
export function deckUpgradeDenied(request: Request): 401 | 403 | null {
  if (!request.headers.get("origin") || !originAllowed(request)) return 403
  if (!isOperator(request)) return 401
  return null
}

const PING_MS = 15_000

/** Wire one accepted socket: state on connect and on every save, actions in, results out. */
export function attachDeckSocket(ws: WebSocket, request: Request) {
  const hasSession = Boolean(readCookie(request, SESSION_COOKIE))
  const send = (message: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
  }
  send({ type: "state", state: currentDeckState() })
  let lastRev = -1
  const off = onSaved((rev) => {
    if (rev === lastRev) return
    lastRev = rev
    send({ type: "state", state: currentDeckState() })
  })
  let alive = true
  ws.on("pong", () => (alive = true))
  const timer = setInterval(() => {
    // Session cookies expire; a long-lived socket must not outlive its login.
    if (hasSession && !getSession(request)) return ws.close(4401, "Session expired")
    if (!alive) return ws.terminate()
    alive = false
    ws.ping()
  }, PING_MS)
  ws.on("close", () => {
    clearInterval(timer)
    off()
  })
  ws.on("message", (data, isBinary) => {
    if (isBinary || (data as Buffer).length > 4096) return ws.close(1009, "Message too large")
    let message: { type?: unknown; id?: unknown; action?: unknown; rev?: unknown }
    try {
      message = JSON.parse(String(data))
    } catch {
      return send({ type: "error", error: "Expected JSON." })
    }
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null
    if (message.type === "hello") return send({ type: "state", state: currentDeckState() })
    if (message.type !== "action") return send({ type: "result", id, ok: false, status: 400, error: "Unknown message." })
    if (hasSession && !getSession(request)) return ws.close(4401, "Session expired")
    const action = parseAction(message.action)
    if (!action) return send({ type: "result", id, ok: false, status: 400, error: "Unknown action." })
    const rev = typeof message.rev === "number" ? message.rev : undefined
    const result = runServerTransport(action, rev)
    send({ type: "result", id, ...result, status: result.ok ? 200 : result.status })
  })
}

/** Route an HTTP upgrade: the deck socket is ours; anything else (Next dev HMR) goes to Next. */
export function handleDeckUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): boolean {
  const pathname = (req.url ?? "").split("?")[0]
  if (pathname !== DECK_WS_PATH) return false
  const request = upgradeRequest(req, req.socket.remoteAddress)
  const denied = deckUpgradeDenied(request)
  if (denied) {
    socket.write(`HTTP/1.1 ${denied} ${denied === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
    return true
  }
  wss.handleUpgrade(req, socket, head, (ws) => attachDeckSocket(ws, request))
  return true
}
