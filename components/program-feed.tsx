"use client"

import { AudioBar, usePreviewAudio } from "@/components/preview-audio"
import { isViewerMuted, programWantsSound, resetViewerChoice, viewerHasChosen } from "@/components/stream-audio-overlay"
import { stallBackoffMs, useResumeGeneration } from "@/lib/use-resume"
import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import type Hls from "hls.js"
import { PreviewBadge } from "@/components/preview-badge"
import { useAutoHide } from "@/components/auto-hide"
import { whepPathFromHls } from "@/lib/whep-client"
import { useWhep } from "@/lib/use-whep"
import { isCapturePage, playerDiag } from "@/lib/player-diag"
import { holdStandby, keepLoaded, previewDisplay, programDisplay, STALL_HOLD_MS, type ProgramDisplay } from "@/lib/program-display"

/** Viewer path (/stream: view key / capture key). Operator previews use the relay's operator-only proxy. */
export const PROGRAM_VIEW_SRC = "/api/program/hls/program/index.m3u8"
export const PROGRAM_OPERATOR_SRC = "/api/relay/hls/program/index.m3u8"
export const programViewSrc = (path: string) => `/api/program/hls/${path}/index.m3u8`
export const programOperatorSrc = (path: string) => `/api/relay/hls/${path}/index.m3u8`

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}

/** programReady with flicker debounce: notReadySince marks when it went false (adjusted during render, from the ticking clock). */
function useReadiness(ready: boolean, now: number) {
  const [seen, setSeen] = useState<{ ready: boolean | null; notReadySince: number | null; readyAt: number | null }>({ ready: null, notReadySince: null, readyAt: null })
  if (seen.ready !== ready) setSeen({ ready, notReadySince: ready ? null : (seen.notReadySince ?? now), readyAt: ready ? now : seen.readyAt })
  return { notReadySince: seen.ready === ready ? seen.notReadySince : ready ? null : now, readyAt: seen.readyAt }
}

/** When `active` last turned on (null while off). */
function useActiveSince(active: boolean, now: number) {
  const [seen, setSeen] = useState<{ active: boolean; since: number | null }>({ active: false, since: null })
  if (seen.active !== active) setSeen({ active, since: active ? now : null })
  return seen.active === active ? seen.since : active ? now : null
}

/**
 * Loads LL-HLS into the <video> while `load`, and reports when the picture last advanced.
 * The element is the same for the player's whole life (WebAudio can attach to it once).
 */
