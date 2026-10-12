import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "@/lib/encoder"

const TOKEN_FILE = path.join(DATA_DIR, "encoder-token")

export function getEncoderToken(): string {
  if (process.env.ENCODER_TOKEN && process.env.ENCODER_TOKEN.length >= 16) {
    return process.env.ENCODER_TOKEN
  }
  try {
    const existing = fs.readFileSync(TOKEN_FILE, "utf8").trim()
    if (existing.length >= 16) return existing
  } catch {
    /* create below */
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const token = randomBytes(24).toString("hex")
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  return token
}

function loopbackHost(value: string | null): boolean {
  if (!value) return false
  const host = value.split(",")[0]?.trim().replace(/^\[|\]$/g, "")
  return host === "127.0.0.1" || host === "::1" || host === "localhost"
}

/**
 * Route handlers cannot see the socket address, and the Host header is set by
 * the client, so it is never trusted. (Not HOST: zsh on macOS sets HOST to the machine name.) A request counts as local only when the
 * server itself is bound to loopback (BIND_HOST unset or 127.0.0.1/::1/localhost)
 * and no proxy header names a non-loopback client. When BIND_HOST is a LAN or
 * public address, every request is treated as remote: the token is never
 * handed out and mutations need ENCODER_ALLOW_REMOTE=1 plus ENCODER_TOKEN.
 */
// Headers Next.js never adds itself: their presence means a proxy/tunnel (Cloudflare, nginx, ngrok).
const FOREIGN_PROXY_HEADERS = ["forwarded", "cf-connecting-ip", "true-client-ip", "x-client-ip", "fly-client-ip"]

function hostOnly(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("[")) return trimmed.slice(0, trimmed.indexOf("]") + 1)
  return trimmed.split(":")[0]
}

function everyHopLoopback(value: string | null): boolean {
  if (value === null) return true
  return value.split(",").every((hop) => loopbackHost(hop.trim()))
}

export function isLoopbackRequest(request: Request): boolean {
  const bind = process.env.BIND_HOST?.trim()
  if (bind && !loopbackHost(bind)) return false
  const headers = request.headers
  if (FOREIGN_PROXY_HEADERS.some((name) => headers.has(name))) return false
  // Next.js fills X-Forwarded-For with the socket address only when it is missing,
  // and a local proxy appends the real client. Every hop must be loopback, not just
  // the first (client-controlled) entry.
  if (!everyHopLoopback(headers.get("x-forwarded-for"))) return false
  if (!everyHopLoopback(headers.get("x-real-ip"))) return false
  // The Host header cannot prove locality, but a non-loopback Host (or forwarded
  // host) on a loopback bind means DNS rebinding or a public tunnel. Refuse it.
  if (!loopbackHost(hostOnly(headers.get("host") ?? ""))) return false
  const forwardedHost = headers.get("x-forwarded-host")
  if (forwardedHost !== null && !loopbackHost(hostOnly(forwardedHost.split(",")[0]))) return false
  return true
}

/** Browsers always send Origin on cross-site POST/PUT/DELETE. Only loopback pages may mutate. */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin || origin === "null") return origin === null
  try {
    return loopbackHost(new URL(origin).hostname) || process.env.ENCODER_ALLOW_REMOTE === "1"
  } catch {
    return false
  }
}

function tokensMatch(expected: string, provided: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(provided)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function authorizeMutation(request: Request): Response | null {
  if (!isLoopbackRequest(request) && process.env.ENCODER_ALLOW_REMOTE !== "1") {
    return Response.json({ error: "Encoder mutations are local only." }, { status: 403 })
  }
  if (!originAllowed(request)) {
    return Response.json({ error: "Cross-origin encoder mutations are not allowed." }, { status: 403 })
  }
  const header = request.headers.get("x-encoder-token")
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  const provided = header || bearer || ""
  if (!tokensMatch(getEncoderToken(), provided)) {
    return Response.json({ error: "Missing or wrong encoder token." }, { status: 401 })
  }
  return null
}
