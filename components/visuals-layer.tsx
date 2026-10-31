"use client"

/**
 * Visuals layer: everything the deck puts over the picture, drawn at 1920x1080 (px × --px) inside the
 * 16:9 frame. Rendered on /stream (so it is in the capture → YouTube, Restream, Vertical) and on the
 * transparent OBS source /overlay/visuals. Pure view of the stage; the deck writes the stage.
 *
 * Z-order (low → high): ticker bar, social circles, logos, QR, pills (talk-ends, Sponsored, Q&A), name strap.
 * Full-screen cards (break / hold / welcome / end) hide the whole layer: they are their own visual.
 */
import type { CSSProperties, ReactNode } from "react"
import { NameStrap } from "@/components/name-strap"
import { LogoMark, QrMark } from "@/components/visual-assets"
import { LOGO_IDS, type SceneId } from "@/lib/visuals-assets"
import { SocialCircles } from "@/components/social-circles"
import { FacebookIcon, InstagramIcon, LinkedInIcon, XIcon, YouTubeIcon } from "@/components/countdown-stage"
import type { EventConfig } from "@/lib/event"
import { socialLook, type StageOptions } from "@/lib/stage"
import { formatClock, parseTalkTimer, tickerLine, strapVisible, talkPillValue, TICKER_GAP_PX, TICKER_H_PX, DEFAULT_STRAP_DESIGNS, DEFAULT_TEXT_SCALE, TALK_ENDING_TEXT, type Corner } from "@/lib/visuals"
import { cornerOrigin, layoutScreen, partCorner, placeOffsets, type LayoutPart } from "@/lib/visuals-layout"

export type LayerScreen = "countdown" | "program" | "break" | "hold" | "welcome" | SceneId | "end" | "overlay"

/** Pure: which parts of the layer show on a screen. OBS overlay page ("overlay") shows everything that is on. */
export function layerParts(stage: Pick<StageOptions, "streamVisuals" | "talkVisible" | "tickerVisible" | "tickerItems" | "qaVisible" | "sponsorVisible" | "socialsOverlay"> & Partial<Pick<StageOptions, "logosOn" | "qrOn" | "qrLogoOn">>, screen: LayerScreen) {
  // Every full-screen card (break / hold / welcome / end and the scene cards) hides the layer.
  const full = screen !== "countdown" && screen !== "program" && screen !== "overlay"
  const on = screen === "overlay" || (!full && stage.streamVisuals)
  return {
    strap: on,
    talk: on && stage.talkVisible,
    ticker: on && stage.tickerVisible && stage.tickerItems.length > 0,
    qa: on && stage.qaVisible,
    sponsor: on && stage.sponsorVisible,
    // The countdown screen has its own social circles; the overlay ones are for program/OBS.
    socials: on && stage.socialsOverlay && screen !== "countdown",
    logos: on ? LOGO_IDS.filter((id) => (stage.logosOn ?? []).includes(id)) : [],
    qr: on && stage.qrOn === true,
    qrLogo: on && stage.qrLogoOn === true,
  }
}

const px = (n?: number) => (n === undefined ? undefined : `calc(${n} * var(--px))`)
/** Wrapper for one part: anchored at its corner (layout gap + snap), scaled from that corner. */
function placeStyle(stage: StageOptions, screen: LayerScreen, part: LayoutPart, lift: number): { style: CSSProperties; corner: Corner } {
  const ls = layoutScreen(screen)
  const p = stage.visualsLayout[ls][part]
  const corner = partCorner(ls, part, stage.visualsLayout, stage)
  const o = placeOffsets(p, stage.overlayInset, lift, corner)
  return {
    corner,
    style: {
      position: "absolute",
      left: px(o.left), right: px(o.right), top: px(o.top), bottom: px(o.bottom),
      display: "flex", flexDirection: "column",
      alignItems: p.center ? "center" : o.right !== undefined ? "flex-end" : "flex-start",
      transform: [p.center ? "translateX(-50%)" : "", p.size === 100 ? "" : `scale(${p.size / 100})`].filter(Boolean).join(" ") || undefined,
      transformOrigin: cornerOrigin(corner, p.center),
    },
  }
}

/** Text size %: redefines --px from the layer's own (--vl-px0), so the text and its box scale together. */
export const textScaleVars = (pct: number): CSSProperties | undefined => (pct === 100 ? undefined : ({ "--px": `calc(var(--vl-px0) * ${pct / 100})` } as CSSProperties))

