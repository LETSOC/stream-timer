"use client"

/** ?guides=1 debug overlay: safe (32px) and inset (96px) lines + the 178px QR box, at 1080p scale. */
export function StageGuides({ className }: { className?: string }) {
  const line = "absolute border-dashed"
  return (
    <div data-testid="stage-guides" aria-hidden className={`countdown-stage pointer-events-none absolute z-[100] ${className ?? ""}`}>
      <div className="absolute inset-0">
        <div className={`${line} border-[#00ffd0]`} style={{ inset: "var(--safe)", borderWidth: 1 }} />
        <div className={`${line} border-[#ff00c8]`} style={{ left: "var(--inset)", top: 0, bottom: 0, borderLeftWidth: 1 }} />
        <div className={`${line} border-[#ff00c8]`} style={{ top: "var(--inset)", left: 0, right: 0, borderTopWidth: 1 }} />
        <div className="absolute border border-[#ffe600]" style={{ top: "var(--safe)", right: "var(--safe)", width: "var(--qr)", height: "var(--qr)" }} />
        <div className="absolute font-mono text-[0.7cqi] text-[#00ffd0]" style={{ left: "calc(var(--safe) + 4px)", bottom: "calc(var(--safe) + 4px)" }}>safe 32 · inset 96 · qr 178 (px @1080p)</div>
      </div>
    </div>
  )
}
