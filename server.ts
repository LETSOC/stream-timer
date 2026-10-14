/**
 * Custom server: Next.js plus the phone-deck WebSocket on the SAME port.
 * Same flags as before: `--hostname ${BIND_HOST:-127.0.0.1} --port 43211` (PORT overrides the port).
 *   npm start  -> production (needs `npm run build` first)
 *   npm run dev -> dev with HMR (HMR's own WebSocket is passed through to Next untouched)
 */
import { createServer } from "node:http"
import next from "next"
import { WebSocketServer } from "ws"
import { handleDeckUpgrade } from "./lib/deck-socket"

const dev = process.argv.includes("--dev")
const hostname = process.env.BIND_HOST?.trim() || "127.0.0.1"
const port = Number(process.env.PORT) || 43211
if (!dev) (process.env as Record<string, string>).NODE_ENV = "production"

const app = next({ dev, hostname, port, dir: __dirname })

async function main() {
  await app.prepare()
  const handle = app.getRequestHandler()
  const nextUpgrade = app.getUpgradeHandler()
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  const server = createServer((req, res) => void handle(req, res))
  server.on("upgrade", (req, socket, head) => {
    if (handleDeckUpgrade(wss, req, socket, head)) return
    void nextUpgrade(req, socket, head)
  })
  server.listen(port, hostname, () => {
    console.log(`▲ stream-timer ${dev ? "dev" : "production"} on http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port} (deck WebSocket on the same port)`)
  })
  const shutdown = () => {
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
