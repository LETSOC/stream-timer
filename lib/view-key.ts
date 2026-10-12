import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { authMode, isOperator, readCookie, VIEW_COOKIE } from "@/lib/auth"
import { DATA_DIR } from "@/lib/encoder"

/** Read-only key for OBS pages (/stream, /end, /media). VIEW_KEY env, else data/view-key (0600). */
function keyFile() {
  return path.join(DATA_DIR, "view-key")
}

export function getViewKey(): string {
  const env = process.env.VIEW_KEY
  if (env && env.length >= 16) return env
  try {
    const existing = fs.readFileSync(keyFile(), "utf8").trim()
    if (existing.length >= 16) return existing
  } catch {
    /* create below */
  }
  return rotateViewKey()
}

/** New random key (file only; an env VIEW_KEY must be changed in the environment). */
export function rotateViewKey(): string {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const key = randomBytes(32).toString("base64url")
  fs.writeFileSync(keyFile(), key, { mode: 0o600 })
  return key
}

export function viewKeyFromEnv(): boolean {
  return Boolean(process.env.VIEW_KEY && process.env.VIEW_KEY.length >= 16)
}

/** Required in password mode, or locally when REQUIRE_VIEW_KEY=1. */
export function viewKeyRequired(): boolean {
  return authMode() === "password" || process.env.REQUIRE_VIEW_KEY === "1"
}

export function viewKeyMatches(candidate: string | null | undefined): boolean {
  if (!candidate) return false
  const a = Buffer.from(getViewKey())
  const b = Buffer.from(candidate)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** ?k=, the st_view cookie, or an operator session. */
export function canView(request: Request): boolean {
  if (!viewKeyRequired()) return true
  if (isOperator(request)) return true
  const url = new URL(request.url)
  return viewKeyMatches(url.searchParams.get("k")) || viewKeyMatches(readCookie(request, VIEW_COOKIE))
}
