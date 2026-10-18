"use client"

import { isViewerMuted } from "@/components/stream-audio-overlay"
import { stallBackoffMs, useResumeGeneration } from "@/lib/use-resume"
import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import type Hls from "hls.js"
import { PreviewBadge } from "@/components/preview-badge"
import { whepPathFromHls } from "@/lib/whep-client"
import { useWhep } from "@/lib/use-whep"
import { keepLoaded, previewDisplay, programDisplay, STALL_HOLD_MS, type ProgramDisplay } from "@/lib/program-display"

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
function useProgramHls(videoRef: RefObject<HTMLVideoElement | null>, src: string, load: boolean, wantSound: () => boolean) {
  const hlsRef = useRef<Hls | null>(null)
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null)
  const [latency, setLatency] = useState<number | null>(null)
  const wantSoundRef = useRef(wantSound)
  useEffect(() => {
    wantSoundRef.current = wantSound
  })
  // Rebuild the player (not the page) when the page comes back (iOS suspends media in the
  // background) and when the watchdog finds it stuck while OBS is publishing.
  // Back from the background: rebuild, holding the last picture meanwhile (not "Waiting for OBS").
  const resumeGen = useResumeGeneration(1000, () => setLastFrameAt((at) => (at === null ? null : Date.now())))
  const [kick, setKick] = useState(0)
  useEffect(() => {
    const video = videoRef.current
    if (!video || !load) return
    let hls: Hls | null = null
    let cancelled = false
    // React doesn't reliably apply the `muted` attribute (WebKit): set the property before anything plays.
    video.muted = !wantSoundRef.current()
    const play = () => {
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
        // Native HLS (iOS): cache-bust so Safari doesn't resume a dead suspended session.
        video.src = `${src}${src.includes("?") ? "&" : "?"}r=${Date.now().toString(36)}`
        play()
      }
    })()
    return () => {
      cancelled = true
      hlsRef.current = null
      hls?.destroy()
      video.removeAttribute("src")
      video.load()
    }
  }, [videoRef, src, load, resumeGen, kick])
  // Only a real unload (other source, OBS gone) forgets the last frame; a rebuild keeps it so the
  // picture holds instead of flashing "Waiting for OBS".
  useEffect(() => () => {
    setLastFrameAt(null)
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
    const onStall = () => { if (Date.now() - advancedAt > 3000 && Date.now() >= nextKickAt) reload() }
    const reload = () => {
      nextKickAt = Date.now() + stallBackoffMs(++attempt)
      advancedAt = Date.now()
      setLastFrameAt((at) => (at === null ? null : Date.now())) // hold the picture while it reloads
      setKick((k) => k + 1)
    }
    video.addEventListener("stalled", onStall)
    video.addEventListener("waiting", onStall)
    video.addEventListener("error", onStall)
    const id = window.setInterval(() => {
      const t = video.currentTime
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
        setLastFrameAt(Date.now())
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
    }
  }, [videoRef, load])
  return { lastFrameAt, latency }
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

export function ProgramFeed({ ready, active, muted = false, onDisplay, source = "main", path = "program", onAir = true, holdFrame = 0, incoming = false }: { /** a hand-over target: plays (silent, invisible) to fill its buffer; never shows its standby */ incoming?: boolean; ready: boolean; active: boolean; muted?: boolean; onDisplay?: (display: ProgramDisplay) => void; source?: "main" | "backup"; path?: string; /** the input on air (Browser capture reads its latency/source); the other one is prewarmed */ onAir?: boolean; /** extra ms to freeze on the last frame instead of "Waiting for OBS" (a Main/Backup hand-over may be coming) */ holdFrame?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const now = useNow(200)
  const { notReadySince, readyAt } = useReadiness(ready, now)
  const activeSince = useActiveSince(active, now)
  const load = keepLoaded(ready, notReadySince, now)
  const showing = useRef<ProgramDisplay>("under")
  const { lastFrameAt, latency } = useProgramHls(videoRef, programViewSrc(path), load, () => active && !muted && !isViewerMuted())
  useCaptureAudioTap(videoRef, source)
  const natural = programDisplay({ now, activeSince, ready, readyAt, notReadySince, lastFrameAt })
  const shown: ProgramDisplay = holdFrame > 0 && natural === "standby" && lastFrameAt !== null && now - lastFrameAt < STALL_HOLD_MS + holdFrame ? "video" : natural
  useEffect(() => {
    if (showing.current === shown) return
    showing.current = shown
    onDisplay?.(shown)
  }, [shown, onDisplay])

  // Silent unless it is the picture on air.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (shown !== "video" || muted) video.muted = true
    else if (video.muted) {
      video.muted = false
      void video.play().catch(() => {
        // WebKit pauses on a refused unmute: carry on muted.
        video.muted = true
        void video.play().catch(() => undefined)
      })
    }
  }, [shown, muted])

  const playing = lastFrameAt !== null && now - lastFrameAt < 1000
  const visual: ProgramDisplay = incoming ? "under" : shown
  return (
    <div data-testid={onAir ? "program-feed" : "program-feed-standby"} data-source={source} data-display={visual} data-loaded={load ? "1" : "0"} data-playing={playing ? "1" : "0"} data-latency-ms={latency ?? ""} data-want-sound={shown === "video" && !muted ? "1" : "0"} aria-hidden={visual === "under"} className={`fixed inset-0 bg-black transition-opacity duration-300 ${visual === "under" ? "pointer-events-none opacity-0" : `${onAir ? "z-[5]" : "z-[6]"} opacity-100`}`}>
      <video ref={videoRef} className="h-full w-full object-contain" autoPlay playsInline muted disablePictureInPicture />
      {visual === "standby" ? <Standby /> : null}
    </div>
  )
}

