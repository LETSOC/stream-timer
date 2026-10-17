"use client"

import { useEffect, useRef, type CSSProperties } from "react"
import { frameTimecode, type TcFps } from "@/lib/av-diagnostics"

/** Width of a badge @1080p, so the OBS SRC and STREAM badges can sit side by side without overlapping. */
export const TC_BADGE_W = 380
export const TC_GAP = 24

/**
 * Labelled HH:MM:SS:FF of local wall-clock time, redrawn every animation frame (text node only, no
 * React render per frame). Sized in --px (1px @1080p) so it scales with the 1920x1080 page.
 */
export function TimecodeBadge({ label, fps, style, testId }: { label: string; fps: TcFps; style?: CSSProperties; testId?: string }) {
  const text = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const now = Date.now()
      if (text.current) text.current.textContent = frameTimecode(now, fps, -new Date(now).getTimezoneOffset())
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [fps])
  return (
    <div data-testid={testId} data-fps={fps} style={{ position: "absolute", width: `calc(${TC_BADGE_W} * var(--px))`, boxSizing: "border-box", padding: "calc(10 * var(--px)) calc(16 * var(--px))", borderRadius: "calc(10 * var(--px))", background: "rgba(0,0,0,0.82)", border: "calc(2 * var(--px)) solid rgba(255,255,255,0.9)", color: "#fff", fontFamily: "ui-monospace, Menlo, Consolas, monospace", lineHeight: 1.05, zIndex: 60, pointerEvents: "none", ...style }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(18 * var(--px))", fontWeight: 700, letterSpacing: "0.12em" }}>
        <span>{label}</span>
        <span style={{ opacity: 0.7 }}>{fps}fps</span>
      </div>
      <span ref={text} style={{ display: "block", fontSize: "calc(46 * var(--px))", fontWeight: 700, fontVariantNumeric: "tabular-nums", marginTop: "calc(4 * var(--px))" }}>--:--:--:--</span>
    </div>
  )
}
