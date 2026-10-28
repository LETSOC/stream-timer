"use client"

import type { CSSProperties } from "react"
import { PlatformIcon } from "@/components/platform-icon"
import { DEFAULT_STRAP_DESIGN, strapAccentOn, strapColors, type StrapDesign, type StrapMotion, type StrapPreset, type StrapStyle } from "@/lib/visuals"
import { cn } from "@/lib/utils"

export type StrapLook = {
  style: StrapStyle
  motion: StrapMotion
  accent: string
  text: string
  /** this design's text sizes and accents (default: designed size, every accent on) */
  design?: StrapDesign
}

/**
 * One name strap (lower third), designed at 1920x1080 in px × --px. `visible` drives the motion:
 * in 0.68s cubic-bezier(.16,1,.3,1), out 0.48s (CSS transitions in globals.css, .strap*).
 *
 * Text size: the outer wrapper keeps the page's --px as --strap-px0; the strap redefines --px from it
 * × name size (so the box, padding and accents grow with the name), and the subline lines use
 * --strap-sub-px (× subline size). Accents that are off are not rendered, so the box shrinks to fit.
 */
export function NameStrap({ preset, look, visible }: { preset: Pick<StrapPreset, "name" | "title" | "handle" | "platform">; look: StrapLook; visible: boolean }) {
  const design = look.design ?? DEFAULT_STRAP_DESIGN
  const has = (a: Parameters<typeof strapAccentOn>[1]) => strapAccentOn(design, a)
  const c = strapColors(look.style, design, look.accent, look.text)
  const vars = {
    "--strap-accent": look.accent,
    "--strap-text": look.text,
    // One variable per element (globals.css › per-element colours), so nothing shares a colour by accident.
    "--sc-name": c.name, "--sc-sub": c.sub, "--sc-box": c.box, "--sc-box2": c.box2, "--sc-bar": c.bar,
    "--sc-dot": c.dot, "--sc-arrow": c.arrow, "--sc-live": c.live, "--sc-grad": c.grad,
    ...(design.nameSize === 100 ? {} : { "--px": `calc(var(--strap-px0) * ${design.nameSize / 100})` }),
    "--strap-sub-px": `calc(var(--strap-px0) * ${design.subSize / 100})`,
  } as CSSProperties
  const handle = preset.handle.trim()
  const icon = has("icon") && preset.platform !== "none"
  const social = handle || icon ? (
    <span className="strap-social">
      {icon ? <PlatformIcon platform={preset.platform} bg={c.icon} /> : null}
      {handle ? <span>{handle}</span> : null}
    </span>
  ) : null
  const lines = (
    <div className="strap-lines">
      <span className="strap-name">{preset.name}</span>
      {preset.title ? <span className="strap-title">{preset.title}</span> : null}
      {social}
    </div>
  )
  return (
    <div className="strap-scale" style={{ "--strap-px0": "var(--px)" } as CSSProperties}>
      <div data-testid="name-strap" data-style={look.style} data-motion={look.motion} data-visible={visible ? "1" : "0"} data-name-size={design.nameSize} data-sub-size={design.subSize}
        className={cn("strap", `strap-${look.style}`, `strap-m-${look.motion}`, visible ? "strap-on" : "strap-off", (look.style === "line" || look.style === "house") && !has("bar") && "strap-no-bar")} style={vars}>
        {look.style === "house" ? (
          <div className="strap-body">
            {has("dot") ? <span data-testid="strap-accent-circle" className="strap-dot" /> : null}
            {lines}
            {has("arrow") ? <span data-testid="strap-arrow" className="strap-arrow" aria-hidden>↗</span> : null}
          </div>
        ) : look.style === "line" ? (
          <div className="strap-body">
            {has("bar") ? <span data-testid="strap-bar" className="strap-bar" /> : null}
            {lines}
            {has("live") ? <span data-testid="strap-live-dot" className="strap-live-dot" aria-hidden /> : null}
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
            {has("live") ? <span data-testid="strap-live-dot" className="strap-live-dot" aria-hidden /> : null}
            {icon ? <PlatformIcon platform={preset.platform} className="strap-pill-icon" bg={c.icon} /> : null}
            <div className="strap-lines">
              <span className="strap-name">{preset.name}</span>
              {handle || preset.title ? <span className="strap-title">{handle || preset.title}</span> : null}
            </div>
          </div>
        ) : (
          <div className="strap-body">
            <span className="strap-name">{preset.name}</span>
            {preset.title ? <span className="strap-title">{preset.title}</span> : null}
            {social}
          </div>
        )}
      </div>
    </div>
  )
}
