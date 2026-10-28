"use client"

import { Suspense, useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { useSearchParams } from "next/navigation"
import { NameStrap } from "@/components/name-strap"
import { SocialCircles } from "@/components/social-circles"
import { FacebookIcon, InstagramIcon, LinkedInIcon, XIcon, YouTubeIcon } from "@/components/countdown-stage"
import { asEventConfig, DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import { parseStage, socialLook, type StageOptions } from "@/lib/stage"
import { StageGuides } from "@/components/stage-guides"
import { clampInset, cornerOffsets, parseCorner, strapVisible, type Corner } from "@/lib/visuals"
import { useNow } from "@/lib/use-now"
import { VisualsLayer } from "@/components/visuals-layer"
import { endCardAt } from "@/lib/transport"

export type OverlayInitial = { event: EventConfig; stage: Partial<Record<keyof StageOptions, unknown>> } | null

/** Same view-key model as /stream: ?k= (sets the cookie via /api/public/state), cookie, operator, capture. */
function useOverlayState(initial: OverlayInitial) {
  const params = useSearchParams()
  const viewKey = params.get("k") ?? ""
  const [event, setEvent] = useState<EventConfig>(initial?.event ?? DEFAULT_EVENT)
  const [stage, setStage] = useState<StageOptions>(() => parseStage(initial?.stage ?? {}))
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      void fetch(viewKey ? `/api/public/state?k=${encodeURIComponent(viewKey)}` : "/api/public/state", { cache: "no-store" })
        .then((r) => {
          if (r.status === 401) {
            if (!cancelled) setBlocked(true)
            throw new Error("view key")
          }
          return r.json()
        })
        .then((body: { event?: unknown; stage?: unknown }) => {
          if (cancelled) return
          setBlocked(false)
          const next = asEventConfig(body.event)
          if (next) setEvent((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next))
          if (body.stage && typeof body.stage === "object") {
            const parsed = parseStage(body.stage)
            setStage((cur) => (JSON.stringify(cur) === JSON.stringify(parsed) ? cur : parsed))
          }
        })
        .catch(() => undefined)
    load()
    // Twice a second: an IN tap starts the motion within ~0.5s.
    const id = window.setInterval(load, 500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [viewKey])
  return { event, stage, blocked, checker: params.get("checker") === "1", guides: params.get("guides") === "1", corner: params.get("corner"), insetParam: params.get("inset") }
}

function Frame({ checker, guides, blocked, children }: { checker: boolean; guides?: boolean; blocked: boolean; children: ReactNode }) {
  useEffect(() => {
    const els = [document.documentElement, document.body]
    const prev = els.map((el) => el.style.background)
    els.forEach((el) => el.style.setProperty("background", "transparent", "important"))
    document.documentElement.dataset.streamReady = "1"
    return () => els.forEach((el, i) => (el.style.background = prev[i]))
  }, [])
  return (
    <div className={checker ? "overlay-stage overlay-checker" : "overlay-stage"} data-testid="overlay-stage">
      {blocked ? <p className="absolute top-[3cqi] left-[3cqi] rounded bg-black/70 px-[1cqi] py-[0.5cqi] font-mono text-[1cqi] text-white">View key required. Copy the OBS URL from the desk › Visuals.</p> : children}
      {guides ? <StageGuides className="inset-0" /> : null}
    </div>
  )
}

function anchorStyle(corner: Corner, inset: number): CSSProperties {
  const o = cornerOffsets(corner, inset)
  const px = (n?: number) => (n === undefined ? undefined : `calc(${n} * var(--px))`)
  return { left: px(o.left), right: px(o.right), top: px(o.top), bottom: px(o.bottom), display: "flex", flexDirection: "column", alignItems: o.right !== undefined ? "flex-end" : "flex-start", justifyContent: o.bottom !== undefined ? "flex-end" : "flex-start" }
}

function StrapInner({ initial }: { initial: OverlayInitial }) {
  const { stage, blocked, checker, guides, corner, insetParam } = useOverlayState(initial)
  const inset = insetParam !== null ? clampInset(insetParam, stage.overlayInset) : stage.overlayInset
  const now = useNow()
  const preset = stage.straps.find((p) => p.id === stage.strapId) ?? null
  const visible = Boolean(preset && now && strapVisible(stage.strapMode, stage.strapAt, stage.strapHoldSec, now.getTime()))
  const where = corner ? parseCorner(corner, stage.strapCorner) : stage.strapCorner
  return (
    <Frame checker={checker} guides={guides} blocked={blocked}>
      {preset ? (
        <div className="overlay-anchor" style={anchorStyle(where, inset)} data-corner={where}>
          <NameStrap key={preset.id} preset={preset} visible={visible} look={{ style: stage.strapStyle || preset.style, motion: stage.strapMotion, accent: stage.strapAccent, text: stage.strapText, design: stage.strapDesigns?.[stage.strapStyle || preset.style] }} />
        </div>
      ) : null}
    </Frame>
  )
}

function SocialsInner({ initial }: { initial: OverlayInitial }) {
  const { event, stage, blocked, checker, guides, corner, insetParam } = useOverlayState(initial)
  const inset = insetParam !== null ? clampInset(insetParam, stage.overlayInset) : stage.overlayInset
  const where = corner ? parseCorner(corner, stage.socialsCorner) : stage.socialsCorner
  const show = stage.socialsOverlay
  return (
    <Frame checker={checker} guides={guides} blocked={blocked}>
      <div className="overlay-anchor transition-opacity duration-500" style={{ ...anchorStyle(where, inset), opacity: show ? 1 : 0 }} data-corner={where} data-show={show ? "1" : "0"}>
        <SocialCircles
          className={where.endsWith("right") ? "items-end" : undefined}
          handleAt={where.startsWith("top") ? "below" : "above"}
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
    </Frame>
  )
}

export function StrapOverlay({ initial }: { initial: OverlayInitial }) {
  return <Suspense fallback={null}><StrapInner initial={initial} /></Suspense>
}
export function SocialsOverlay({ initial }: { initial: OverlayInitial }) {
  return <Suspense fallback={null}><SocialsInner initial={initial} /></Suspense>
}

function VisualsInner({ initial }: { initial: OverlayInitial }) {
  const { event, stage, blocked, checker, guides } = useOverlayState(initial)
  const now = useNow()
  const end = endCardAt(event.date, event.time, event.endTime, event.timeZone, stage.endOffsetMin)
  return (
    <Frame checker={checker} guides={guides} blocked={blocked}>
      <VisualsLayer stage={stage} event={event} screen="overlay" now={now ? now.getTime() : null} eventEndMs={Number.isFinite(end) ? end : null} />
    </Frame>
  )
}
export function VisualsOverlay({ initial }: { initial: OverlayInitial }) {
  return <Suspense fallback={null}><VisualsInner initial={initial} /></Suspense>
}
