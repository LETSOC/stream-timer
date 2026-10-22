"use client"

import { useEffect, useRef, useState } from "react"
/* eslint-disable @next/next/no-img-element -- OBS output: plain <img> for data: SVG and uploads */
/**
 * Visuals assets drawn on /stream, /overlay/visuals and the builder preview (1920x1080 in px × --px):
 * logos 1–5, QR (animated / Logo QR) and the extra full-screen scene cards. No HTML injection:
 * logos are <img> (data: SVG or /uploads/*), QR codes are React SVG from real qrcode modules.
 */
import type { CSSProperties } from "react"
import { LOGO_BASE, logoSrc, QR_BASE_PX, qrBadgeBox, qrMatrix, qrRingCell, type LogoConfig, type LogoId, type QrConfig, type SceneCard } from "@/lib/visuals-assets"
import { isViewerMuted, subscribeViewerMute, viewerHasChosen } from "@/components/stream-audio-overlay"
import { isCapturePage } from "@/lib/player-diag"
import { pcmChunkB64 } from "@/lib/showreel-tap"

type ShowreelSend = (b64: string) => void
/** Browser capture only (window.__showreelPcm): hand the scene video's decoded audio to the capture mix. */
function useShowreelTap(videoRef: { current: HTMLVideoElement | null }, video: string) {
  useEffect(() => {
    const send = (window as unknown as { __showreelPcm?: ShowreelSend }).__showreelPcm
    const el = videoRef.current
    if (!send || !el || !video || !isCapturePage()) return
    let ctx: AudioContext | null = null
    try {
      ctx = new AudioContext({ sampleRate: 48000 })
      const node = ctx.createMediaElementSource(el)
      const proc = ctx.createScriptProcessor(512, 2, 2)
      proc.onaudioprocess = (e) => {
        const l = e.inputBuffer.getChannelData(0)
        const r = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : l
        if (!el.paused && !el.ended) send(pcmChunkB64(l, r))
      }
      node.connect(proc)
      proc.connect(ctx.destination) // keeps it running; writes silence
      void ctx.resume()
    } catch { /* no WebAudio: no showreel sound in the capture */ }
    return () => { void ctx?.close() }
  }, [videoRef, video])
}

const px = (n: number) => `calc(${n} * var(--px))`

export function LogoMark({ id, cfg, show }: { id: LogoId; cfg: LogoConfig; show: boolean }) {
  const src = logoSrc(id, cfg)
  const base = LOGO_BASE[id]
  return (
    <div data-testid={`vl-${id}`} data-on={show && src ? "1" : "0"} data-source={cfg.source} className={`vl-logo ${show && src ? "vl-on" : "vl-off"}`} style={{ width: px(base.w) }}>
      {src ? <img src={src} alt="" draggable={false} style={{ display: "block", width: "100%", height: id === "logo5" ? "auto" : px(base.h), objectFit: "contain" }} /> : null}
      {cfg.text ? <span className="vl-logo-text">{cfg.text}</span> : null}
    </div>
  )
}

/**
 * Real, scannable QR on white (quiet zone 2 modules). `animated`: one accent cell steps around the
 * quiet-zone ring every second (never over a module) and the code reveals in on show. `logo`: ECC H
 * with a centre badge (≈26% side) in the badge colour.
 */
export function QrMark({ cfg, variant, show, now, testId }: { cfg: QrConfig; variant: "animated" | "logo"; show: boolean; now: number | null; testId: string }) {
  const m = qrMatrix(cfg.url, variant === "logo" ? "H" : "M")
  const q = 2
  const n = m ? m.size + q * 2 : 1
  let d = ""
  if (m) for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.dark[y * m.size + x]) d += `M${x + q} ${y + q}h1v1h-1z`
  const badge = m && variant === "logo" ? qrBadgeBox(m.size) : null
  const ring = m && variant === "animated" && now !== null ? qrRingCell(m.size, Math.floor(now / 1000)) : null
  const on = show && Boolean(m)
  return (
    <div data-testid={testId} data-on={on ? "1" : "0"} data-variant={variant} data-modules={m?.size ?? 0} className={`vl-qr vl-qr-${variant} ${on ? "vl-on" : "vl-off"}`} style={{ width: px(QR_BASE_PX) }}>
      {m ? (
        <svg viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" role="img" aria-label={`QR code: ${cfg.url}`} style={{ display: "block", width: "100%", height: "auto", borderRadius: px(4) }}>
          <rect width={n} height={n} fill="#ffffff" />
          <path d={d} fill={cfg.color} />
          {ring ? <rect data-testid={`${testId}-step`} x={ring.x + q} y={ring.y + q} width={1} height={1} fill={cfg.accent} /> : null}
          {badge ? (
            <g data-testid={`${testId}-badge`}>
              <rect x={badge.x + q} y={badge.y + q} width={badge.w} height={badge.w} rx={0.4} fill={cfg.badgeColor} />
              {cfg.badgeText ? <text x={badge.x + q + badge.w / 2} y={badge.y + q + badge.w / 2} textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontWeight={700} fontSize={badge.w * 0.5} fontFamily="Instrument Sans, Arial, sans-serif">{cfg.badgeText}</text> : null}
            </g>
          ) : null}
        </svg>
      ) : null}
      {variant === "animated" && (cfg.caption || cfg.caption2) ? (
        <span className="vl-qr-caption">{cfg.caption}{cfg.caption2 ? <><br />{cfg.caption2}</> : null}</span>
      ) : null}
    </div>
  )
}

