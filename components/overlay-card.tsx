"use client"

/* eslint-disable @next/next/no-img-element -- OBS output: plain <img> so uploads and data: URLs render without the optimiser */
import type { ImageFit } from "@/lib/stage"

export type OverlayCardProps = {
  kind: "break" | "hold"
  title: string
  message?: string
  image?: string
  fit?: ImageFit
  /** When the card went up (ms); the break card shows how long it has been up. */
  since?: number | null
  clock?: Date | null
  className?: string
}

function elapsed(since: number, now: number) {
  const total = Math.max(0, Math.floor((now - since) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

/** Full-frame 16:9 break / hold card, same type and background as the end card. */
export function OverlayCard({ kind, title, message, image, fit = "cover", since, clock, className }: OverlayCardProps) {
  const cover = Boolean(image) && fit === "cover"
  return (
    <div
      data-testid={`overlay-${kind}`}
      className={`countdown-stage relative flex aspect-video w-full flex-col items-center justify-center overflow-hidden bg-[#070a16] bg-cover bg-center px-[8%] text-center text-white ${className ?? ""}`}
      style={{ backgroundImage: cover ? undefined : "url('/brand/hero-bg.png')" }}
    >
      {cover ? (
        <>
          <img src={image} alt="" className="absolute inset-0 size-full object-cover" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/45 to-black/20" />
        </>
      ) : (
        <div className="pointer-events-none absolute inset-0 opacity-20" style={{ backgroundImage: "repeating-linear-gradient(125deg, transparent 0 2px, rgba(255,255,255,0.08) 2px 4px)" }} />
      )}
      <div className="relative mb-[2cqi] rounded-full border border-white/30 px-[1.4cqi] py-[0.4cqi] font-[Arial,Helvetica,sans-serif] text-[0.9cqi] tracking-[0.18em] uppercase">
        {kind === "break" ? "Short break" : "Stand by"}
      </div>
      {image && !cover ? <img src={image} alt="" className="relative mb-[2cqi] max-h-[30cqi] max-w-[60cqi] object-contain" /> : null}
      <h1 className="relative m-0 font-[Arial,Helvetica,sans-serif] text-[5cqi] leading-none font-bold">{title}</h1>
      {message ? <p className="relative mt-[1.6cqi] max-w-[56cqi] font-[Arial,Helvetica,sans-serif] text-[1.6cqi] leading-snug whitespace-pre-line text-white/85">{message}</p> : null}
      {kind === "break" && since && clock ? (
        <p data-testid="break-elapsed" className="relative mt-[2cqi] font-mono text-[1.2cqi] tracking-[0.14em] text-white/75 uppercase tabular-nums">
          On break · {elapsed(since, clock.getTime())}
        </p>
      ) : null}
    </div>
  )
}
