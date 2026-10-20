"use client"

import type { CSSProperties } from "react"

export type HolderVersion = "tech" | "soon" | "break" | "qa"

export type HolderProps = {
  version?: HolderVersion
  label?: string
  title?: string
  message?: string
  footer?: string
  /** "safe" lands the content column inside the 5% safe zone; "edge" pins outer edges to canvas. */
  position?: "safe" | "edge"
  /** Thicker plate for broadcast readability (higher contrast, larger type). */
  thick?: boolean
  className?: string
}

const COPY: Record<HolderVersion, { label: string; title: string; message: string; footer: string }> = {
  tech: { label: "Back shortly", title: "We'll be right back", message: "The stream will continue in a moment.", footer: "@onlinehyphen #HyphenFestival2026" },
  soon: { label: "Starting soon", title: "The festival begins shortly", message: "Settle in. We go live at 09:30 London time.", footer: "Hyphen Festival 2026 · Wed 4 Nov" },
  break: { label: "Short break", title: "Back in a few minutes", message: "Stretch your legs. We'll return with the next session shortly.", footer: "Up next · Session" },
  qa: { label: "Q&A", title: "Scan to ask", message: "Submit your question. We'll take the best ones live.", footer: "hyphen.link/qa" },
}

/**
 * Full-frame standby / holder card matching the Hyphen Festival build spec.
 * Designed at 1920×1080; scales with container query units. Key content stays
 * inside the 608px safe column so a 9:16 centre crop remains readable.
 */
export function HolderCard({ version = "tech", label, title, message, footer, position = "safe", thick = false, className }: HolderProps) {
  const c = COPY[version]
  const L = label ?? c.label
  const T = title ?? c.title
  const M = message ?? c.message
  const F = footer ?? c.footer
  const thickClass = thick ? "holder-thick" : ""
  const posClass = position === "edge" ? "holder-edge" : "holder-safe"
  return (
    <div
      data-testid={`holder-${version}`}
      data-position={position}
      data-thick={thick ? "1" : "0"}
      className={`holder-card countdown-stage stage-bg relative isolate aspect-video w-full overflow-hidden text-center text-white ${thickClass} ${posClass} ${className ?? ""}`}
      style={{ "--holder-accent": "#FF3C00" } as CSSProperties}
    >
      <div className="pointer-events-none absolute inset-0 opacity-20" style={{ backgroundImage: "repeating-linear-gradient(125deg, transparent 0 2px, rgba(255,255,255,0.08) 2px 4px)" }} />
      <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ padding: position === "edge" ? "0" : "var(--safe)" }}>
        <div className="holder-col flex flex-col items-center" style={{ width: "calc(520 * var(--px))" }}>
          <div className="mb-[2cqi] shrink-0 rounded-full border border-white/35 px-[1.4cqi] py-[0.45cqi] font-[Arial,Helvetica,sans-serif] text-[0.95cqi] font-bold tracking-[0.2em] uppercase">
            <span className="mr-[0.6cqi] inline-block size-[0.5cqi] rounded-full bg-[var(--holder-accent)] align-middle" style={{ animation: "holderBeat 2.6s ease-in-out infinite alternate" }} />
            {L}
          </div>
          <h1 className="m-0 max-w-full font-[Arial,Helvetica,sans-serif] text-[3.3cqi] leading-[1.08] font-bold tracking-[-0.02em] break-words" style={{ textWrap: "balance" }}>{T}</h1>
          <p className="mt-[1.25cqi] max-w-full font-[Arial,Helvetica,sans-serif] text-[1.35cqi] leading-[1.4] break-words whitespace-pre-line text-white/82" style={{ textWrap: "balance" }}>{M}</p>
          {F ? (
            <div className="mt-[2.9cqi] w-full border-t border-white/20 pt-[1.25cqi] font-[Arial,Helvetica,sans-serif] text-[1cqi] leading-[1.3]">
              <div className="font-bold text-white/92">{F}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
