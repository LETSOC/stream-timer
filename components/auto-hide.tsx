"use client"
import { useCallback, useEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react"

/**
 * Shared preview-player chrome behaviour: controls show on hover / pointer movement / keyboard focus
 * and fade after `idleMs` (2s); on touch a tap toggles them and they hide again after `touchMs` (3s).
 * Spread `bind` on the player box; use `shown` for action controls and `idle` to fade status badges.
 */
export function useAutoHide(idleMs = 2000, touchMs = 3000) {
  const [shown, setShown] = useState(false)
  const timer = useRef<number | null>(null)
  const focused = useRef(false)
  const arm = useCallback((ms: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { if (!focused.current) setShown(false) }, ms)
  }, [])
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  const bind = {
    "data-controls": shown ? "shown" : "idle",
    onPointerMove: (e: PointerEvent) => { if (e.pointerType !== "touch") { setShown(true); arm(idleMs) } },
    onPointerLeave: (e: PointerEvent) => { if (e.pointerType !== "touch") arm(300) },
    // Touch: a tap on the picture toggles (taps on visible controls don't reach here as a toggle).
    onPointerDownCapture: (e: PointerEvent) => {
      if (e.pointerType !== "touch") return
      const onControl = (e.target as HTMLElement).closest("[data-autohide-control]")
      if (shown && onControl) { arm(touchMs); return }
      setShown((s) => { const next = !s; if (next) arm(touchMs); return next })
    },
    onFocusCapture: () => { focused.current = true; setShown(true) },
    onBlurCapture: (e: FocusEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { focused.current = false; arm(idleMs) } },
  }
  return { shown, idle: !shown, bind }
}

/** Classes for action controls: hidden (and untappable) while idle, but still reachable by Tab (focus shows them). */
export const controlsClass = (shown: boolean) => `transition-opacity duration-300 ${shown ? "opacity-100" : "pointer-events-none opacity-0 focus-within:opacity-100"}`
