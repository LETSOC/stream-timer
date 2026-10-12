import { connection } from "next/server"
import { authMode, isOperator, refreshedCookie } from "@/lib/auth"

export async function GET(request: Request) {
  await connection()
  const refreshed = refreshedCookie(request)
  return Response.json(
    { mode: authMode(), operator: isOperator(request) },
    refreshed ? { headers: { "Set-Cookie": refreshed } } : undefined,
  )
}