function useProgramHls(videoRef: RefObject<HTMLVideoElement | null>, src: string, load: boolean, wantSound: () => boolean, opts: { stallEvents?: boolean; gentle?: boolean; hold?: boolean; /** /stream only: report to the dropout log (lib/player-diag) */ diag?: { label: string; onAir: boolean }; /** the element is about to go blank (teardown) or is broken (decode error): show the last frame */ onTrouble?: () => void } = {}) {
  const troubleRef = useRef(opts.onTrouble)
  useEffect(() => { troubleRef.current = opts.onTrouble })
  const diagRef = useRef(opts.diag)
  useEffect(() => { diagRef.current = opts.diag })
  // "!" only for the input on air; the standby one's trouble is context ("·").
  const report = (level: "!" | "+" | "·", msg: string, key?: string, dedupeMs?: number) => {
    const d = diagRef.current
    if (!d) return
    playerDiag(level === "!" && !d.onAir ? "·" : level, `${d.label}${d.onAir ? " (on air)" : " (standby)"}: ${msg}`, key ? { key: `${d.label}:${key}`, dedupeMs } : {})
  }
  const reportRef = useRef(report)
  useEffect(() => { reportRef.current = report })
  /** Why the next teardown happens (a teardown clears the element: black until the next first frame). */
  const teardownWhy = useRef<string>("unloaded (OBS gone > 3s, or source changed)")
  const builtAt = useRef<number | null>(null)
  // Operator previews pass stallEvents:false: iOS native LL-HLS fires "waiting"/"stalled" on ordinary
  // part waits, and rebuilding on each one (new src) chopped the deck preview's sound.
  const stallEvents = opts.stallEvents ?? true
  // gentle (phone/touch operator previews): iOS 17.1+ plays this through hls.js (ManagedMediaSource),
  // not native HLS. The on-air LL settings (1 part-segment of buffer, 1.15x catch-up) starve a phone on
  // Wi-Fi: constant rebuffering, and the rate changes warp the sound. Standard HLS (whole 1s segments),
  // ~3 s buffer, never speed up. WebRTC stays the low-latency picture.
  const gentle = opts.gentle ?? false
  // hold (/stream's standby input, plain browser tabs only): keep loading so the buffer is warm, but
  // keep the element paused, so the page decodes one 1080p feed instead of two. Released → jump to
  // the live edge and play; the hand-over still waits for its first frames (seamless).
  const hold = opts.hold ?? false
  const holdRef = useRef(hold)
  const hlsRef = useRef<Hls | null>(null)
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null)
  // Only real decoded frames (lastFrameAt is also bumped to hold the picture through a rebuild).
  const [realFrameAt, setRealFrameAt] = useState<number | null>(null)
  const [latency, setLatency] = useState<number | null>(null)
  const wantSoundRef = useRef(wantSound)
  useEffect(() => {
    wantSoundRef.current = wantSound
  })
  // Rebuild the player (not the page) when the page comes back (iOS suspends media in the
  // background) and when the watchdog finds it stuck while OBS is publishing.
  // Back from the background: rebuild, holding the last picture meanwhile (not "Waiting for OBS").
  const resumeGen = useResumeGeneration(1000, () => { teardownWhy.current = "page came back from the background (rebuild)"; setLastFrameAt((at) => (at === null ? null : Date.now())) })
  const [kick, setKick] = useState(0)
  useEffect(() => {
    const video = videoRef.current
    if (!video || !load) return
    let hls: Hls | null = null
    let cancelled = false
    builtAt.current = Date.now()
    // React doesn't reliably apply the `muted` attribute (WebKit): set the property before anything plays.
    video.muted = !wantSoundRef.current()
    const play = () => {
      if (holdRef.current) return
      video.muted = !wantSoundRef.current()
      video.play().catch(() => {
        // Autoplay with sound refused: keep the picture going muted.
        video.muted = true
        void video.play().catch(() => undefined)
      })
    }
    void (async () => {
      const { default: HlsLib } = await import("hls.js")
      if (cancelled) return
      if (HlsLib.isSupported()) {
        const tuning = gentle
          ? { lowLatencyMode: false, backBufferLength: 10, liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 7, maxLiveSyncPlaybackRate: 1 }
          : { lowLatencyMode: true, backBufferLength: 4, liveSyncDurationCount: 1, liveMaxLatencyDurationCount: 4, maxLiveSyncPlaybackRate: 1.15 }
        hls = new HlsLib({ enableWorker: true, ...tuning, manifestLoadingMaxRetry: Infinity, levelLoadingMaxRetry: Infinity, fragLoadingMaxRetry: 6 })
        hlsRef.current = hls
        hls.loadSource(src)
        hls.attachMedia(video)
        hls.on(HlsLib.Events.MANIFEST_PARSED, play)
        hls.on(HlsLib.Events.ERROR, (_event, data) => {
          if (data.fatal || data.details === "mediaSourceRequiresReset") troubleRef.current?.()
          if (data.fatal || data.details === "bufferStalledError") reportRef.current(data.fatal ? "!" : "!", `hls.js ${data.details}${data.fatal ? ` (fatal ${data.type}: ${data.type === HlsLib.ErrorTypes.MEDIA_ERROR ? "recoverMediaError" : "startLoad"})` : " (buffer ran dry: picture holds)"}`, data.details, 3000)
          else reportRef.current("·", `hls.js ${data.details}`, data.details, 10000)
          if (!data.fatal || !hls) return
          if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
          else hls.startLoad()
        })
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Native HLS (iOS): cache-bust so Safari doesn't resume a dead suspended session.
        video.src = `${src}${src.includes("?") ? "&" : "?"}r=${Date.now().toString(36)}`
        play()
      }
    })()
    return () => {
      cancelled = true
      troubleRef.current?.() // snapshot the last frame before the element is cleared
      reportRef.current("!", `player torn down: ${teardownWhy.current} → element cleared; last frame held on top until the first new frame`)
      teardownWhy.current = "unloaded (OBS gone > 3s, or source changed)"
      hlsRef.current = null
      hls?.destroy()
      video.removeAttribute("src")
      video.load()
    }
  }, [videoRef, src, load, resumeGen, kick, gentle])
  // Only a real unload (other source, OBS gone) forgets the last frame; a rebuild keeps it so the
  // picture holds instead of flashing "Waiting for OBS".
  useEffect(() => () => {
    setLastFrameAt(null)
    setRealFrameAt(null)
    setLatency(null)
  }, [src, load])

  // "Advancing" = a new frame is on screen, not a frozen last frame.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !load) return
    let last = -1
    let advancedAt = Date.now()
    let attempt = 0
    let nextKickAt = Date.now() + stallBackoffMs(0)
    // Native HLS (iOS) reports stalls as events; the currentTime check below catches the rest.
    const onStall = () => { if (Date.now() - advancedAt > 3000 && Date.now() >= nextKickAt) reload("native stall event after 3s stuck") }
    const onWaiting = (e: Event) => {
      const b = video.buffered
      const ahead = b.length ? b.end(b.length - 1) - video.currentTime : 0
      reportRef.current("·", `<video> ${e.type} (buffer ahead ${ahead.toFixed(2)}s, readyState ${video.readyState})`, `v-${e.type}`, 2000)
    }
    const onVideoError = () => { troubleRef.current?.(); reportRef.current("!", `<video> error ${video.error?.code ?? "?"} ${video.error?.message ?? ""}`.trim(), "v-error", 3000) }
    let firstFrameSeen = false
    const reload = (why = "watchdog: picture stuck 3s while OBS publishes") => {
      teardownWhy.current = why
      firstFrameSeen = false
      nextKickAt = Date.now() + stallBackoffMs(++attempt)
      advancedAt = Date.now()
      setLastFrameAt((at) => (at === null ? null : Date.now())) // hold the picture while it reloads
      setKick((k) => k + 1)
    }
    if (stallEvents) {
      video.addEventListener("stalled", onStall)
      video.addEventListener("waiting", onStall)
    }
    video.addEventListener("error", onStall)
    video.addEventListener("waiting", onWaiting)
    video.addEventListener("stalled", onWaiting)
    video.addEventListener("error", onVideoError)
    const id = window.setInterval(() => {
      const t = video.currentTime
      if (holdRef.current) { advancedAt = Date.now(); last = t; return }
      if (t !== last && t > 0 && !video.paused) { advancedAt = Date.now(); attempt = 0 }
      // Watchdog: OBS is publishing (load) but the picture hasn't moved for 3s → rebuild, with backoff.
      else if (document.visibilityState === "visible" && Date.now() - advancedAt > 3000 && Date.now() >= nextKickAt) reload()
      // Paused by the browser (refused autoplay with sound, tab policy): resume, muted if it must be.
      if (!wantSoundRef.current() && !video.muted) video.muted = true
      if (video.paused && video.readyState >= 2 && !video.ended) {
        void video.play().catch(() => {
          video.muted = true
          void video.play().catch(() => undefined)
        })
      }
      if (!video.paused && video.readyState >= 2 && t !== last && t > 0) {
        if (!firstFrameSeen) { firstFrameSeen = true; if (builtAt.current !== null) reportRef.current("+", `first frame ${Date.now() - builtAt.current}ms after the player (re)built`); builtAt.current = null }
        const nowMs = Date.now()
        setLastFrameAt(nowMs)
        setRealFrameAt(nowMs)
        const at = hlsRef.current?.playingDate?.getTime()
        setLatency(at ? Date.now() - at : null)
      }
      last = t
    }, 150)
    return () => {
      window.clearInterval(id)
      video.removeEventListener("stalled", onStall)
      video.removeEventListener("waiting", onStall)
      video.removeEventListener("error", onStall)
      video.removeEventListener("waiting", onWaiting)
      video.removeEventListener("stalled", onWaiting)
      video.removeEventListener("error", onVideoError)
    }
  }, [videoRef, load, stallEvents])
  useEffect(() => {
    holdRef.current = hold
    const video = videoRef.current
    if (!video) return
    if (hold) {
      // autoplay / hls.js / the browser can start it again: keep it paused while held.
      const stop = () => { if (holdRef.current && !video.paused) video.pause() }
      stop()
      video.addEventListener("play", stop)
      video.addEventListener("playing", stop)
      return () => { video.removeEventListener("play", stop); video.removeEventListener("playing", stop) }
    }
    if (!video.paused) return
    // Back on: from the live edge, not from where it was paused.
    const live = hlsRef.current?.liveSyncPosition ?? (video.seekable.length ? video.seekable.end(video.seekable.length - 1) - 1 : null)
    if (live !== null && live !== undefined && Number.isFinite(live) && live > video.currentTime) video.currentTime = live
    video.muted = !wantSoundRef.current()
    void video.play().catch(() => { video.muted = true; void video.play().catch(() => undefined) })
  }, [hold, videoRef])
  return { lastFrameAt, realFrameAt, latency }
}

