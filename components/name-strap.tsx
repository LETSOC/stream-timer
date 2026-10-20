"use client"

import type { CSSProperties } from "react"
import { PlatformIcon } from "@/components/platform-icon"
import type { StrapMotion, StrapPreset, StrapStyle } from "@/lib/visuals"
import { cn } from "@/lib/utils"

export type StrapLook = { style: StrapStyle; motion: StrapMotion; accent: string; text: string }

/**
 * One name strap (lower third), designed at 1920x1080 in px × --px. `visible` drives the motion:
 * in 0.68s cubic-bezier(.16,1,.3,1), out 0.48s (CSS transitions in globals.css, .strap*).
 */
export function NameStrap({ preset, look, visible }: { preset: Pick<StrapPreset, "name" | "title" | "handle" | "platform">; look: StrapLook; visible: boolean }) {
  const vars = { "--strap-accent": look.accent, "--strap-text": look.text } as CSSProperties
  const handle = preset.handle.trim()
  const social = handle || preset.platform !== "none" ? (
    <span className="strap-social">
      <PlatformIcon platform={preset.platform} />
      {handle ? <span>{handle}</span> : null}
    </span>
  ) : null
  return (
    <div data-testid="name-strap" data-style={look.style} data-motion={look.motion} data-visible={visible ? "1" : "0"} className={cn("strap", `strap-${look.style}`, `strap-m-${look.motion}`, visible ? "strap-on" : "strap-off")} style={vars}>
      {look.style === "line" ? (
        <div className="strap-body">
          <span className="strap-bar" />
          <div className="strap-lines">
            <span className="strap-name">{preset.name}</span>
            {preset.title ? <span className="strap-title">{preset.title}</span> : null}
            {social}
          </div>
        </div>
      ) : look.style === "block" ? (
        <div className="strap-body">
          <span className="strap-name">{preset.name}</span>
          {preset.title || social ? (
            <span className="strap-title">
              {preset.title}
              {social}
            </span>
          ) : null}
        </div>
      ) : look.style === "pill" ? (
        <div className="strap-body">
          {preset.platform !== "none" ? <PlatformIcon platform={preset.platform} className="strap-pill-icon" /> : null}
          <div className="strap-lines">
            <span className="strap-name">{preset.name}</span>
            {handle || preset.title ? <span className="strap-title">{handle || preset.title}</span> : null}
          </div>
        </div>
      ) : look.style === "thick" ? (
        <div className="strap-body" style={{ background: look.accent, padding: "18px 32px 18px 28px", borderRadius: "0 20px 20px 0", minHeight: 72, borderLeft: "6px solid #FF6A00" }}>
          <span className="strap-name" style={{ fontSize: "22px", fontWeight: 700 }}>{preset.name}</span>
          {preset.title ? <span className="strap-title" style={{ opacity: 0.85, marginTop: 6 }}>{preset.title}</span> : null}
          {social}
        </div>
      ) : (
        <div className="strap-body">
          <span className="strap-name">{preset.name}</span>
          {preset.title ? <span className="strap-title">{preset.title}</span> : null}
          {social}
        </div>
      )}
    </div>
  )
}
