import { connection } from "next/server"
import { authMode, createSessionToken, sessionCookie, verifyPassword } from "@/lib/auth"
import { originAllowed } from "@/lib/encoder-auth"
import { clientKey, lockedFor, recordFailure, recordSuccess } from "@/lib/rate-limit"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function POST(request: Request) {
  await connection()
  if (!originAllowed(request)) return Response.json({ error: "Cross-origin login is not allowed." }, { status: 403 })
  if (authMode() === "local") return Response.json({ ok: true, mode: "local" })
  if (!process.env.OPERATOR_PASSWORD_HASH && !process.env.OPERATOR_PASSWORD) {
    return Response.json({ error: "No operator password is configured on the server (OPERATOR_PASSWORD_HASH)." }, { status: 503 })
  }
  const key = clientKey(request)
  const locked = lockedFor(key)
  if (locked > 0) {
    const retryAfter = Math.ceil(locked / 1000)
    return Response.json({ error: `Too many attempts. Try again in ${retryAfter}s.`, retryAfter }, { status: 429, headers: { "Retry-After": String(retryAfter) } })
  }
  let password = ""
  try {
    const body = (await request.json()) as { password?: unknown }
    password = typeof body.password === "string" ? body.password : ""
  } catch {
    /* treated as wrong */
  }
  if (!password || !verifyPassword(password)) {
    await delay(300)
    const lockMs = recordFailure(key)
    console.warn(`[auth] failed login (${key})${lockMs ? `, locked ${Math.ceil(lockMs / 1000)}s` : ""}`)
    return Response.json({ error: lockMs ? `Wrong password. Locked for ${Math.ceil(lockMs / 1000)}s.` : "Wrong password." }, { status: 401 })
  }
  recordSuccess(key)
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(request, createSessionToken()) } })
}
