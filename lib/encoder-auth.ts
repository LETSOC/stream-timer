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
 * the client, so it is never trusted. A request counts as local only when the
 * server itself is bound to loopback (HOST unset or 127.0.0.1/::1/localhost)
 * and no proxy header names a non-loopback client. When HOST is a LAN or
 * public address, every request is treated as remote: the token is never
 * handed out and mutations need ENCODER_ALLOW_REMOTE=1 plus ENCODER_TOKEN.
 */
export function isLoopbackRequest(request: Request): boolean {
  const bind = process.env.HOST?.trim()
  if (bind && !loopbackHost(bind)) return false
  const forwarded = request.headers.get("x-forwarded-for")
  const realIp = request.headers.get("x-real-ip")
  if (forwarded && !loopbackHost(forwarded)) return false
  if (realIp && !loopbackHost(realIp)) return false
  return true
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
  const header = request.headers.get("x-encoder-token")
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  const provided = header || bearer || ""
  if (!tokensMatch(getEncoderToken(), provided)) {
    return Response.json({ error: "Missing or wrong encoder token." }, { status: 401 })
  }
  return null
}
