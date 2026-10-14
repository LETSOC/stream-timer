"use client"

import { useEffect, useRef, useState } from "react"
import type Hls from "hls.js"

/**
 * Full-bleed OBS program feed on /stream: LL-HLS of the relay's /program path through
 * /api/program/hls (view-key / capture-key gated; no relay logins in the browser).
 * Plays with sound where the browser allows it (OBS Browser Source does); otherwise muted.
 * Shows "Waiting for OBS" in the same frame while OBS isn't sending.
 */
/** `muted`: previews (deck iframe uses /stream?mute=1) never play sound. */
export function ProgramFeed({ ready, visible, muted = false }: { ready: boolean; visible: boolean; muted?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const hlsRef = useRef<Hls | null>(null)
  const [latency, setLatency] = useState<number | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video || !ready) return
    let hls: Hls | null = null
    let cancelled = false
    const src = "/api/program/hls/program/index.m3u8"
    const play = () => {
      video.muted = muted
      video.play().catch(() => {
        // Autoplay with sound refused (normal browsers): keep the picture going muted.
        video.muted = true
        void video.play().catch(() => undefined)
      })
    }
    void (async () => {
      const { default: HlsLib } = await import("hls.js")
      if (cancelled) return
      if (HlsLib.isSupported()) {
        hls = new HlsLib({ enableWorker: true, lowLatencyMode: true, backBufferLength: 4, liveSyncDurationCount: 1, liveMaxLatencyDurationCount: 4, maxLiveSyncPlaybackRate: 1.15, manifestLoadingMaxRetry: Infinity, levelLoadingMaxRetry: Infinity, fragLoadingMaxRetry: 6 })
        hlsRef.current = hls
        hls.loadSource(src)
        hls.attachMedia(video)
        hls.on(HlsLib.Events.MANIFEST_PARSED, play)
        hls.on(HlsLib.Events.ERROR, (_event, data) => {
          if (!data.fatal || !hls) return
          if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
          else hls.startLoad()
        })
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src
        play()
      }
    })()
    return () => {
      cancelled = true
      hlsRef.current = null
      hls?.destroy()
      video.removeAttribute("src")
      video.load()
      setPlaying(false)
    }
  }, [ready, muted])

  // Kept loaded under a break/hold/welcome card so "back to program" is instant, but silent there.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!visible || muted) video.muted = true
    else if (video.muted) {
      video.muted = false
      void video.play().catch(() => {
        video.muted = true
      })
    }
  }, [visible, muted])

  // "Playing" = the picture is actually advancing (not just a frozen last frame).
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let last = -1
    const id = window.setInterval(() => {
      const advancing = ready && !video.paused && video.currentTime !== last && video.readyState >= 2
      last = video.currentTime
      setPlaying(advancing)
      // Glass-to-glass-ish: now minus the relay's wall-clock stamp of the frame on screen (EXT-X-PROGRAM-DATE-TIME).
      const at = hlsRef.current?.playingDate?.getTime()
      setLatency(advancing && at ? Date.now() - at : null)
    }, 500)
    return () => window.clearInterval(id)
  }, [ready])

  return (
    <div data-testid="program-feed" data-playing={playing ? "1" : "0"} data-latency-ms={latency ?? ""} aria-hidden={!visible} className={`fixed inset-0 bg-black ${visible ? "" : "invisible"}`}>
      <video ref={videoRef} className="h-full w-full object-contain" autoPlay playsInline disablePictureInPicture />
      {!playing ? (
        <div data-testid="program-standby" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black text-white">
          <span className="size-3 animate-pulse rounded-full bg-[#ff3c00]" />
          <p className="text-[3vw] font-black tracking-tight uppercase">Waiting for OBS</p>
          <p className="font-mono text-[1.2vw] text-white/60">The program feed starts as soon as OBS is streaming.</p>
        </div>
      ) : null}
    </div>
  )
}
