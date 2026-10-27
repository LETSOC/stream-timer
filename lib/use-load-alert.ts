"use client"
import { useCallback, useEffect, useState } from "react"
import { previewsPaused } from "@/lib/load-alert"

type Alert = { on: boolean; since: number | null; reason: string }
const KEY = "load-alert-show-anyway"
const listeners = new Set<() => void>()

/**
 * Mac load alert for the desk (polls /api/load-alert every 5s while the tab is visible). `paused` = hide
 * previews and multiview players now; `showAnyway()` keeps them up for this alert (until it clears).
 */
export function useLoadAlert(): { alert: Alert | null; paused: boolean; showAnyway: () => void } {
  const [alert, setAlert] = useState<Alert | null>(null)
  const [anyway, setAnyway] = useState<number | null>(null)
  useEffect(() => {
    const read = () => { const v = Number(sessionStorage.getItem(KEY)); setAnyway(Number.isFinite(v) && v > 0 ? v : null) }
    read()
    listeners.add(read)
    let stop = false
    const poll = async () => {
      if (document.visibilityState !== "visible") return
      const body = (await (await fetch("/api/load-alert", { cache: "no-store" }).catch(() => null))?.json().catch(() => null)) as Alert | null
      if (!stop && body && typeof body.on === "boolean") setAlert(body)
    }
    void poll()
    const t = setInterval(() => void poll(), 5000)
    return () => { stop = true; clearInterval(t); listeners.delete(read) }
  }, [])
  const showAnyway = useCallback(() => {
    if (!alert?.since) return
    sessionStorage.setItem(KEY, String(alert.since))
    for (const l of listeners) l()
  }, [alert])
  return { alert, paused: previewsPaused(alert, anyway), showAnyway }
}
