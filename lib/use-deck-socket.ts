"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { DeckState, TransportAction } from "@/lib/transport"
import { handleUnauthorized, hardNavigate } from "@/lib/use-operator"
import { fetchT } from "@/lib/fetch-timeout"
import { usePoll } from "@/lib/use-poll"

export type DeckLink = "connecting" | "live" | "polling" | "offline"
export type DeckResult = { ok: boolean; status: number; error?: string; state?: DeckState; via: "ws" | "http" }

/** Reconnect delays: 0.5s, 1s, 2s … capped at 10s, with jitter so many phones don't sync up. */
export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.8 + 0.4 * random))
}

/** Heartbeat: every HEARTBEAT_MS the client says "hello"; no message back within HEARTBEAT_REPLY_MS = dead link. */
export const HEARTBEAT_MS = 10_000
export const HEARTBEAT_REPLY_MS = 5_000
/** How long an action over the socket waits for its result before the link is treated as dead. */
export const ACTION_REPLY_MS = 5_000

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
  // Drops the current socket (half-open: open on this side, dead on the other) and reconnects.
  const dropRef = useRef<(reason: string) => void>(() => undefined)
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
    let beat: number | null = null
    let beatReply: number | null = null
    const stopBeat = () => {
      if (beat !== null) window.clearInterval(beat)
      if (beatReply !== null) window.clearTimeout(beatReply)
      beat = null
      beatReply = null
    }
    const failPending = (error: string) => {
      for (const resolve of pending.current.values()) resolve({ ok: false, status: 0, error, via: "ws" })
      pending.current.clear()
    }
    const drop = (reason: string) => {
      const old = wsRef.current
      if (!old || stopped) return
      wsRef.current = null
      stopBeat()
      old.onclose = null
      old.onmessage = null
      try { old.close() } catch { /* already closing */ }
      failPending(reason)
      setLink(poll ? "polling" : "offline")
      if (retry !== null) window.clearTimeout(retry)
      retry = window.setTimeout(connect, backoffMs(attempt++))
    }
    dropRef.current = drop
    const connect = () => {
      if (stopped) return
      retry = null
      const ws = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/deck/ws`)
      wsRef.current = ws
      ws.onopen = () => {
        attempt = 0
        setLink("live")
        stopBeat()
        // The server answers "hello" with the current state. Any message counts as the reply.
        beat = window.setInterval(() => {
          if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN || document.visibilityState === "hidden" || beatReply !== null) return
          try { ws.send(JSON.stringify({ type: "hello" })) } catch { return drop("Connection dropped; check the state.") }
          beatReply = window.setTimeout(() => {
            beatReply = null
            if (wsRef.current === ws) drop("Connection dropped; check the state.")
          }, HEARTBEAT_REPLY_MS)
        }, HEARTBEAT_MS)
      }
      ws.onmessage = (event) => {
        if (beatReply !== null) { window.clearTimeout(beatReply); beatReply = null }
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
        if (wsRef.current !== ws) return
        wsRef.current = null
        stopBeat()
        failPending("Connection dropped; check the state.")
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
    // iOS often keeps a dead socket object after the background: if we were away a while, drop it and
    // reconnect (the server sends fresh state on connect).
    let hiddenAt: number | null = null
    const wake = () => {
      if (document.visibilityState !== "visible") { hiddenAt ??= Date.now(); return }
      const away = hiddenAt !== null && Date.now() - hiddenAt > 3000
      hiddenAt = null
      if (wsRef.current && away) { const old = wsRef.current; wsRef.current = null; stopBeat(); old.onclose = null; old.onmessage = null; old.close(); failPending("Reconnected; check the state.") }
      if (wsRef.current) return
      if (retry !== null) window.clearTimeout(retry)
      retry = null
      attempt = 0
      connect()
    }
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("online", wake)
    window.addEventListener("pageshow", wake)
    return () => {
      window.removeEventListener("pageshow", wake)
      stopped = true
      stopBeat()
      dropRef.current = () => undefined
      if (retry !== null) window.clearTimeout(retry)
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("online", wake)
      wsRef.current?.close()
    }
  }, [accept, poll])

  // Fallback poll while the socket is down (and once at start, so the page fills in fast).
  // One request at a time, with a deadline, paused while hidden (lib/poll).
  usePoll(async () => {
    const response = await fetchT("/api/deck/state", { cache: "no-store" }).catch(() => null)
    if (!response) {
      setLink((current) => (current === "live" ? current : "offline"))
      return false
    }
    if (handleUnauthorized(response)) return false
    if (!response.ok) return false
    setLink((current) => (current === "live" ? current : "polling"))
    accept((await response.json().catch(() => null)) ?? undefined)
  }, 2000, poll && link !== "live")

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
          // No reply on an open socket = half-open link: drop it and reconnect now (next tap goes over HTTP meanwhile).
          if (wsRef.current === ws) dropRef.current("Connection dropped; check the state.")
        }, ACTION_REPLY_MS)
      })
    }
    const response = await fetchT("/api/deck/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, rev }) }).catch(() => null)
    if (!response) return { ok: false, status: 0, error: "Could not reach the server.", via: "http" }
    if (handleUnauthorized(response)) return { ok: false, status: 401, via: "http" }
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; state?: DeckState } | null
    accept(body?.state)
    return { ok: response.ok && body?.ok === true, status: response.status, error: body?.error, state: body?.state, via: "http" }
  }, [accept])

  return { link, state, run }
}
