"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { DeckState, TransportAction } from "@/lib/transport"
import { handleUnauthorized, hardNavigate } from "@/lib/use-operator"

export type DeckLink = "connecting" | "live" | "polling" | "offline"
export type DeckResult = { ok: boolean; status: number; error?: string; state?: DeckState; via: "ws" | "http" }

/** Reconnect delays: 0.5s, 1s, 2s … capped at 10s, with jitter so many phones don't sync up. */
export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.8 + 0.4 * random))
}

/**
 * Live transport state over the deck WebSocket (same port as the app), with HTTP fallback:
 * while the socket is down it polls /api/deck/state (if `poll`) and actions go over POST.
 */
export function useDeckSocket({ poll = true, onState }: { poll?: boolean; onState?: (state: DeckState) => void } = {}) {
  const [link, setLink] = useState<DeckLink>("connecting")
  const [state, setState] = useState<DeckState | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pending = useRef(new Map<number, (result: DeckResult) => void>())
  const seq = useRef(0)
  const onStateRef = useRef(onState)
  useEffect(() => {
    onStateRef.current = onState
  })
  const accept = useCallback((next: DeckState | undefined) => {
    if (!next) return
    setState((current) => (current && current.rev > next.rev ? current : next))
    onStateRef.current?.(next)
  }, [])

  useEffect(() => {
    let stopped = false
    let attempt = 0
    let retry: number | null = null
    const connect = () => {
      if (stopped) return
      const ws = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/deck/ws`)
      wsRef.current = ws
      ws.onopen = () => {
        attempt = 0
        setLink("live")
      }
      ws.onmessage = (event) => {
        let message: { type?: string; id?: number; state?: DeckState; ok?: boolean; status?: number; error?: string }
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (message.type === "state") accept(message.state)
        if (message.type === "result" && typeof message.id === "number") {
          accept(message.state)
          pending.current.get(message.id)?.({ ok: message.ok === true, status: message.status ?? 0, error: message.error, state: message.state, via: "ws" })
          pending.current.delete(message.id)
        }
      }
      ws.onclose = (event) => {
        if (wsRef.current === ws) wsRef.current = null
        for (const resolve of pending.current.values()) resolve({ ok: false, status: 0, error: "Connection dropped; check the state.", via: "ws" })
        pending.current.clear()
        if (stopped) return
        if (event.code === 4401) {
          hardNavigate(`/login?next=${encodeURIComponent(window.location.pathname)}`)
          return
        }
        setLink(poll ? "polling" : "offline")
        retry = window.setTimeout(connect, backoffMs(attempt++))
      }
    }
    connect()
    // Phones sleep: reconnect straight away when the page comes back.
    const wake = () => {
      if (document.visibilityState !== "visible" || wsRef.current) return
      if (retry !== null) window.clearTimeout(retry)
      attempt = 0
      connect()
    }
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("online", wake)
    return () => {
      stopped = true
      if (retry !== null) window.clearTimeout(retry)
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("online", wake)
      wsRef.current?.close()
    }
  }, [accept, poll])

  // Fallback poll while the socket is down (and once at start, so the page fills in fast).
  useEffect(() => {
    if (!poll || link === "live") return
    let cancelled = false
    const load = async () => {
      const response = await fetch("/api/deck/state", { cache: "no-store" }).catch(() => null)
      if (cancelled) return
      if (!response) return setLink((current) => (current === "live" ? current : "offline"))
      if (handleUnauthorized(response)) return
      if (!response.ok) return
      setLink((current) => (current === "live" ? current : "polling"))
      accept((await response.json().catch(() => null)) ?? undefined)
    }
    void load()
    const id = window.setInterval(() => void load(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [poll, link, accept])

  const run = useCallback(async (action: TransportAction, rev: number | undefined): Promise<DeckResult> => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      const id = ++seq.current
      return new Promise((resolve) => {
        pending.current.set(id, resolve)
        ws.send(JSON.stringify({ type: "action", id, action, rev }))
        window.setTimeout(() => {
          if (!pending.current.has(id)) return
          pending.current.delete(id)
          resolve({ ok: false, status: 0, error: "No reply; check the state.", via: "ws" })
        }, 5000)
      })
    }
    const response = await fetch("/api/deck/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, rev }) }).catch(() => null)
    if (!response) return { ok: false, status: 0, error: "Could not reach the server.", via: "http" }
    if (handleUnauthorized(response)) return { ok: false, status: 401, via: "http" }
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; state?: DeckState } | null
    accept(body?.state)
    return { ok: response.ok && body?.ok === true, status: response.status, error: body?.error, state: body?.state, via: "http" }
  }, [accept])

  return { link, state, run }
}
