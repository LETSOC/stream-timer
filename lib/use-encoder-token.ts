"use client"

import { useEffect, useState } from "react"

export function useEncoderToken(): string {
  const [token, setToken] = useState("")

  useEffect(() => {
    let cancelled = false
    void fetch("/api/event", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { token?: string }) => {
        if (!cancelled && body.token) setToken(body.token)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  return token
}
