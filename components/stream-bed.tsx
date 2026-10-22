"use client"
/**
 * /stream in-page bed (Stream audio routing "bed/tone"): the capture channel's tone or playlist,
 * same order and volume. Quiet while raw program audio is actually playing, or while the viewer has muted.
 */
import { useEffect, useRef, useState } from "react"
import { bedGainMuted, subscribeViewerMute, viewerHasChosen, isViewerMuted } from "@/components/stream-audio-overlay"

export type StreamBedPlan = { mode: string; files: string[]; shuffle: boolean; volumeDb: number; toneHz: number; toneDb: number; fadeInSec: number } | null

export const dbToGain = (db: number) => Math.max(0, Math.min(1, 10 ** (db / 20)))
/** Next playlist index (in order, or a different random one when shuffling). */
export function nextIndex(i: number, n: number, shuffle: boolean, rnd = Math.random): number {
  if (n <= 1) return 0
  if (!shuffle) return (i + 1) % n
  const j = Math.floor(rnd() * (n - 1))
  return j >= i ? j + 1 : j
}

export function StreamBed({ plan, urlMute = false, screenIsProgram = false, programAudio = true, muted = false, hold = false, viewKey }: { plan: StreamBedPlan; urlMute?: boolean; screenIsProgram?: boolean; programAudio?: boolean; /** @deprecated prefer urlMute + screenIsProgram + programAudio */ muted?: boolean; /** Pause the bed (showreel video); resumes when cleared. */ hold?: boolean; viewKey: string }) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [, setPin] = useState(0)
  useEffect(() => subscribeViewerMute(() => setPin((n) => n + 1)), [])
  const quiet = muted || bedGainMuted({ urlMute, screenIsProgram, programAudio, viewerChose: viewerHasChosen(), viewerMuted: isViewerMuted() })
  const index = useRef(0)
  const tone = useRef<{ ctx: AudioContext; gain: GainNode } | null>(null)
  const files = plan?.mode === "bed" ? plan.files : []
  const filesKey = files.join(",")
  const q = viewKey ? `?k=${encodeURIComponent(viewKey)}` : ""

  // Playlist
  useEffect(() => {
    const el = audio.current
    if (!el || !filesKey) return
    const list = filesKey.split(",")
    index.current = plan?.shuffle ? Math.floor(Math.random() * list.length) : 0
    const play = () => { el.src = `/api/audio/stream/${list[index.current]}${q}`; void el.play().catch(() => undefined) }
    const ended = () => { index.current = nextIndex(index.current, list.length, plan?.shuffle === true); play() }
    el.addEventListener("ended", ended)
    play()
    // Autoplay blocked (interactive viewer): start on the first gesture.
    const kick = () => { if (el.paused) void el.play().catch(() => undefined) }
    window.addEventListener("pointerdown", kick)
    return () => { el.removeEventListener("ended", ended); window.removeEventListener("pointerdown", kick); el.pause(); el.removeAttribute("src") }
  }, [filesKey, plan?.shuffle, q])

  // Tone
  useEffect(() => {
    if (plan?.mode !== "tone") return
    const ctx = new AudioContext()
    const osc = ctx.createOscillator(); osc.frequency.value = plan.toneHz
    const gain = ctx.createGain(); gain.gain.value = 0
    osc.connect(gain).connect(ctx.destination); osc.start()
    tone.current = { ctx, gain }
    const kick = () => void ctx.resume()
    window.addEventListener("pointerdown", kick)
    void ctx.resume()
    return () => { window.removeEventListener("pointerdown", kick); tone.current = null; void ctx.close() }
  }, [plan?.mode, plan?.toneHz])

  // Volume + mute (duck to silence while the program is on air), with a short ramp.
  const vol = plan ? dbToGain(plan.mode === "tone" ? plan.toneDb + plan.volumeDb : plan.volumeDb) : 0
  useEffect(() => {
    const target = quiet ? 0 : vol
    if (audio.current) audio.current.volume = target
    const t = tone.current
    if (t) t.gain.gain.setTargetAtTime(target, t.ctx.currentTime, 0.1)
  }, [quiet, vol, plan?.mode])

  // Hold: pause the playlist (and silence the tone) while a showreel video is on air; resume after.
  useEffect(() => {
    const el = audio.current
    if (hold) {
      if (el && !el.paused) el.pause()
      const t = tone.current
      if (t) t.gain.gain.setTargetAtTime(0, t.ctx.currentTime, 0.05)
      return
    }
    if (el && el.src && el.paused && !quiet) void el.play().catch(() => undefined)
  }, [hold, quiet])

  if (!plan || plan.mode === "silent") return null
  return <audio ref={audio} data-testid="stream-bed" data-hold={hold ? "1" : "0"} hidden preload="auto" />
}