function Standby({ small = false }: { small?: boolean }) {
  return (
    <div data-testid="program-standby" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black text-white">
      <span className="size-3 animate-pulse rounded-full bg-[#ff3c00]" />
      <p className={`${small ? "text-[14px]" : "text-[3vw]"} font-black tracking-tight uppercase`}>Waiting for OBS</p>
      {small ? null : <p className="font-mono text-[1.2vw] text-white/60">The program feed starts as soon as OBS is streaming.</p>}
    </div>
  )
}

/**
 * /stream's full-bleed OBS program layer. Prewarmed (loaded, invisible, muted) whenever OBS is sending,
 * so switching is instant; while `active` it stays transparent (the previous screen shows through) until
 * the first frame, then crossfades in. "Waiting for OBS" only after a grace or a real disconnect.
 * Sound on by default (OBS Browser Source captures it); `muted` for previews (?mute=1).
 */
/**
 * Browser capture only (it exposes window.__programPcm): tap this player's decoded audio and hand it
 * to the capture as s16 stereo, so the program audio in the output comes from the very element whose
 * picture is captured: in sync for Main and Backup, whatever their network latency/jitter.
 * The element's sound goes into the graph only (nothing is played out).
 */
function useCaptureAudioTap(videoRef: RefObject<HTMLVideoElement | null>, source: "main" | "backup") {
  useEffect(() => {
    const send = (window as unknown as { __programPcm?: (source: string, b64: string) => void }).__programPcm
    const video = videoRef.current
    if (!send || !video) return
    let ctx: AudioContext | null = null
    try {
      ctx = new AudioContext({ sampleRate: 48000 })
      const node = ctx.createMediaElementSource(video)
      const proc = ctx.createScriptProcessor(512, 2, 2)
      proc.onaudioprocess = (e) => {
        const l = e.inputBuffer.getChannelData(0)
        const r = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : l
        const out = new Int16Array(l.length * 2)
        for (let i = 0; i < l.length; i++) {
          out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767)))
          out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767)))
        }
        const bytes = new Uint8Array(out.buffer)
        let bin = ""
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        send(source, btoa(bin))
      }
      node.connect(proc)
      proc.connect(ctx.destination) // keeps the processor running; it writes no output (silence)
      void ctx.resume()
    } catch { /* no WebAudio: the capture falls back to reading the relay */ }
    return () => { void ctx?.close() }
  }, [videoRef, source])
}

