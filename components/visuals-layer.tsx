"use client"

/**
 * Visuals layer: everything the deck puts over the picture, drawn at 1920x1080 (px × --px) inside the
 * 16:9 frame. Rendered on /stream (so it is in the capture → YouTube, Restream, Vertical) and on the
 * transparent OBS source /overlay/visuals. Pure view of the stage; the deck writes the stage.
 *
 * Z-order (low → high): ticker bar, pills (talk-ends, Sponsored, Q&A), name strap, social circles.
 * Full-screen cards (break / hold / welcome / end) hide the whole layer: they are their own visual.
 */
import type { CSSProperties, ReactNode } from "react"
import { NameStrap } from "@/components/name-strap"
import { SocialCircles } from "@/components/social-circles"
import { FacebookIcon, InstagramIcon, LinkedInIcon, XIcon, YouTubeIcon } from "@/components/countdown-stage"
import type { EventConfig } from "@/lib/event"
import { socialLook, type StageOptions } from "@/lib/stage"
import { cornerOffsets, formatClock, parseTalkTimer, SAFE_X_PX, SAFE_Y_PX, strapVisible, talkPillValue, TICKER_GAP_PX, TICKER_H_PX, type Corner } from "@/lib/visuals"

export type LayerScreen = "countdown" | "program" | "break" | "hold" | "welcome" | "end" | "overlay"

/** Pure: which parts of the layer show on a screen. OBS overlay page ("overlay") shows everything that is on. */
export function layerParts(stage: Pick<StageOptions, "streamVisuals" | "talkVisible" | "tickerVisible" | "tickerItems" | "qaVisible" | "sponsorVisible" | "socialsOverlay">, screen: LayerScreen) {
  const full = screen === "break" || screen === "hold" || screen === "welcome" || screen === "end"
  const on = screen === "overlay" || (!full && stage.streamVisuals)
  return {
    strap: on,
    talk: on && stage.talkVisible,
    ticker: on && stage.tickerVisible && stage.tickerItems.length > 0,
    qa: on && stage.qaVisible,
    sponsor: on && stage.sponsorVisible,
    // The countdown screen has its own social circles; the overlay ones are for program/OBS.
    socials: on && stage.socialsOverlay && screen !== "countdown",
  }
}

const px = (n?: number) => (n === undefined ? undefined : `calc(${n} * var(--px))`)
function anchor(corner: Corner, inset: number, lift = 0): CSSProperties {
  const o = cornerOffsets(corner, inset)
  return {
    position: "absolute",
    left: px(o.left), right: px(o.right), top: px(o.top), bottom: px(o.bottom === undefined ? undefined : o.bottom + lift),
    display: "flex", flexDirection: "column",
    alignItems: o.right !== undefined ? "flex-end" : "flex-start",
  }
}

function Pill({ show, kind, style, children, testId }: { show: boolean; kind: string; style: CSSProperties; children: ReactNode; testId: string }) {
  return <div data-testid={testId} data-on={show ? "1" : "0"} className={`vl-pill vl-${kind} ${show ? "vl-on" : "vl-off"}`} style={style}>{children}</div>
}

export function VisualsLayer({ stage, event, screen, now, eventEndMs, className = "" }: {
  stage: StageOptions
  event: EventConfig
  screen: LayerScreen
  /** wall clock ms (null before hydration: nothing timed shows) */
  now: number | null
  /** event end instant (Festival mode), null if unknown */
  eventEndMs: number | null
  className?: string
}) {
  const parts = layerParts(stage, screen)
  const inset = stage.overlayInset
  const lift = parts.ticker ? TICKER_H_PX + TICKER_GAP_PX : 0
  const preset = stage.straps.find((p) => p.id === stage.strapId) ?? null
  const strapOn = Boolean(parts.strap && preset && now !== null && strapVisible(stage.strapMode, stage.strapAt, stage.strapHoldSec, now))
  const talk = now === null ? { ms: null, over: false } : talkPillValue(stage.talkMode, parseTalkTimer(stage.talkEndsAt, stage.talkPausedMs), eventEndMs, now)
  const paused = stage.talkMode === "session" && stage.talkPausedMs !== null
  return (
    <div aria-hidden data-testid="visuals-layer" data-screen={screen} className={`visuals-layer pointer-events-none ${className}`}>
      <div data-testid="vl-ticker" data-on={parts.ticker ? "1" : "0"} className={`vl-ticker ${parts.ticker ? "vl-on" : "vl-off"}`}>
        <span className="vl-ticker-tag">{stage.tickerType === "social" ? "SOCIAL" : "PLANNER"}</span>
        <div className="vl-ticker-track">
          {/* two copies back to back: the marquee moves by one copy (-50%) and loops seamlessly */}
          <div className="vl-marquee">{[0, 1].map((copy) => <span key={copy} className="vl-ticker-run">{stage.tickerItems.map((item, i) => <span key={i} className="vl-ticker-item">{item}</span>)}</span>)}</div>
        </div>
      </div>
      <Pill show={parts.talk} kind="talk" testId="vl-talk" style={{ position: "absolute", left: px(SAFE_X_PX + inset), top: px(SAFE_Y_PX + inset) }}>
        <span className={`vl-rec ${talk.over ? "vl-rec-over" : ""}`} />
        <span className="vl-talk-prefix">{stage.talkMode === "festival" ? stage.festivalPrefix : stage.talkPrefix}</span>
        <span data-testid="vl-talk-clock" className={`vl-talk-clock ${talk.over ? "vl-over" : ""}`}>{formatClock(talk.ms)}{paused ? " ❚❚" : ""}</span>
      </Pill>
      <Pill show={parts.sponsor} kind="sponsor" testId="vl-sponsor" style={{ position: "absolute", right: px(SAFE_X_PX + inset), top: px(SAFE_Y_PX + inset) }}>{stage.sponsorText}</Pill>
      <Pill show={parts.qa} kind="qa" testId="vl-qa" style={{ position: "absolute", right: px(SAFE_X_PX + inset), bottom: px(SAFE_Y_PX + inset + lift) }}>{stage.qaText}</Pill>
      {preset ? (
        <div className="vl-anchor" style={anchor(stage.strapCorner, inset, lift)} data-corner={stage.strapCorner}>
          <NameStrap key={preset.id} preset={preset} visible={strapOn} look={{ style: stage.strapStyle || preset.style, motion: stage.strapMotion, accent: stage.strapAccent, text: stage.strapText }} />
        </div>
      ) : null}
      {parts.socials ? (
        <div className="vl-anchor" style={anchor(stage.socialsCorner, inset, lift)} data-corner={stage.socialsCorner}>
          <SocialCircles
            className={stage.socialsCorner.endsWith("right") ? "items-end" : undefined}
            handleAt={stage.socialsCorner.startsWith("top") ? "below" : "above"}
            look={socialLook(stage)}
            links={[
              { label: "X", href: event.xUrl, icon: <XIcon /> },
              { label: "Facebook", href: event.facebookUrl, icon: <FacebookIcon /> },
              { label: "LinkedIn", href: event.linkedinUrl, icon: <LinkedInIcon /> },
              { label: "Instagram", href: event.instagramUrl, icon: <InstagramIcon /> },
              { label: "YouTube", href: event.youtubeUrl, icon: <YouTubeIcon /> },
            ]}
          />
        </div>
      ) : null}
    </div>
  )
}
