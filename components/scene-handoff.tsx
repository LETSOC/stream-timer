"use client"

import { useEffect, useState } from "react"
import { SceneCardView } from "@/components/visual-assets"
import { HANDOFF_MAX_MS, handoffReady, handoffShow, handoffStart, type HandoffState } from "@/lib/scene-handoff"
import type { QrConfig, SceneCard } from "@/lib/visuals-assets"

/**
 * /stream scene output with a seamless scene-to-scene switch: the outgoing scene (its video holding
 * the last frame) stays on top until the incoming scene's video has painted its first frame.
 */
export function SceneHandoff({ id, scenes, qr, now, className, onReady }: { id: string; scenes: Record<string, SceneCard>; qr?: QrConfig; now: number | null; className: string; /** the current scene painted its first frame (or has no video): /stream drops the program cover */ onReady?: (id: string) => void }) {
  const [s, setS] = useState<HandoffState>(() => handoffStart(id))
  if (s.current !== id) setS(handoffShow(s, id))
  const cur = s.current !== id ? id : s.current
  const leaving = s.current !== id ? s.leaving ?? s.current : s.leaving
  useEffect(() => {
    if (leaving === null) return
    const t = setTimeout(() => setS((p) => (p.leaving === null ? p : { current: p.current, leaving: null })), HANDOFF_MAX_MS)
    return () => clearTimeout(t)
  }, [leaving, cur])
  return (
    <div data-testid="scene-handoff" data-leaving={leaving ?? ""} className={`relative ${className}`}>
      {/* Keyed siblings under one parent: the outgoing scene keeps its own video element (no remount,
          no restart) while it covers; dropping the cover just unmounts it. Each scene sits in its own
          absolutely placed wrapper: a position class on SceneCardView itself loses to its built-in
          "relative", which pushed the cover below the frame (the incoming card's text and background
          then showed until its video painted). */}
      {[cur, ...(leaving !== null && leaving !== cur && scenes[leaving] ? [leaving] : [])].map((sid) => (
        <div key={sid} data-testid={sid === cur ? `scene-in-${sid}` : `scene-cover-${sid}`} className="absolute inset-0" style={{ zIndex: sid === cur ? 0 : 20 }}>
          <SceneCardView id={sid} card={scenes[sid]} qr={qr} now={now} onAir onReady={sid === cur ? () => { setS((p) => handoffReady(p, sid)); onReady?.(sid) } : undefined} className="h-full w-full" />
        </div>
      ))}
    </div>
  )
}
