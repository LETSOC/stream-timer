"use client"
import { useEffect, useRef, useState } from "react"

/**
 * Counter that goes up whenever the page comes back after being away: visibilitychange → visible,
 * pageshow (incl. iOS back/forward cache), or focus after a blur. iOS Safari suspends media and
 * sockets in the background and doesn't always resume them; key players/iframes on this to rebuild.
 * `minAwayMs`: ignore blips shorter than this (a quick notification pull-down).
 */
export function useResumeGeneration(minAwayMs = 1000, onResume?: () => void): number {
  const [gen, setGen] = useState(0)
  const cb = useRef(onResume)
  useEffect(() => {
    cb.current = onResume
  })
  useEffect(() => {
    let awaySince: number | null = document.visibilityState === "visible" ? null : Date.now()
    const away = () => { awaySince ??= Date.now() }
    const back = (force = false) => {
      if (document.visibilityState !== "visible") return
      const was = awaySince
      awaySince = null
      if (force || (was !== null && Date.now() - was >= minAwayMs)) { cb.current?.(); setGen((g) => g + 1) }
    }
    const onVis = () => (document.visibilityState === "visible" ? back() : away())
    const onShow = (e: PageTransitionEvent) => back(e.persisted)
    const onFocus = () => back()
    document.addEventListener("visibilitychange", onVis)
    window.addEventListener("pagehide", away)
    window.addEventListener("blur", away)
    window.addEventListener("pageshow", onShow)
    window.addEventListener("focus", onFocus)
    return () => {
      document.removeEventListener("visibilitychange", onVis)
      window.removeEventListener("pagehide", away)
      window.removeEventListener("blur", away)
      window.removeEventListener("pageshow", onShow)
      window.removeEventListener("focus", onFocus)
    }
  }, [minAwayMs])
  return gen
}

/** Pure: watchdog backoff for reloading a stalled player: 3s, 6s, 12s … max 30s. */
export function stallBackoffMs(attempt: number): number {
  return Math.min(30_000, 3000 * 2 ** Math.max(0, attempt))
}
