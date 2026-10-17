"use client"

import type { ReactNode } from "react"
import { useNow } from "@/lib/use-now"
import { safeUrl } from "@/lib/event"
import { socialHandle, socialSpotlight, SOCIAL_COOLDOWN_MS, SOCIAL_DWELL_MS } from "@/lib/social-spotlight"
import { cn } from "@/lib/utils"

export type SocialLink = { label: string; href: string; icon: ReactNode }
export type SocialLook = {
  spotlight?: boolean
  dwellMs?: number
  cooldownMs?: number
  /** ring stroke px @1080p (0 = no ring) */
  strokePx?: number
  showHandle?: boolean
}

/**
 * Our social row with the forge / Hyphen "Social Circles" animation:
 * one circle at a time scales up with a lime glow, the others dim; after the last one all rest for the cooldown. Wall-clock driven, so every view agrees.
 */
export function SocialCircles({ links, look = {}, className }: { links: SocialLink[]; look?: SocialLook; className?: string }) {
  const { spotlight = true, dwellMs = SOCIAL_DWELL_MS, cooldownMs = SOCIAL_COOLDOWN_MS, strokePx = 3, showHandle = true } = look
  const now = useNow()
  const shown = links.filter((link) => link.href.trim())
  const spot = spotlight && now ? socialSpotlight(now.getTime(), shown.length, dwellMs, cooldownMs) : null
  const activeLink = spot?.active != null ? shown[spot.active] : null
  return (
    <div className={cn("flex flex-col items-start", className)} data-testid="social-circles" data-active={spot?.active ?? ""} style={{ ["--social-stroke" as string]: strokePx }}>
      <div className="flex items-center gap-[0.7cqi]">
        {shown.map((link, i) => {
          const active = spot?.active === i
          const dim = Boolean(spot) && !active
          return (
            <a
              key={link.label}
              href={safeUrl(link.href, "#")}
              target="_blank"
              rel="noreferrer"
              aria-label={link.label}
              className={cn("social-circle relative inline-flex size-[2.99cqi] items-center justify-center rounded-full text-white no-underline", active && "social-circle-active", dim && "social-circle-dim")}
            >
              <span className="social-face">{link.icon}</span>
            </a>
          )
        })}
      </div>
      {showHandle && spotlight ? (
        <span data-testid="social-handle" className={cn("social-handle", activeLink ? "opacity-100" : "opacity-0")}>
          {activeLink ? socialHandle(activeLink.href) : "\u00a0"}
        </span>
      ) : null}
    </div>
  )
}
