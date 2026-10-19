"use client"

/* eslint-disable @next/next/no-img-element -- OBS output: plain <img> so uploads and data: URLs render without the optimiser */
import type { ImageFit } from "@/lib/stage"

export type OverlayCardProps = {
  kind: "break" | "hold" | "welcome" | "standby"
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
  const contain = Boolean(image) && fit === "contain"
  // Every image sits in an absolutely positioned, overflow-hidden box sized from the stage frame,
  // and the <img> fills that box (100% x 100% + object-fit). Its intrinsic size never affects layout,
  // so huge or odd-aspect remote images (and images that haven't loaded yet) can't push past the frame.
  return (
    <div
      data-testid={`overlay-${kind}`}
      className={`countdown-stage stage-bg relative isolate aspect-video w-full overflow-hidden text-center text-white ${className ?? ""}`}
    >
      {cover ? (
        <div data-testid="overlay-image-box" className="absolute inset-0 overflow-hidden">
          <img src={image} alt="" draggable={false} className="block h-full w-full max-w-none object-cover" />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/45 to-black/20" />
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 opacity-20" style={{ backgroundImage: "repeating-linear-gradient(125deg, transparent 0 2px, rgba(255,255,255,0.08) 2px 4px)" }} />
      )}
      {contain ? (
        <div data-testid="overlay-image-box" className="absolute top-[7%] right-[20%] left-[20%] h-[42%] overflow-hidden">
          <img src={image} alt="" draggable={false} className="block h-full w-full max-w-none object-contain" />
        </div>
      ) : null}
      <div className={`absolute flex flex-col items-center overflow-hidden ${contain ? "top-[52%] justify-start" : "justify-center"}`} style={{ left: "var(--inset)", right: "var(--inset)", bottom: "var(--safe)", ...(contain ? {} : { top: "var(--inset)" }) }}>
        <div className="mb-[2cqi] shrink-0 rounded-full border border-white/30 px-[1.4cqi] py-[0.4cqi] font-[Arial,Helvetica,sans-serif] text-[0.9cqi] tracking-[0.18em] uppercase">
          {kind === "break" ? "Short break" : kind === "welcome" ? "We’re back" : kind === "standby" ? "Back shortly" : "Stand by"}
        </div>
        <h1 className={`m-0 max-w-full font-[Arial,Helvetica,sans-serif] ${contain ? "text-[4cqi]" : "text-[5cqi]"} leading-none font-bold break-words`}>{title}</h1>
        {message ? <p className="mt-[1.6cqi] max-w-[56cqi] font-[Arial,Helvetica,sans-serif] text-[1.6cqi] leading-snug break-words whitespace-pre-line text-white/85">{message}</p> : null}
        {kind === "break" && since && clock ? (
          <p data-testid="break-elapsed" className="mt-[2cqi] font-mono text-[1.2cqi] tracking-[0.14em] text-white/75 uppercase tabular-nums">
            On break · {elapsed(since, clock.getTime())}
          </p>
        ) : null}
      </div>
    </div>
  )
}
