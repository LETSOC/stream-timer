"use client"

import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { TimecodeBadge } from "@/components/timecode-badge"
import { beepTimes, ctxTimeFor, parseBeepEvery, parseFps, parseTcSrc, parseVol, TC_BEEP, TC_VARIANT, tcLabel, type TcSrc } from "@/lib/av-diagnostics"
import { parseCorner } from "@/lib/visuals"

const LOOKAHEAD_MS = 400
const TICK_MS = 50

/**
 * Lookahead scheduler: every 50ms, schedule the beeps of the next 400ms on the AudioContext clock,
 * mapped from Date.now() through an anchor sampled each tick. Timer jitter only moves *when* we
 * schedule, never *where* the beep lands. Returns "blocked" until the browser allows audio.
 */
function useTimecodeBeep(enabled: boolean, everyS: number, vol: number, pitch: { hz: number; minuteHz: number }): "off" | "blocked" | "on" {
  const [state, setState] = useState<"off" | "blocked" | "on">(enabled ? "blocked" : "off")
  useEffect(() => {
    if (!enabled) return
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx({ latencyHint: "interactive" })
    const gain = ctx.createGain()
    gain.gain.value = vol
    gain.connect(ctx.destination)
    let until = Date.now()
    const tick = () => {
      if (ctx.state !== "running") { setState("blocked"); until = Date.now(); return }
      setState("on")
      const wall = Date.now()
      const anchor = { wallMs: wall, ctxTime: ctx.currentTime }
      const out = (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0
      const tz = -new Date(wall).getTimezoneOffset()
      for (const b of beepTimes(Math.max(until, wall), wall + LOOKAHEAD_MS, everyS, tz)) {
        const t = ctxTimeFor(b.at, anchor, out)
        if (t < ctx.currentTime) continue
        const osc = ctx.createOscillator()
        const env = ctx.createGain()
        osc.frequency.value = b.minute ? pitch.minuteHz : pitch.hz
        const d = TC_BEEP.ms / 1000
        // 2ms ramps: no click, onset stays on the second
        env.gain.setValueAtTime(0, t)
        env.gain.linearRampToValueAtTime(1, t + 0.002)
        env.gain.setValueAtTime(1, t + d - 0.002)
        env.gain.linearRampToValueAtTime(0, t + d)
        osc.connect(env).connect(gain)
        osc.start(t)
        osc.stop(t + d + 0.01)
      }
      until = wall + LOOKAHEAD_MS
    }
    const resume = () => void ctx.resume().then(tick)
    void ctx.resume().catch(() => undefined)
    const id = window.setInterval(tick, TICK_MS)
    window.addEventListener("pointerdown", resume)
    window.addEventListener("keydown", resume)
    return () => {
      window.clearInterval(id)
      window.removeEventListener("pointerdown", resume)
      window.removeEventListener("keydown", resume)
      void ctx.close()
    }
  }, [enabled, everyS, vol, pitch.hz, pitch.minuteHz])
  return enabled ? state : "off"
}

function Inner({ forceSrc }: { forceSrc?: TcSrc }) {
  const params = useSearchParams()
  const src = forceSrc ?? parseTcSrc(params.get("src"))
  const variant = TC_VARIANT[src]
  const fps = parseFps(params.get("fps"))
  const pos = parseCorner(params.get("pos"), variant.pos)
  const beep = params.get("beep") === "1"
  const everyS = parseBeepEvery(params.get("beepEvery"))
  const audio = useTimecodeBeep(beep, everyS, parseVol(params.get("vol")), variant)
  useEffect(() => {
    for (const el of [document.documentElement, document.body]) el.style.setProperty("background", "transparent", "important")
  }, [])
  const at = (n: number) => `calc(${n} * var(--px))`
  const style = { [pos.endsWith("right") ? "right" : "left"]: at(96), [pos.startsWith("top") ? "top" : "bottom"]: at(96) }
  return (
    <div className={params.get("checker") === "1" ? "overlay-stage overlay-checker" : "overlay-stage"} data-audio={audio}>
      <TimecodeBadge label={tcLabel(params.get("label"), src)} border={variant.border} fps={fps} style={style} testId={src === "backup" ? "tc-backup-src" : "tc-obs-src"} flashEveryS={beep ? everyS : undefined} />
      {audio === "blocked" ? (
        <p data-testid="tc-audio-hint" className="absolute top-[3cqi] left-1/2 -translate-x-1/2 rounded-lg bg-black/80 px-[1.2cqi] py-[0.6cqi] font-mono text-[1.1cqi] text-white">Click to enable audio (beep)</p>
      ) : null}
    </div>
  )
}

export function TimecodeOverlay({ src }: { src?: TcSrc } = {}) {
  return <Suspense fallback={null}><Inner forceSrc={src} /></Suspense>
}
