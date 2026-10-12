import { clearSessionCookie } from "@/lib/auth"
import { originAllowed } from "@/lib/encoder-auth"

export async function POST(request: Request) {
  if (!originAllowed(request)) return Response.json({ error: "Cross-origin logout is not allowed." }, { status: 403 })
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie(request) } })
}