type AudioPref = { muted: boolean; volume: number }
function readPref(scope: string): AudioPref {
  try {
    const raw = JSON.parse(window.localStorage.getItem(`program-audio:${scope}`) ?? "null") as Partial<AudioPref> | null
    if (raw && typeof raw.muted === "boolean" && typeof raw.volume === "number") return { muted: raw.muted, volume: Math.min(1, Math.max(0, raw.volume)) }
  } catch { /* default */ }
  return { muted: true, volume: 0.8 }
}

/**
 * Operator preview of the OBS feed (desk hero, deck, Relay card): muted by default, with a sound toggle,
 * volume and a live level meter (WebAudio analyser on the player), remembered per device and per place.
 * Browsers only allow sound after a tap: the first tap anywhere on the page (or on the button) turns it on
 * when the saved choice is "unmuted".
 */
export function ProgramPlayer({ src = PROGRAM_OPERATOR_SRC, ready, scope, className = "" }: { src?: string; ready?: boolean; scope: string; className?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const now = useNow(200)
  const polled = usePolledReady(ready === undefined)
  const isReady = ready ?? polled
  const { notReadySince, readyAt } = useReadiness(isReady, now)
  const activeSince = useActiveSince(true, now)
  const load = keepLoaded(isReady, notReadySince, now)
  const [pref, setPrefState] = useState<AudioPref>(() => (typeof window === "undefined" ? { muted: true, volume: 0.8 } : readPref(scope)))
  const prefRef = useRef(pref)
  const setPref = (next: AudioPref) => {
    prefRef.current = next
    setPrefState(next)
    try { window.localStorage.setItem(`program-audio:${scope}`, JSON.stringify(next)) } catch { /* private mode */ }
  }
  const graph = useRef<{ ctx: AudioContext; gain: GainNode; analyser: AnalyserNode } | null>(null)
  const [audioOn, setAudioOn] = useState(false)
  const [level, setLevel] = useState<number | null>(null)
  const audioOnRef = useRef(false)
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
  const { lastFrameAt: hlsFrameAt, latency } = useProgramHls(videoRef, src, hlsLoad, () => audioOnRef.current)
  const hlsPlaying = hlsFrameAt !== null && now - hlsFrameAt < 1000
  const rtc = useWhep(rtcRef, whepPath, load && whepPath !== null && !(wantHls && hlsPlaying))
  if (rtc.failed !== rtcFailedSeen) setRtcFailedSeen(rtc.failed)
  const showRtc = whepPath !== null && !rtc.failed && rtc.lastFrameAt !== null && !(hlsLoad && hlsPlaying)
  const lastFrameAt = Math.max(hlsFrameAt ?? -1, rtc.lastFrameAt ?? -1) >= 0 ? Math.max(hlsFrameAt ?? -1, rtc.lastFrameAt ?? -1) : null
  void activeSince; void readyAt
  const shown = previewDisplay({ now, ready: isReady, notReadySince, lastFrameAt })

  /** element → analyser → gain → speakers, gain 0 until sound is on (the gain node is the real mute). */
  const buildGraph = useCallback(() => {
    const video = videoRef.current
    if (!video || graph.current) return
    try {
      {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new Ctx()
        const source = ctx.createMediaElementSource(video)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        const gain = ctx.createGain()
        gain.gain.value = 0
        source.connect(analyser)
        analyser.connect(gain)
        gain.connect(ctx.destination)
        graph.current = { ctx, gain, analyser }
      }
    } catch { /* no WebAudio: element mute only */ }
  }, [])
  // After the page has had a tap the context starts running at once (gain 0 until the saved choice says otherwise).
  // Before that, wait for the gesture: a suspended context can stall the element in WebKit.
  useEffect(() => {
    if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) buildGraph()
  }, [buildGraph])

  /** Must run inside a user gesture: resumes the context, applies mute/volume and unmutes the element. */
  const enableAudio = useCallback(() => {
    const video = videoRef.current
    if (!video) return false
    buildGraph()
    try {
      if (!graph.current) return false
      const { ctx, gain } = graph.current
      void ctx.resume()
      gain.gain.value = prefRef.current.muted ? 0 : prefRef.current.volume
      // The element itself plays unmuted into the graph; the gain node is the real mute/volume.
      video.muted = false
      video.volume = 1
      void video.play().catch(() => undefined)
      audioOnRef.current = true
      setAudioOn(true)
      return true
    } catch {
      return false
    }
  }, [buildGraph])

  // Saved "unmuted": turn sound on at the first tap/key anywhere (browsers need a gesture).
  useEffect(() => {
    if (pref.muted || audioOn) return
    const once = () => enableAudio()
    document.addEventListener("pointerdown", once, { once: true, capture: true })
    document.addEventListener("keydown", once, { once: true, capture: true })
    return () => {
      document.removeEventListener("pointerdown", once, { capture: true })
      document.removeEventListener("keydown", once, { capture: true })
    }
  }, [pref.muted, audioOn, enableAudio])

  useEffect(() => {
    const g = graph.current
    if (g) g.gain.gain.value = audioOn && !pref.muted ? pref.volume : 0
  }, [pref, audioOn])

  // Meter: peak of the program audio (before the volume, so it moves while muted too), ~10 updates/s.
  useEffect(() => {
    if (!audioOn) return
    const g = graph.current
    if (!g) return
    const data = new Float32Array(g.analyser.fftSize)
    let raf = 0
    let lastSet = 0
    const tick = (t: number) => {
      raf = window.requestAnimationFrame(tick)
      if (t - lastSet < 100) return
      lastSet = t
      g.analyser.getFloatTimeDomainData(data)
      let peak = 0
      for (const v of data) peak = Math.max(peak, Math.abs(v))
      setLevel(peak > 0.00001 ? 20 * Math.log10(peak) : -100)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [audioOn])

  useEffect(() => () => { void graph.current?.ctx.close().catch(() => undefined) }, [])

  const toggle = () => {
    const next = { ...pref, muted: !pref.muted }
    setPref(next)
    prefRef.current = next
    enableAudio()
  }
  const db = level === null ? null : Math.max(-60, Math.round(level))
  const pct = db === null ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  const playing = lastFrameAt !== null && now - lastFrameAt < 1000
  const needsTap = !pref.muted && !audioOn
  return (
    <div data-testid={`program-player-${scope}`} data-display={shown} data-playing={playing ? "1" : "0"} data-latency-ms={latency ?? ""} data-audio={audioOn ? (pref.muted ? "muted" : "on") : "off"} data-level-db={db ?? ""} className={`absolute inset-0 ${className}`}>
      <div className="absolute inset-0 bg-black">
        <video ref={videoRef} data-active={showRtc ? undefined : "1"} className="pointer-events-none absolute inset-0 h-full w-full object-contain" autoPlay playsInline muted disablePictureInPicture {...{ "webkit-playsinline": "true" }} />
        {whepPath !== null ? <video ref={rtcRef} data-active={showRtc ? "1" : undefined} data-testid={`program-rtc-${scope}`} className={`pointer-events-none absolute inset-0 h-full w-full object-contain ${showRtc ? "" : "invisible"}`} autoPlay playsInline muted disablePictureInPicture {...{ "webkit-playsinline": "true" }} /> : null}
        {shown === "standby" ? <Standby small /> : <PreviewBadge mode={whepPath === null ? null : showRtc ? "webrtc" : hlsPlaying ? "hls" : null} />}
        {shown === "reconnecting" || (shown === "connecting" && lastFrameAt === null && load) ? <span data-testid={`program-reconnecting-${scope}`} className="pointer-events-none absolute top-1.5 right-1.5 z-10 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white/80">{shown === "connecting" ? "connecting…" : "reconnecting…"}</span> : null}
      </div>
      <div
        className="absolute right-1.5 bottom-1.5 left-1.5 z-10 flex items-center gap-2 rounded-lg bg-black/70 px-2 py-1 font-mono text-[11px] text-white"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <button type="button" data-testid={`program-audio-toggle-${scope}`} aria-pressed={!pref.muted} onClick={toggle} className={`min-h-7 shrink-0 rounded-md px-2 font-bold ${needsTap ? "animate-pulse bg-[#D9FF43] text-black" : pref.muted ? "bg-white/15" : "bg-[#128a3e]"}`}>
          {needsTap ? "Tap for sound" : pref.muted ? "🔇 Unmute" : "🔊 Mute"}
        </button>
        <input type="range" aria-label="Program preview volume" data-testid={`program-audio-volume-${scope}`} min={0} max={1} step={0.05} value={pref.volume} onChange={(event) => { const next = { ...pref, volume: Number(event.target.value) }; setPref(next); prefRef.current = next; enableAudio() }} className="h-1 w-16 min-w-0 shrink accent-[#D9FF43]" />
        <span className="relative h-2 min-w-6 flex-1 overflow-hidden rounded-full bg-white/15" title="Program audio level (before volume)">
          <span data-testid={`program-audio-meter-${scope}`} className={`absolute inset-y-0 left-0 rounded-full ${db !== null && db > -6 ? "bg-[#ff3c00]" : "bg-[#D9FF43]"}`} style={{ width: `${pct}%` }} />
        </span>
        <span className="w-14 shrink-0 text-right tabular-nums text-white/80">{audioOn ? (db === null || db <= -60 ? "silent" : `${db} dB`) : "meter off"}</span>
      </div>
    </div>
  )
}

/** Desk previews have no deck socket: ask the (operator-readable) public state whether OBS is sending. */
function usePolledReady(enabled: boolean) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let stop = false
    const poll = () => fetch("/api/public/state", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((body: { programReady?: unknown } | null) => { if (!stop) setReady(body?.programReady === true) }).catch(() => undefined)
    void poll()
    const id = window.setInterval(poll, 1500)
    return () => { stop = true; window.clearInterval(id) }
  }, [enabled])
  return ready
}