export function ProgramFeed({ ready, active, muted = false, programAudio = true, onDisplay, onAlive, source = "main", path = "program", onAir = true, holdFrame = 0, incoming = false, rearmHoldUntil = null }: { /** a disarm/arm cycle (auto re-arm / desk buttons) holds the last frame until this local time (null = none) */ rearmHoldUntil?: number | null; /** picture really advancing (hand-over: a dead on-air input is cut at the new one's first frame) */ onAlive?: (alive: boolean) => void; /** a hand-over target: plays (silent, invisible) to fill its buffer; never shows its standby */ incoming?: boolean; ready: boolean; active: boolean; /** Hard mute: preview ?mute=1 or the standby input. The desk's raw-program checkbox is separate. */ muted?: boolean; /** Desk "/stream page audio" → raw program audio. Unchecked starts silent; a viewer's Unmute can still stick. Sound only: never pauses or unloads an input (Browser capture keeps both decoding either way). */ programAudio?: boolean; onDisplay?: (display: ProgramDisplay) => void; source?: "main" | "backup"; path?: string; /** the input on air (Browser capture reads its latency/source); the other one is prewarmed */ onAir?: boolean; /** extra ms to freeze on the last frame instead of "Waiting for OBS" (a Main/Backup hand-over may be coming) */ holdFrame?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const now = useNow(200)
  const { notReadySince, readyAt } = useReadiness(ready, now)
  const activeSince = useActiveSince(active, now)
  const load = keepLoaded(ready, notReadySince, now)
  const rearmHold = rearmHoldUntil !== null && now < rearmHoldUntil
  const showing = useRef<ProgramDisplay>("under")
  // Standby input in a plain tab: paused (warm buffer, no decode). Browser capture keeps both playing:
  // it takes each input's audio from its element (useCaptureAudioTap), so both must run.
  // Browser capture (?capture=1 / headless, or the page-audio tap) keeps both inputs decoding, so a
  // Main↔Backup switch or failover in the output never waits for a paused input to catch up.
  const [captureTap] = useState(() => isCapturePage())
  const hold = holdStandby({ onAir, incoming, captureTap })
  const label = source === "backup" ? "Backup" : "Main"
  // Last-frame cover: a player rebuild / decode error clears the <video> (black). The last good frame
  // is drawn on a canvas on top until the element shows a new frame, so the output freezes, never blacks.
  const coverRef = useRef<HTMLCanvasElement>(null)
  const coverOn = useRef(false)
  /** the cover canvas holds a good frame (state, so render can read it) */
  const [hasHeld, setHasHeld] = useState(false)
  const snapshot = useCallback((): boolean => {
    const video = videoRef.current
    const canvas = coverRef.current
    if (!video || !canvas || video.readyState < 2 || !video.videoWidth || video.error) return false
    try {
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) { canvas.width = video.videoWidth; canvas.height = video.videoHeight }
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.dataset.has = "1"
      setHasHeld(true)
      return true
    } catch { return false }
  }, [])
  const showCover = useCallback(() => {
    const canvas = coverRef.current
    if (!canvas || coverOn.current) return
    // Fresh snapshot if the element still has its frame; else the last periodic one (capture page).
    snapshot()
    if (canvas.dataset.has !== "1") return
    coverOn.current = true
    canvas.style.visibility = "visible"
  }, [snapshot])
  // Sound (main): the desk's raw-program box is the default, a viewer's Mute/Unmute wins, a hard mute
  // (?mute=1, standby input, picture not up) always silences. Sound only: `hold` above (pause the
  // standby input in a plain tab, never on the capture page) does not depend on it.
  const shownRef = useRef<ProgramDisplay>("under")
  const maySound = () => programWantsSound({ active: active && shownRef.current === "video", hardMuted: muted, programAudio, viewerChose: viewerHasChosen(), viewerMuted: isViewerMuted() })
  const { lastFrameAt, realFrameAt, latency } = useProgramHls(videoRef, programViewSrc(path), load, maySound, { hold, diag: { label, onAir }, onTrouble: showCover })
  // Cover off as soon as the element shows a new frame; on the capture page keep a recent snapshot so
  // a decode error (element already blank) still has a frame to hold.
  const [periodic] = useState(() => isCapturePage())
  useEffect(() => {
    const video = videoRef.current
    const canvas = coverRef.current
    if (!video || !canvas) return
    let last = -1
    let tick = 0
    const id = window.setInterval(() => {
      const t = video.currentTime
      const advancing = t !== last && t > 0 && !video.paused && video.readyState >= 2 && !video.error
      last = t
      if (coverOn.current && advancing) { coverOn.current = false; canvas.style.visibility = "hidden" }
      if (periodic && onAir && advancing && !coverOn.current && ++tick % 3 === 0) snapshot()
    }, 150)
    return () => window.clearInterval(id)
  }, [periodic, onAir, snapshot])
  // Off air / unloaded: the cover goes with it (the hand-over or the standby card takes over).
  // Not during a re-arm: OBS was kicked on purpose, the cover holds the last frame until it is back.
  useEffect(() => {
    if ((!onAir || (!load && !rearmHold)) && coverRef.current) { coverOn.current = false; coverRef.current.style.visibility = "hidden" }
  }, [onAir, load, rearmHold])
  useCaptureAudioTap(videoRef, source)
  // A held last frame (cover canvas) lets a reconnecting OBS (relay READY, rebuilt player not playing yet)
  // freeze on the last picture instead of the "Waiting for OBS" card.
  const held = onAir && hasHeld
  const natural = programDisplay({ now, activeSince, ready, readyAt, notReadySince, lastFrameAt, held, rearmHold })
  const shown: ProgramDisplay = holdFrame > 0 && natural === "standby" && lastFrameAt !== null && now - lastFrameAt < STALL_HOLD_MS + holdFrame ? "video" : natural
  shownRef.current = shown
  // Holding with no frame in the element yet: put the last frame on top (hidden again by the first new frame).
  const holding = shown === "video" && lastFrameAt === null && (load || rearmHold)
  useEffect(() => { if (holding) showCover() }, [holding, showCover])
  // Dropout log: one line per re-arm hold on the input on air.
  const rearmOnAir = rearmHold && onAir && active
  useEffect(() => {
    if (!rearmOnAir) return
    playerDiag("·", lastFrameAt !== null || held ? `holding last frame during re-arm (${label} on air; disarm/arm kicked OBS on purpose: no "Waiting for OBS" for up to 15s)` : `re-arm in progress but no last frame of ${label} to hold (normal rules)`)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per hold start
  }, [rearmOnAir])
  useEffect(() => {
    if (showing.current === shown) return
    const was = showing.current
    showing.current = shown
    onDisplay?.(shown)
    if (!onAir) return
    if (shown === "standby") playerDiag("!", `${label} (on air): "Waiting for OBS" card shown (black screen with text in the output)${ready ? " although the relay says the publisher is there" : ": no publisher for > 3s"}`)
    else if (shown === "video" && was === "standby") playerDiag("+", `${label} (on air): picture back (after "Waiting for OBS")`)
    else if (shown === "video" && active) playerDiag("·", `${label} (on air): program picture up`)
  }, [shown, onDisplay, onAir, label, ready, active])
  // Frozen picture on air (no new frame for > 0.7s while the program is shown): onset and duration.
  const frozenSince = useRef<number | null>(null)
  useEffect(() => {
    if (!onAir || !active || shown !== "video" || hold || lastFrameAt === null) { frozenSince.current = null; return }
    const gap = now - lastFrameAt
    if (gap > 700 && frozenSince.current === null) { frozenSince.current = lastFrameAt; playerDiag("!", `${label} (on air): picture frozen (no new frame for ${(gap / 1000).toFixed(1)}s; the output repeats the last frame)`) }
    else if (gap <= 400 && frozenSince.current !== null) { playerDiag("+", `${label} (on air): picture moving again after ${((lastFrameAt - frozenSince.current) / 1000).toFixed(1)}s frozen`); frozenSince.current = null }
  }, [now, lastFrameAt, onAir, active, shown, hold, label])

  const routed = useRef(programAudio)
  useEffect(() => {
    if (routed.current === programAudio) return
    routed.current = programAudio
    resetViewerChoice()
  }, [programAudio])

  // Silent unless this picture may sound. An unchecked desk box starts silent; Unmute overrides it
  // until the box changes. A hard mute (preview, standby, picture not up) always wins.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const allow = programWantsSound({ active: shown === "video", hardMuted: muted, programAudio, viewerChose: viewerHasChosen(), viewerMuted: isViewerMuted() })
    if (!allow) video.muted = true
    else if (video.muted) {
      video.muted = false
      void video.play().catch(() => {
        // WebKit pauses on a refused unmute: carry on muted.
        video.muted = true
        void video.play().catch(() => undefined)
      })
    }
  }, [shown, muted, programAudio])

  const playing = lastFrameAt !== null && now - lastFrameAt < 1000
  // Real frames only: a watchdog rebuild holds lastFrameAt but must not make a stuck input look alive.
  const alive = realFrameAt !== null && now - realFrameAt < 700 && ready
  useEffect(() => { onAlive?.(alive) }, [alive, onAlive])
  const visual: ProgramDisplay = incoming ? "under" : shown
  const hardMute = muted || shown !== "video"
  return (
    <div data-testid={onAir ? "program-feed" : "program-feed-standby"} data-source={source} data-display={visual} data-loaded={load ? "1" : "0"} data-playing={playing ? "1" : "0"} data-latency-ms={latency ?? ""} data-hard-mute={hardMute ? "1" : "0"} data-want-sound={maySound() ? "1" : "0"} aria-hidden={visual === "under"} className={`fixed inset-0 bg-black transition-opacity duration-300 ${visual === "under" ? "pointer-events-none opacity-0" : `${onAir ? "z-[5]" : "z-[6]"} opacity-100`}`}>
      <video ref={videoRef} className="h-full w-full object-contain" autoPlay playsInline muted disablePictureInPicture />
      <canvas ref={coverRef} data-testid="program-cover" aria-hidden className="pointer-events-none absolute inset-0 h-full w-full object-contain" style={{ visibility: "hidden" }} />
      {visual === "standby" ? <Standby /> : null}
    </div>
  )
}

