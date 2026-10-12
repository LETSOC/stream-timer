"use client"

import { useEffect, useState } from "react"

export type OperatorSession = { ready: boolean; mode: "local" | "password"; operator: boolean; viewKey: string; viewKeyRequired: boolean; viewKeyFromEnv: boolean; origin: string }

/** Replaces the old token hand-out: the browser authenticates with the session cookie (or loopback in local mode). */
export function useOperator() {
  const [state, setState] = useState<OperatorSession>({ ready: false, mode: "local", operator: false, viewKey: "", viewKeyRequired: false, viewKeyFromEnv: false, origin: "" })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session = (await (await fetch("/api/auth/session", { cache: "no-store" })).json()) as { mode: "local" | "password"; operator: boolean }
        if (!session.operator) {
          hardNavigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)
          return
        }
        const view = (await (await fetch("/api/view-key", { cache: "no-store" })).json().catch(() => ({}))) as { key?: string; required?: boolean; fromEnv?: boolean }
        if (!cancelled) setState({ ready: true, mode: session.mode, operator: true, viewKey: view.key ?? "", viewKeyRequired: view.required === true, viewKeyFromEnv: view.fromEnv === true, origin: window.location.origin })
      } catch {
        if (!cancelled) setState((current) => ({ ...current, ready: true }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return [state, setState] as const
}

/** Sends the browser to /login when an API says the session is gone. */
export function handleUnauthorized(response: Response): boolean {
  if (response.status !== 401) return false
  hardNavigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)
  return true
}

/** Full page load on purpose: the login/logout cookie must be re-read by the server (proxy.ts). */
export function hardNavigate(path: string) {
  window.location.assign(path)
}
