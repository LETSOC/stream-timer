"use client"
import { useEffect, useState, type RefObject } from "react"
import { playWhep, type WhepSession } from "@/lib/whep-client"

/**
 * WebRTC (WHEP) into its own <video> while `enabled`. `failed` sticks until the path changes, so a
 * refused/timed-out/dropped WebRTC falls back to HLS for the rest of the session (no flip-flop).
 */
export function useWhep(ref: RefObject<HTMLVideoElement | null>, path: string | null, enabled: boolean) {
  const [failed, setFailed] = useState(false)
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null)
  const [seen, setSeen] = useState(path)
  if (seen !== path) { setSeen(path); setFailed(false); setLastFrameAt(null) }
  // Hidden page (other app, standby, other tab): close the session; open a fresh one on return.
  // Not a failure, so it doesn't push the preview onto HLS for the rest of the session.
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible")
  useEffect(() => {
    const update = (e: Event) => setVisible(e.type !== "pagehide" && document.visibilityState === "visible")
    document.addEventListener("visibilitychange", update)
    window.addEventListener("pagehide", update)
    window.addEventListener("pageshow", update)
    return () => { document.removeEventListener("visibilitychange", update); window.removeEventListener("pagehide", update); window.removeEventListener("pageshow", update) }
  }, [])
  const on = enabled && path !== null && !failed && visible
  useEffect(() => {
    const video = ref.current
    if (!on || !video || !path) return
    let cancelled = false
    let session: WhepSession | null = null
    playWhep(video, path, { timeoutMs: 3000, onFail: () => { if (!cancelled) setFailed(true) } })
      .then((s) => { if (cancelled) s.stop(); else session = s })
      .catch(() => { if (!cancelled) setFailed(true) })
    let last = -1
    const id = window.setInterval(() => {
      const t = video.currentTime
      if (video.readyState >= 2 && t !== last && t > 0) setLastFrameAt(Date.now())
      last = t
    }, 150)
    return () => { cancelled = true; window.clearInterval(id); session?.stop(); if (video.srcObject) video.srcObject = null }
  }, [ref, path, on])
  return { failed, lastFrameAt: on ? lastFrameAt : null }
}
