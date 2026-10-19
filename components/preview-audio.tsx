"use client"
/**
 * One audio bar for every operator preview (program Main/Backup, /capture, /slate, /vertical; desk and
 * deck): Mute/Unmute, volume, live level meter. The element's own `muted` is the real mute (iOS plays
 * native HLS outside WebAudio, so a gain node alone can't silence it); WebAudio only feeds the meter
 * and the volume where the browser routes it.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { controlsClass } from "@/components/auto-hide"
import { DEFAULT_PREF, elementMuted, muteOnlyAudio, nextPref, parsePref, type AudioEvent, type AudioPref } from "@/lib/preview-audio"

const key = (scope: string) => `program-audio:${scope}`
function readPref(scope: string): AudioPref {
  try { return parsePref(JSON.parse(window.localStorage.getItem(key(scope)) ?? "null")) } catch { return DEFAULT_PREF }
}

function detectMuteOnly(scope: string): boolean {
  if (typeof window === "undefined") return true
  return muteOnlyAudio({ ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false, deck: scope.endsWith("deck") })
}

export function usePreviewAudio(videoRef: RefObject<HTMLVideoElement | null>, scope: string) {
  // Decided once per player: never attach WebAudio on iOS/touch/deck (element.muted only).
  const [muteOnly] = useState(() => detectMuteOnly(scope))
  const [pref, setPrefState] = useState<AudioPref>(() => (typeof window === "undefined" ? DEFAULT_PREF : readPref(scope)))
  const prefRef = useRef(pref)
  const graph = useRef<{ ctx: AudioContext; gain: GainNode; analyser: AnalyserNode; el: HTMLVideoElement } | null>(null)
  const [audioOn, setAudioOn] = useState(false)
  const audioOnRef = useRef(false)
  const [level, setLevel] = useState<number | null>(null)

  /** Apply the state to the element (and gain) right now. */
  const apply = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const muted = elementMuted({ pref: prefRef.current, audioOn: audioOnRef.current, audioElement: true, pageVisible: document.visibilityState === "visible" })
    if (video.muted !== muted) video.muted = muted
    if (graph.current) graph.current.gain.gain.value = muted ? 0 : prefRef.current.volume
    else if (!muteOnly && video.volume !== prefRef.current.volume) video.volume = prefRef.current.volume
    if (!muted && video.paused) void video.play().catch(() => { video.muted = true })
  }, [videoRef, muteOnly])

  const dispatch = useCallback((e: AudioEvent) => {
    const next = nextPref(prefRef.current, e)
    if (next === prefRef.current) return
    prefRef.current = next
    setPrefState(next)
    try { window.localStorage.setItem(key(scope), JSON.stringify(next)) } catch { /* private mode */ }
  }, [scope])

  const buildGraph = useCallback(() => {
    const video = videoRef.current
    if (muteOnly || !video || graph.current?.el === video) return
    try {
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
      graph.current = { ctx, gain, analyser, el: video }
    } catch { /* no WebAudio: element mute/volume only */ }
  }, [videoRef, muteOnly])

  /** Inside a user gesture: start sound (iOS/WebKit need the gesture), then apply mute/volume. */
  const enable = useCallback(() => {
    buildGraph()
    void graph.current?.ctx.resume().catch(() => undefined)
    audioOnRef.current = true
    setAudioOn(true)
    apply()
  }, [buildGraph, apply])

  const toggle = () => { dispatch({ type: "toggle" }); enable() }
  const setVolume = (v: number) => { dispatch({ type: "volume", volume: v }); enable() }

  // Saved "unmuted": turn sound on at the first tap/key anywhere (browsers need a gesture).
  useEffect(() => {
    if (pref.muted || audioOn) return
    const once = () => enable()
    document.addEventListener("pointerdown", once, { once: true, capture: true })
    document.addEventListener("keydown", once, { once: true, capture: true })
    return () => {
      document.removeEventListener("pointerdown", once, { capture: true })
      document.removeEventListener("keydown", once, { capture: true })
    }
  }, [pref.muted, audioOn, enable])

  useEffect(() => { apply() }, [pref, audioOn, apply])

  // Background / standby / other app: mute (saved), stop the meter's AudioContext. Back: stays muted.
  useEffect(() => {
    const onVis = (e: Event) => {
      if (e.type !== "pagehide" && document.visibilityState === "visible") return
      dispatch({ type: "hidden" })
      const video = videoRef.current
      if (video) video.muted = true
      void graph.current?.ctx.suspend().catch(() => undefined)
    }
    document.addEventListener("visibilitychange", onVis)
    window.addEventListener("pagehide", onVis)
    // Don't register as a media session (iOS Now Playing would keep it alive).
    try { if ("mediaSession" in navigator) navigator.mediaSession.metadata = null } catch { /* unsupported */ }
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("pagehide", onVis) }
  }, [dispatch, videoRef])

  // Meter: peak before the volume, ~10 updates/s, only while sound is on.
  useEffect(() => {
    if (!audioOn || pref.muted) return
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
  }, [audioOn, pref.muted])

  useEffect(() => () => { void graph.current?.ctx.close().catch(() => undefined) }, [])

  const db = level === null || !audioOn || pref.muted ? null : Math.max(-60, Math.round(level))
  /** For players' own loops: should the element be audible right now? */
  const wantSound = useCallback(() => !elementMuted({ pref: prefRef.current, audioOn: audioOnRef.current, audioElement: true, pageVisible: document.visibilityState === "visible" }), [])
  return { muteOnly, pref, audioOn, db, needsTap: !pref.muted && !audioOn, toggle, setVolume, wantSound, apply }
}

export function AudioBar({ audio, scope, shown, label = "Preview" }: { audio: ReturnType<typeof usePreviewAudio>; scope: string; shown: boolean; label?: string }) {
  const { pref, audioOn, db, needsTap, muteOnly } = audio
  const pct = db === null ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  return (
    <div
      data-autohide-control
      data-testid={`program-controls-${scope}`}
      className={`absolute right-1.5 bottom-1.5 left-1.5 z-10 flex items-center gap-2 rounded-lg bg-black/70 px-2 py-1 font-mono text-[11px] text-white ${controlsClass(shown || needsTap)}`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button type="button" data-testid={`program-audio-toggle-${scope}`} aria-pressed={!pref.muted} onClick={audio.toggle} className={`min-h-7 shrink-0 rounded-md px-2 font-bold ${needsTap ? "animate-pulse bg-[#D9FF43] text-black" : pref.muted ? "bg-white/15" : "bg-[#128a3e]"}`}>
        {needsTap ? "Tap for sound" : pref.muted ? "🔇 Unmute" : "🔊 Mute"}
      </button>
      {muteOnly ? null : <>
      <input type="range" aria-label={`${label} volume`} data-testid={`program-audio-volume-${scope}`} min={0} max={1} step={0.05} value={pref.volume} onChange={(event) => audio.setVolume(Number(event.target.value))} className="h-1 w-16 min-w-0 shrink accent-[#D9FF43]" />
      <span className="relative h-2 min-w-6 flex-1 overflow-hidden rounded-full bg-white/15" title={`${label} audio level`}>
        <span data-testid={`program-audio-meter-${scope}`} className={`absolute inset-y-0 left-0 rounded-full ${db !== null && db > -6 ? "bg-[#ff3c00]" : "bg-[#D9FF43]"}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="w-14 shrink-0 text-right tabular-nums text-white/80">{audioOn && !pref.muted ? (db === null || db <= -60 ? "silent" : `${db} dB`) : "muted"}</span>
      </>}
    </div>
  )
}
