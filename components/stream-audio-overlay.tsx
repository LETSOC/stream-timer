"use client"
/**
 * /stream opened directly in a browser: a small unmute / volume / level overlay for the program audio.
 * Never for OBS (Browser Source UA "OBS"/obsstudio, or ?k= view-key URL), Browser capture / headless
 * (navigator.webdriver), embedded previews (iframe, ?mute=1). ?controls=1 forces it; ?controls=0 hides it.
 * Appears on mouse move / tap, auto-hides after 3s.
 */
import { useEffect, useRef, useState } from "react"

export function interactiveViewer(input: { search: string; ua: string; webdriver: boolean; framed: boolean }): boolean {
  const q = new URLSearchParams(input.search)
  if (q.get("controls") === "1") return true
  if (q.get("controls") === "0") return false
  if (input.webdriver || input.framed || /\bOBS\b|obsstudio|obs-browser/i.test(input.ua)) return false
  if (q.has("k") || q.has("obs") || q.get("mute") === "1" || q.has("capture")) return false
  return true
}

/** The viewer's own Mute (overlay): the on-air player's watchdog must not unmute it again. */
let viewerMuted = false
export const isViewerMuted = () => viewerMuted
const PREF = "stream-audio-overlay"
const sources = new WeakMap<HTMLVideoElement, { ctx: AudioContext; analyser: AnalyserNode }>()

export function StreamAudioOverlay() {
  const [allowed, setAllowed] = useState(false)
  const [shown, setShown] = useState(false)
  const [muted, setMuted] = useState(true)
  const [volume, setVolume] = useState(1)
  const [db, setDb] = useState<number | null>(null)
  const hideAt = useRef(0)
  const wantSound = useRef(false)
  const userSet = useRef(false)

  useEffect(() => {
    const ok = interactiveViewer({ search: window.location.search, ua: navigator.userAgent, webdriver: navigator.webdriver === true, framed: window.top !== window })
    let saved = 1
    try { saved = Number(JSON.parse(localStorage.getItem(PREF) ?? "{}").volume ?? 1) } catch { /* */ }
    queueMicrotask(() => { setAllowed(ok); setVolume(Number.isFinite(saved) ? saved : 1) })
    if (!ok) return
    const wake = () => { hideAt.current = Date.now() + 3000; setShown(true) }
    window.addEventListener("mousemove", wake)
    window.addEventListener("pointerdown", wake)
    window.addEventListener("keydown", wake)
    const id = window.setInterval(() => {
      if (Date.now() > hideAt.current) setShown(false)
      const video = document.querySelector<HTMLVideoElement>("[data-testid=program-feed] video")
      if (!video) { setDb(null); setMuted(true); return }
      // Keep the on-air player at our volume / mute (it may be rebuilt or switched Main↔Backup).
      video.volume = volumeRef.current
      // After the viewer chose, their choice wins over the player's own autoplay muting.
      if (userSet.current && video.muted === wantSound.current) { video.muted = !wantSound.current; void video.play().catch(() => undefined) }
      setMuted(video.muted)
      const s = sources.get(video)
      if (s) {
        const buf = new Float32Array(s.analyser.fftSize)
        s.analyser.getFloatTimeDomainData(buf)
        let peak = 0
        for (const v of buf) peak = Math.max(peak, Math.abs(v))
        setDb(peak > 0 ? 20 * Math.log10(peak) : -90)
      }
    }, 150)
    return () => {
      window.removeEventListener("mousemove", wake)
      window.removeEventListener("pointerdown", wake)
      window.removeEventListener("keydown", wake)
      window.clearInterval(id)
    }
  }, [])
  const volumeRef = useRef(volume)
  useEffect(() => {
    volumeRef.current = volume
    try { localStorage.setItem(PREF, JSON.stringify({ volume })) } catch { /* */ }
  }, [volume])

  if (!allowed) return null
  const toggle = () => {
    // Runs inside the click: browsers allow unmuting (and AudioContext) only from a user gesture.
    const video = document.querySelector<HTMLVideoElement>("[data-testid=program-feed] video")
    wantSound.current = muted
    userSet.current = true
    viewerMuted = !muted
    if (!video) return
    if (muted) {
      video.muted = false
      void video.play().catch(() => undefined)
      if (!sources.has(video)) {
        try {
          const ctx = new AudioContext()
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 1024
          ctx.createMediaElementSource(video).connect(analyser)
          analyser.connect(ctx.destination)
          sources.set(video, { ctx, analyser })
        } catch (e) { console.warn("[audio overlay] meter unavailable:", e) }
      }
      void sources.get(video)?.ctx.resume()
    } else video.muted = true
    setMuted(video.muted)
  }
  const pct = db === null || muted ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  return (
    <div data-testid="stream-audio-overlay" data-shown={shown ? "1" : "0"} className={`fixed right-4 bottom-4 z-[50] flex items-center gap-3 rounded-full bg-black/70 px-4 py-2 font-mono text-[13px] text-white transition-opacity duration-300 ${shown ? "opacity-100" : "pointer-events-none opacity-0"}`} onMouseEnter={() => { hideAt.current = Date.now() + 3000 }}>
      <button type="button" data-testid="stream-audio-toggle" onClick={toggle} className="rounded-full bg-white/15 px-3 py-1">{muted ? "🔇 Unmute" : "🔊 Mute"}</button>
      <input type="range" aria-label="Volume" data-testid="stream-audio-volume" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-24" />
      <span aria-label="Level" data-testid="stream-audio-level" data-db={db === null ? "" : db.toFixed(0)} className="relative h-2 w-20 overflow-hidden rounded bg-white/20"><span className="absolute inset-y-0 left-0 bg-[#12b76a]" style={{ width: `${pct}%` }} /></span>
    </div>
  )
}