/** Full-screen scene card from the design (HOLD 05/06/07, STANDBY, SHOWREEL): pill + title + subline + dots. */
export function SceneCardView({ id, card, qr, now, className = "", onAir = false }: { id: string; card: SceneCard; qr?: QrConfig; now?: number | null; className?: string; /** Real /stream output: ended + autoSwitch cuts to Program. Preview stays quiet. */ onAir?: boolean }) {
  const image = card.bgMode !== "solid" && card.image ? card.image : ""
  const video = card.video || ""
  const videoRef = useRef<HTMLVideoElement>(null)
  const [, setPin] = useState(0)
  useEffect(() => subscribeViewerMute(() => setPin((n) => n + 1)), [])
  // Same rule as the program player: sound on unless the viewer muted. OBS Browser Source has no viewer choice, so it plays.
  const wantSound = !(viewerHasChosen() && isViewerMuted())
  useEffect(() => {
    const el = videoRef.current
    if (!el || !video) return
    el.muted = !wantSound
    void el.play().catch(() => {
      // Autoplay with sound refused (normal browser tab): keep the picture, muted. A tap on the stream unmute turns it back on.
      el.muted = true
      void el.play().catch(() => undefined)
    })
  }, [video, wantSound])
  useShowreelTap(videoRef, video)
  const onEnded = () => {
    // Browser capture only: viewers, the builder Live tab and desk previews start the video at other times and would cut early.
    if (!onAir || !card.autoSwitch || !video || !isCapturePage()) return
    void fetch("/api/public/showreel-ended", { method: "POST" }).catch(() => undefined)
  }
  const bg: CSSProperties = {
    backgroundColor: card.bg,
    backgroundImage: !video && card.bgMode === "image" && image ? `url("${image}")` : !video && card.gradient ? "linear-gradient(135deg,#2a1a1a 0%,#1a1a2a 100%)" : "none",
    backgroundSize: "cover",
    backgroundPosition: "center",
  }
  return (
    <div data-testid={`scene-${id}`} className={`countdown-stage scene-card relative isolate aspect-video w-full overflow-hidden text-white ${className}`} style={bg}>
      {video && !card.videoFront ? (
        <video ref={videoRef} data-testid={`scene-video-${id}`} src={video} autoPlay playsInline onEnded={onEnded} className="absolute inset-0 h-full w-full object-cover" />
      ) : null}
      <div className="visuals-layer" style={{ pointerEvents: "none" }}>
        {card.bgMode === "image" && image ? <div className="absolute inset-0" style={{ background: `rgba(0,0,0,${card.dim / 100})` }} /> : null}
        <div className="scene-pill"><span className="scene-dot" style={{ background: card.dot }} /><span>{card.pill}</span></div>
        <div className="scene-center">
          {card.bgMode === "hero" && image ? <img src={image} alt="" draggable={false} className="scene-hero" /> : null}
          <div data-testid="scene-title" className="scene-title">{card.label}</div>
          {card.sub ? <div className="scene-sub">{card.sub}</div> : null}
          <div className="scene-dots"><i /><i /><i /></div>
        </div>
        {card.showQr && qr?.url ? (
          <div className="scene-qr"><QrMark cfg={qr} variant="animated" show now={now ?? null} testId="scene-qr" /></div>
        ) : null}
      </div>
      {video && card.videoFront ? (
        <video ref={videoRef} data-testid={`scene-video-${id}`} src={video} autoPlay playsInline onEnded={onEnded} className="absolute inset-0 z-50 h-full w-full object-cover" />
      ) : null}
    </div>
  )
}
