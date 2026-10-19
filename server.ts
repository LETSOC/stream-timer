/**
 * Custom server: Next.js plus the phone-deck WebSocket on the SAME port.
 * Same flags as before: `--hostname ${BIND_HOST:-127.0.0.1} --port 43211` (PORT overrides the port).
 *   npm start  -> production (needs `npm run build` first)
 *   npm run dev -> dev with HMR (HMR's own WebSocket is passed through to Next untouched)
 */
import { stopMdns } from "./lib/mdns"
import { createServer } from "node:http"
import next from "next"
import { WebSocketServer } from "ws"
import { handleDeckUpgrade } from "./lib/deck-socket"
import { startProgramMonitor } from "./lib/program-monitor"
import { startDropoutMonitor } from "./lib/dropout-monitor"

const dev = process.argv.includes("--dev")
const hostname = process.env.BIND_HOST?.trim() || "127.0.0.1"
const port = Number(process.env.PORT) || 43211
if (!dev) (process.env as Record<string, string>).NODE_ENV = "production"

const app = next({ dev, hostname, port, dir: __dirname })

/** Idle keep-alive (ms): longer than Safari/iOS reuse idle sockets. */
const KEEP_ALIVE_MS = 75_000

async function main() {
  await app.prepare()
  const handle = app.getRequestHandler()
  const nextUpgrade = app.getUpgradeHandler()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  const server = createServer((req, res) => void handle(req, res))
  // Node closes idle keep-alive sockets after 5s; iOS Safari reuses them longer and a POST sent on a
  // socket the server just closed fails as a network error ("Could not reach the server" on login).
  // Outlive the client's idle reuse window (headersTimeout must exceed keepAliveTimeout).
  server.keepAliveTimeout = KEEP_ALIVE_MS
  server.headersTimeout = KEEP_ALIVE_MS + 5_000
  server.on("upgrade", (req, socket, head) => {
    if (handleDeckUpgrade(wss, req, socket, head)) return
    void nextUpgrade(req, socket, head)
  })
  startProgramMonitor()
  startDropoutMonitor()
  server.listen(port, hostname, () => {
    console.log(`▲ stream-timer ${dev ? "dev" : "production"} on http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port} (deck WebSocket on the same port)`)
  })
  const shutdown = () => {
    stopMdns() // goodbye packets: <name>.local disappears from the LAN at once
    for (const client of wss.clients) client.close(1001, "Server shutting down")
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
