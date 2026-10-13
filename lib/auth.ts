import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "@/lib/encoder"
import { bearerAuthorized, isLoopbackRequest, originAllowed } from "@/lib/encoder-auth"

/**
 * Operator auth. One entry point (getSession / isOperator / requireOperator) so
 * OAuth can replace the password later without touching routes.
 *
 * AUTH_MODE:
 *  - local    : bound to loopback and no password set. Loopback requests are the operator (today's Mac workflow).
 *  - password : a password is set, or the server is not bound to loopback. Always log in.
 */
export type AuthMode = "local" | "password"

export const SESSION_COOKIE = "st_session"
export const VIEW_COOKIE = "st_view"
const SESSION_TTL_S = 12 * 60 * 60
const REFRESH_BELOW_S = 2 * 60 * 60

function loopback(value: string): boolean {
  const host = value.trim().replace(/^\[|\]$/g, "")
  return host === "127.0.0.1" || host === "::1" || host === "localhost"
}

export function passwordConfigured(): boolean {
  return Boolean(process.env.OPERATOR_PASSWORD_HASH?.trim() || process.env.OPERATOR_PASSWORD)
}

export function authMode(): AuthMode {
  const explicit = process.env.AUTH_MODE?.trim().toLowerCase()
  const bind = process.env.BIND_HOST?.trim()
  const remoteBind = Boolean(bind && !loopback(bind))
  if (explicit === "password" || passwordConfigured() || remoteBind) return "password"
  return "local"
}

// ---------- password ----------

/** Format: scrypt$N$r$p$saltB64url$hashB64url */
export function hashPassword(password: string, salt = randomBytes(16)): string {
  const N = 16384, r = 8, p = 1
  const hash = scryptSync(password, salt, 32, { N, r, p })
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`
}

export function verifyPassword(input: string): boolean {
  const stored = process.env.OPERATOR_PASSWORD_HASH?.trim()
  if (stored) {
    const parts = stored.split("$")
    if (parts.length !== 6 || parts[0] !== "scrypt") return false
    const [, n, r, p, salt, hash] = parts
    const expected = Buffer.from(hash, "base64url")
    const actual = scryptSync(input, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) })
    return expected.length > 0 && timingSafeEqual(expected, actual)
  }
  const plain = process.env.OPERATOR_PASSWORD
  if (!plain) return false
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(input).digest()
  const b = createHash("sha256").update(plain).digest()
  return timingSafeEqual(a, b)
}

// ---------- session cookie ----------

function secretFile() {
  return path.join(DATA_DIR, "session-secret")
}

/** SESSION_SECRET env, else a random secret kept in data/session-secret (0600). */
export function sessionSecret(): string {
  const env = process.env.SESSION_SECRET
  if (env && env.length >= 32) return env
  try {
    const existing = fs.readFileSync(secretFile(), "utf8").trim()
    if (existing.length >= 32) return existing
  } catch {
    /* create below */
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const secret = randomBytes(32).toString("base64url")
  fs.writeFileSync(secretFile(), secret, { mode: 0o600 })
  return secret
}

type SessionPayload = { v: 1; sub: string; iat: number; exp: number; ver: string }

function sign(data: string): string {
  return createHmac("sha256", sessionSecret()).update(data).digest("base64url")
}

function sessionVersion(): string {
  return process.env.SESSION_VERSION ?? "1"
}

export function createSessionToken(sub = "operator", now = Math.floor(Date.now() / 1000)): string {
  const payload: SessionPayload = { v: 1, sub, iat: now, exp: now + SESSION_TTL_S, ver: sessionVersion() }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${body}.${sign(body)}`
}

export function verifySessionToken(token: string | undefined, now = Math.floor(Date.now() / 1000)): SessionPayload | null {
  if (!token) return null
  const [body, mac] = token.split(".")
  if (!body || !mac) return null
  const expected = Buffer.from(sign(body))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload
    if (payload.v !== 1 || typeof payload.exp !== "number" || payload.exp <= now) return null
    if (payload.ver !== sessionVersion()) return null
    return payload
  } catch {
    return null
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie")
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key !== name) continue
    try {
      return decodeURIComponent(rest.join("="))
    } catch {
      return undefined // malformed %-escape: treat as no cookie instead of a 500
    }
  }
  return undefined
}

function secureCookies(request: Request): boolean {
  if (process.env.COOKIE_SECURE === "0") return false
  if (process.env.COOKIE_SECURE === "1") return true
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "")
  return proto === "https"
}

export function sessionCookie(request: Request, token: string, maxAge = SESSION_TTL_S): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secureCookies(request) ? "Secure" : "",
  ].filter(Boolean).join("; ")
}

export function clearSessionCookie(request: Request): string {
  return sessionCookie(request, "", 0)
}

export function getSession(request: Request): SessionPayload | null {
  return verifySessionToken(readCookie(request, SESSION_COOKIE))
}

/** A fresh cookie when the session is close to expiring (sliding refresh), else null. */
export function refreshedCookie(request: Request): string | null {
  const session = getSession(request)
  if (!session) return null
  if (session.exp - Math.floor(Date.now() / 1000) > REFRESH_BELOW_S) return null
  return sessionCookie(request, createSessionToken(session.sub))
}

export function isOperator(request: Request): boolean {
  if (authMode() === "local" && isLoopbackRequest(request)) return true
  return getSession(request) !== null
}

export function requireOperator(request: Request): Response | null {
  if (isOperator(request)) return null
  return Response.json({ error: "Log in to the desk first.", login: "/login" }, { status: 401 })
}

/** Only same-origin relative paths, so ?next= cannot redirect off-site. */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/"
  return value
}

/** For PUT/POST/DELETE: same-origin, then an operator session (or local mode) or the machine bearer token. */
export function authorizeMutation(request: Request): Response | null {
  if (!originAllowed(request)) {
    return Response.json({ error: "Cross-origin changes are not allowed." }, { status: 403 })
  }
  if (isOperator(request) || bearerAuthorized(request)) return null
  return Response.json({ error: "Log in to the desk first.", login: "/login" }, { status: 401 })
}
