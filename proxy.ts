import { NextResponse, type NextRequest } from "next/server"
import { isOperator, safeNext } from "@/lib/auth"

/**
 * Page guard: the desk (/) needs an operator. In local mode (Mac, 127.0.0.1, no
 * password) loopback requests pass, so `npm run dev` behaves as before.
 * APIs check auth themselves; OBS pages (/stream, /end, /media) use the view key.
 */
export function proxy(request: NextRequest) {
  if (isOperator(request)) return NextResponse.next()
  const login = new URL("/login", request.url)
  login.searchParams.set("next", safeNext(request.nextUrl.pathname + request.nextUrl.search))
  return NextResponse.redirect(login)
}

export const config = {
  matcher: ["/"],
}