/**
 * Operator preview of the OBS feed (desk hero, deck, Relay card): muted by default, with a sound toggle,
 * volume and a live level meter (WebAudio analyser on the player), remembered per device and per place.
 * Browsers only allow sound after a tap: the first tap anywhere on the page (or on the button) turns it on
 * when the saved choice is "unmuted".
 */
export function ProgramPlayer({ src = PROGRAM_OPERATOR_SRC, ready, rearmHoldMs, scope, className = "" }: { src?: string; ready?: boolean; /** ms left of a disarm/arm cycle (deck state); polled with `ready` when not given */ rearmHoldMs?: number; scope: string; className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const now = useNow(200)
  const polled = usePolledReady(ready === undefined)
  const isReady = ready ?? polled.ready
  const { notReadySince, readyAt } = useReadiness(isReady, now)
  const activeSince = useActiveSince(true, now)
  // Re-arm (auto or Disarm → Arm): OBS kicked on purpose. Keep the player and its last frame
  // ("reconnecting…" badge) instead of the "Waiting for OBS" card, ≤ 15s.
  const holdUntil = useHoldUntil(ready === undefined ? polled.rearmHoldMs : rearmHoldMs, now)
  const rearmHold = holdUntil !== null && now < holdUntil
  const load = keepLoaded(isReady, notReadySince, now) || rearmHold
  // One user-owned mute state per player (scope); never reset by Main↔Backup, remounts or the WebRTC→HLS swap.
  const audio = usePreviewAudio(videoRef, scope)
  const { pref, audioOn, db } = audio
  // Fast preview: WebRTC (picture only) in its own element on top while muted. Sound on → HLS loads
  // underneath (this element carries the WebAudio graph), and WebRTC closes once HLS has a frame.
  // Sticky: muting again stays on HLS for this player (no swap back mid-session).
  const whepPath = whepPathFromHls(src)
  const rtcRef = useRef<HTMLVideoElement>(null)
  const [stickyHls, setStickyHls] = useState(false)
  if (!pref.muted && !stickyHls) setStickyHls(true)
  const wantHls = stickyHls || !pref.muted
  const [rtcFailedSeen, setRtcFailedSeen] = useState(false)
  const hlsLoad = load && (whepPath === null || wantHls || rtcFailedSeen)
  const { lastFrameAt: hlsFrameAt, latency } = useProgramHls(videoRef, src, hlsLoad, audio.wantSound, { stallEvents: false, gentle: audio.muteOnly })
  const hlsPlaying = hlsFrameAt !== null && now - hlsFrameAt < 1000
  // Once HLS has taken over with sound, WebRTC stays closed for this source: re-opening it on every
  // short HLS gap swapped the picture back and forth (churn on the deck).
  const [retiredFor, setRetiredFor] = useState<string | null>(null)
  if (wantHls && hlsPlaying && retiredFor !== src) setRetiredFor(src)
  const rtcRetired = retiredFor === src
  const rtc = useWhep(rtcRef, whepPath, load && whepPath !== null && !rtcRetired && !(wantHls && hlsPlaying))
  if (rtc.failed !== rtcFailedSeen) setRtcFailedSeen(rtc.failed)
  const showRtc = whepPath !== null && !rtcRetired && !rtc.failed && rtc.lastFrameAt !== null && !(hlsLoad && hlsPlaying)
  const lastFrameAt = Math.max(hlsFrameAt ?? -1, rtc.lastFrameAt ?? -1) >= 0 ? Math.max(hlsFrameAt ?? -1, rtc.lastFrameAt ?? -1) : null
  void activeSince; void readyAt
  const shown = previewDisplay({ now, ready: isReady, notReadySince, lastFrameAt, rearmHold })
  const chrome = useAutoHide()

  // The WebRTC element never carries sound: keep it muted whatever happens.
  useEffect(() => { if (rtcRef.current) rtcRef.current.muted = true })
  const playing = lastFrameAt !== null && now - lastFrameAt < 1000
  return (
    <div data-testid={`program-player-${scope}`} data-display={shown} data-playing={playing ? "1" : "0"} data-latency-ms={latency ?? ""} data-audio={audioOn ? (pref.muted ? "muted" : "on") : "off"} data-level-db={db ?? ""} {...chrome.bind} className={`absolute inset-0 ${className}`}>
      <div className="absolute inset-0 bg-black">
        <video ref={videoRef} data-active={showRtc ? undefined : "1"} className="pointer-events-none absolute inset-0 h-full w-full object-contain" autoPlay playsInline muted disablePictureInPicture {...{ "webkit-playsinline": "true" }} />
        {whepPath !== null ? <video ref={rtcRef} data-active={showRtc ? "1" : undefined} data-testid={`program-rtc-${scope}`} className={`pointer-events-none absolute inset-0 h-full w-full object-contain ${showRtc ? "" : "invisible"}`} autoPlay playsInline muted disablePictureInPicture {...{ "webkit-playsinline": "true" }} /> : null}
        {shown === "standby" ? <Standby small /> : <PreviewBadge idle={chrome.idle} mode={whepPath === null ? null : showRtc ? "webrtc" : hlsPlaying ? "hls" : null} />}
        {shown === "reconnecting" || (shown === "connecting" && lastFrameAt === null && load) ? <span data-testid={`program-reconnecting-${scope}`} className="pointer-events-none absolute top-1.5 right-1.5 z-10 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white/80">{shown === "connecting" ? "connecting…" : "reconnecting…"}</span> : null}
      </div>
      <AudioBar audio={audio} scope={scope} shown={chrome.shown} label="Program preview" />
    </div>
  )
}

/** A "ms left" value from the server → the local time it ends (re-anchored whenever a new value arrives). */
function useHoldUntil(ms: number | undefined, now: number): number | null {
  const [seen, setSeen] = useState<{ ms: number | undefined; until: number | null }>({ ms: undefined, until: null })
  const until = ms !== undefined && ms > 0 ? now + ms : null
  if (seen.ms !== ms) setSeen({ ms, until })
  return seen.ms === ms ? seen.until : until
}

/** Desk previews have no deck socket: ask the (operator-readable) public state whether OBS is sending (and whether a re-arm is in progress). */
function usePolledReady(enabled: boolean) {
  const [state, setState] = useState<{ ready: boolean; rearmHoldMs: number }>({ ready: false, rearmHoldMs: 0 })
  useEffect(() => {
    if (!enabled) return
    let stop = false
    const poll = () => fetch("/api/public/state", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((body: { programReady?: unknown; rearmHoldMs?: unknown } | null) => {
      if (stop) return
      const next = { ready: body?.programReady === true, rearmHoldMs: typeof body?.rearmHoldMs === "number" ? body.rearmHoldMs : 0 }
      setState((cur) => (cur.ready === next.ready && cur.rearmHoldMs === next.rearmHoldMs ? cur : next))
    }).catch(() => undefined)
    void poll()
    const id = window.setInterval(poll, 1500)
    return () => { stop = true; window.clearInterval(id) }
  }, [enabled])
  return state
}