function Pill({ show, kind, place, children, testId, scale = 100 }: { show: boolean; kind: string; place: { style: CSSProperties; corner: Corner }; children: ReactNode; testId: string; scale?: number }) {
  return (
    <div className="vl-place" data-part={kind} data-corner={place.corner} style={place.style}>
      <div data-testid={testId} data-on={show ? "1" : "0"} data-text-size={scale} className={`vl-pill vl-${kind} ${show ? "vl-on" : "vl-off"}`} style={textScaleVars(scale)}>{children}</div>
    </div>
  )
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
  const ts = stage.textScale ?? DEFAULT_TEXT_SCALE
  // The bar grows with its text size, so bottom parts lift by its real height.
  const lift = parts.ticker ? Math.round((TICKER_H_PX * ts.ticker) / 100) + TICKER_GAP_PX : 0
  const preset = stage.straps.find((p) => p.id === stage.strapId) ?? null
  const strapOn = Boolean(parts.strap && preset && now !== null && strapVisible(stage.strapMode, stage.strapAt, stage.strapHoldSec, now))
  const talk = now === null ? { ms: null, over: false } : talkPillValue(stage.talkMode, parseTalkTimer(stage.talkEndsAt, stage.talkPausedMs), eventEndMs, now)
  const at = (part: LayoutPart) => placeStyle(stage, screen, part, lift)
  const strapAt = at("strap")
  const socialsAt = at("socials")
  const paused = stage.talkMode === "session" && stage.talkPausedMs !== null
  const ending = stage.talkMode === "session" && talk.over
  return (
    <div aria-hidden data-testid="visuals-layer" data-screen={screen} className={`visuals-layer pointer-events-none ${className}`} style={{ "--vl-px0": "var(--px)" } as CSSProperties}>
      <div data-testid="vl-ticker" data-on={parts.ticker ? "1" : "0"} data-text-size={ts.ticker} className={`vl-ticker ${parts.ticker ? "vl-on" : "vl-off"}`} style={textScaleVars(ts.ticker)}>
        <div className="vl-ticker-track">
          {/* two copies back to back: the marquee moves by one copy (-50%) and loops seamlessly */}
          <div className="vl-marquee">{[0, 1].map((copy) => <span key={copy} className="vl-ticker-run">{stage.tickerItems.map((item, i) => <span key={i} className="vl-ticker-item">{tickerLine(stage.tickerType, item)}</span>)}</span>)}</div>
        </div>
      </div>
      {/* Stacking (low → high): ticker, social circles, logos, QR, pills, name strap. */}
      {parts.socials ? (
        <div className="vl-anchor" data-part="socials" style={socialsAt.style} data-corner={socialsAt.corner}>
          <SocialCircles
            className={socialsAt.corner.endsWith("right") ? "items-end" : undefined}
            handleAt={socialsAt.corner.startsWith("top") ? "below" : "above"}
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
      {LOGO_IDS.map((id) => {
        const show = parts.logos.includes(id)
        const place = at(id)
        return <div key={id} className="vl-place" data-part={id} data-corner={place.corner} style={place.style}><LogoMark id={id} cfg={stage.logos[id]} show={show} /></div>
      })}
      {(["qr", "qrLogo"] as const).map((part) => {
        const place = at(part)
        return <div key={part} className="vl-place" data-part={part} data-corner={place.corner} style={place.style}><QrMark cfg={stage.qr} variant={part === "qr" ? "animated" : "logo"} show={parts[part]} now={now} testId={part === "qr" ? "vl-qr" : "vl-qr-logo"} /></div>
      })}
      <Pill show={parts.talk} kind="talk" testId="vl-talk" place={at("talk")} scale={stage.talkMode === "festival" ? ts.festival : ts.talk}>
        <span className={`vl-rec ${stage.talkMode === "festival" ? "vl-rec-festival" : ""} ${talk.over ? "vl-rec-over" : ""}`} />
        {ending ? (
          // Session talk at 0:00: a message instead of a clock hanging on 00:00.
          <span data-testid="vl-talk-ending" className="vl-talk-prefix vl-over">{TALK_ENDING_TEXT}</span>
        ) : (
          <>
            <span className="vl-talk-prefix">{stage.talkMode === "festival" ? stage.festivalPrefix : stage.talkPrefix}</span>
            <span data-testid="vl-talk-clock" className={`vl-talk-clock ${talk.over ? "vl-over" : ""}`}>{formatClock(talk.ms)}{paused ? " ❚❚" : ""}</span>
          </>
        )}
        <span className="vl-talk-accent" />
      </Pill>
      <Pill show={parts.sponsor} kind="sponsor" testId="vl-sponsor" place={at("sponsor")} scale={ts.sponsor}>{stage.sponsorText}</Pill>
      <Pill show={parts.qa} kind="qa" testId="vl-qa" place={at("qa")} scale={ts.qa}>{stage.qaText}</Pill>
      {preset ? (
        <div className="vl-anchor" data-part="strap" style={strapAt.style} data-corner={strapAt.corner}>
          <NameStrap key={preset.id} preset={preset} visible={strapOn} look={{ style: stage.strapStyle || preset.style, motion: stage.strapMotion, accent: stage.strapAccent, text: stage.strapText, design: (stage.strapDesigns ?? DEFAULT_STRAP_DESIGNS)[stage.strapStyle || preset.style] }} />
        </div>
      ) : null}
    </div>
  )
}
