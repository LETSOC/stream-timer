"use client"

import { Suspense, useEffect } from "react"
import { useSearchParams } from "next/navigation"
import { TimecodeBadge } from "@/components/timecode-badge"
import { parseFps } from "@/lib/av-diagnostics"
import { parseCorner } from "@/lib/visuals"

function Inner() {
  const params = useSearchParams()
  const fps = parseFps(params.get("fps"))
  const pos = parseCorner(params.get("pos"), "bottom-right")
  useEffect(() => {
    for (const el of [document.documentElement, document.body]) el.style.setProperty("background", "transparent", "important")
  }, [])
  const at = (n: number) => `calc(${n} * var(--px))`
  const style = { [pos.endsWith("right") ? "right" : "left"]: at(96), [pos.startsWith("top") ? "top" : "bottom"]: at(96) }
  return (
    <div className={params.get("checker") === "1" ? "overlay-stage overlay-checker" : "overlay-stage"}>
      <TimecodeBadge label="OBS SRC" fps={fps} style={style} testId="tc-obs-src" />
    </div>
  )
}

export function TimecodeOverlay() {
  return <Suspense fallback={null}><Inner /></Suspense>
}
