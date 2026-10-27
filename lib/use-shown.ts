"use client"
import { useEffect, useState, type RefObject } from "react"
import { previewFrameShown } from "@/lib/program-display"

/**
 * True while `ref`'s element is (partly) on screen and the tab is visible. Preview iframes of /stream
 * mount only then, so a hidden tab or a scrolled-away multiview stops its players (no HLS readers on
 * MediaMTX, no decode on the Mac). Starts true so a visible preview appears at once.
 */
export function useShown(ref: RefObject<Element | null>): boolean {
  const [intersecting, setIntersecting] = useState(true)
  const [docVisible, setDocVisible] = useState(true)
  useEffect(() => {
    const onVis = () => setDocVisible(document.visibilityState === "visible")
    onVis()
    document.addEventListener("visibilitychange", onVis)
    const node = ref.current
    let io: IntersectionObserver | null = null
    if (node && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => { const e = entries[entries.length - 1]; if (e) setIntersecting(e.isIntersecting) })
      io.observe(node)
    }
    return () => { document.removeEventListener("visibilitychange", onVis); io?.disconnect() }
  }, [ref])
  return previewFrameShown({ intersecting, docVisible })
}
