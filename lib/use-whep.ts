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
  const on = enabled && path !== null && !failed
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
    return () => { cancelled = true; window.clearInterval(id); session?.stop() }
  }, [ref, path, on])
  return { failed, lastFrameAt: on ? lastFrameAt : null }
}
