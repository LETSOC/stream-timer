"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CountdownStage } from "@/components/countdown-stage"
import { EncodedPreview } from "@/components/encoded-preview"
import {
  formatClock,
  pad2,
  remainingUntil,
  wallTimeInZone,
} from "@/lib/countdown"
import { CLOCK_SCALE_RANGE, CLOCK_TEXT_RANGE, clampSize, fitClockScale } from "@/lib/countdown-size"
import { useNow } from "@/lib/use-now"
import { TIME_ZONES, DEFAULT_EVENT } from "@/lib/event"
import { asEventConfig, useStoredEvent } from "@/lib/event-storage"
import { useEncoderToken } from "@/lib/use-encoder-token"
import {
  buildLocalTestCommand,
  buildStreamShellCommand,
} from "@/lib/ffmpeg-command"

export function OperatorConsole() {
  const [event, updateEvent] = useStoredEvent()
  const { name, date, time, endTime, timeZone, venue, rsvpUrl, badge, rsvpLabel, scanLabel, joinLabel, eventLink, eventLinkLabel, xUrl, facebookUrl, linkedinUrl, instagramUrl, youtubeUrl } = event
  const [rtmpUrl, setRtmpUrl] = useState("")
  const [rtmpLive, setRtmpLive] = useState(false)
  const [rtmpReconnecting, setRtmpReconnecting] = useState(false)
  const [rtmpRestarts, setRtmpRestarts] = useState(0)
  const [strayPids, setStrayPids] = useState<number[]>([])
  const [rtmpState, setRtmpState] = useState<"idle" | "live" | "error">("idle")
  const [rtmpMessage, setRtmpMessage] = useState("")
  const [copied, setCopied] = useState<"stream" | "file" | "link" | "params" | null>(null)
  const [checker, setChecker] = useState(6)
  const [showMeta, setShowMeta] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [transparent, setTransparent] = useState(false)
  const [lineSpacing, setLineSpacing] = useState(1.14)
  const [blockGap, setBlockGap] = useState(1.2)
  const [clockScale, setClockScale] = useState(1)
  const [clockText, setClockText] = useState(1)
  const [logoUrl, setLogoUrl] = useState("")
  const [speakers, setSpeakers] = useState<{ image: string; name: string; description: string }[]>([])
  const [gallerySeconds, setGallerySeconds] = useState(4)
  const [galleryPause, setGalleryPause] = useState(6)
  const [galleryOffset, setGalleryOffset] = useState(-86)
  const [galleryScale, setGalleryScale] = useState(80)
  const token = useEncoderToken()
  const [syncState, setSyncState] = useState<"idle" | "saved" | "local" | "error">("idle")
  const [pausedAt, setPausedAt] = useState<Date | null>(null)
  const [skewMs, setSkewMs] = useState(0)
  const [testUntil, setTestUntil] = useState<number | null>(null)
  const [previewFlash, setPreviewFlash] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const previewReady = useRef(false)
  const now = useNow()

  const target = wallTimeInZone(date, time, timeZone)
  const valid = Number.isFinite(target.getTime())
  const targetUnix = valid ? Math.floor(target.getTime() / 1000) : 0
  const remaining = valid && now ? remainingUntil(target, now) : null
  const dateLine = valid
    ? `${new Intl.DateTimeFormat("en-GB", {
        timeZone,
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(target)}  •  ${time}`
    : `${date}  •  ${time}`

  const streamHref = useMemo(() => {
    const params = new URLSearchParams({
      name,
      date,
      time,
      end: endTime,
      tz: timeZone,
      venue,
      rsvp: rsvpUrl,
      badge,
      rsvpLabel,
      scan: scanLabel,
      join: joinLabel,
      link: eventLink,
      linkText: eventLinkLabel,
      showlink: showLink ? "1" : "0",
      x: xUrl,
      fb: facebookUrl,
      li: linkedinUrl,
      ig: instagramUrl,
      yt: youtubeUrl,
      grid: String(checker),
      meta: showMeta ? "1" : "0",
      bg: transparent ? "clear" : "black",
    })
    return `/stream?${params.toString()}`
  }, [name, date, time, endTime, timeZone, venue, rsvpUrl, badge, rsvpLabel, scanLabel, joinLabel, eventLink, eventLinkLabel, xUrl, facebookUrl, linkedinUrl, instagramUrl, youtubeUrl, checker, showMeta, showLink, transparent])

  const streamCommand = buildStreamShellCommand({
    eventName: name,
    dateLine,
    targetUnix,
    rtmpUrl,
  })
  const fileCommand = buildLocalTestCommand({
    eventName: name,
    dateLine,
    targetUnix,
  })

  const pausedMs = pausedAt ? pausedAt.getTime() : 0
  const syncKey = `${pausedMs}:${checker}:${showMeta}:${showLink}:${transparent}:${lineSpacing}:${blockGap}:${clockScale}:${clockText}:${logoUrl}:${gallerySeconds}:${galleryPause}:${galleryOffset}:${galleryScale}:${JSON.stringify(speakers)}`

  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetch("/api/encoder", { cache: "no-store" })
        .then((response) => response.json())
        .then((body: { rtmpRunning?: boolean; rtmpReconnecting?: boolean; rtmpRestarts?: number; strayPublishers?: { pid: number }[] }) => {
          if (cancelled) return
          setRtmpLive(body.rtmpRunning === true)
          setRtmpReconnecting(body.rtmpReconnecting === true)
          setRtmpRestarts(typeof body.rtmpRestarts === "number" ? body.rtmpRestarts : 0)
          setStrayPids(Array.isArray(body.strayPublishers) ? body.strayPublishers.map((item) => item.pid) : [])
        })
        .catch(() => undefined)
    }
    load()
    const id = window.setInterval(load, 1500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  useEffect(() => {
    const stageRaw = window.localStorage.getItem("hyphen-countdown-stage")
    if (stageRaw) {
      try {
        const stage = JSON.parse(stageRaw) as { checker?: number; showMeta?: boolean; showLink?: boolean; transparent?: boolean; lineSpacing?: number; blockGap?: number; clockScale?: number; clockText?: number; logoUrl?: string }
        if (stage.checker) setChecker(stage.checker)
        if (typeof stage.showMeta === "boolean") setShowMeta(stage.showMeta)
        if (typeof stage.showLink === "boolean") setShowLink(stage.showLink)
        if (typeof stage.transparent === "boolean") setTransparent(stage.transparent)
        if (typeof stage.lineSpacing === "number") setLineSpacing(stage.lineSpacing)
        if (typeof stage.blockGap === "number") setBlockGap(stage.blockGap)
        if (typeof stage.clockScale === "number") setClockScale(clampSize(stage.clockScale, CLOCK_SCALE_RANGE))
        if (typeof stage.clockText === "number") setClockText(clampSize(stage.clockText, CLOCK_TEXT_RANGE))
        if (typeof stage.logoUrl === "string") setLogoUrl(stage.logoUrl)
        if (Array.isArray(stage.speakers)) setSpeakers(stage.speakers)
        if (typeof stage.gallerySeconds === "number") setGallerySeconds(stage.gallerySeconds)
        if (typeof stage.galleryPause === "number") setGalleryPause(stage.galleryPause)
        if (typeof stage.galleryOffset === "number") setGalleryOffset(stage.galleryOffset)
        if (typeof stage.galleryScale === "number") setGalleryScale(stage.galleryScale)
      } catch {
        /* ignore a bad local draft */
      }
    }
    const savedRtmp = window.localStorage.getItem("hyphen-countdown-rtmp")
    if (savedRtmp) setRtmpUrl(savedRtmp)
    const clockRaw = window.localStorage.getItem("hyphen-countdown-clock")
    if (clockRaw) {
      try {
        const clock = JSON.parse(clockRaw) as { testUntil?: number | null; pausedAt?: number | null }
        if (typeof clock.testUntil === "number") setTestUntil(clock.testUntil)
        if (typeof clock.pausedAt === "number") setPausedAt(new Date(clock.pausedAt))
      } catch {
        /* ignore a bad clock draft */
      }
    }
    void fetch("/api/event", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { event?: unknown; testUntil?: unknown; pausedAt?: unknown; stage?: { checker?: number; showMeta?: boolean; showLink?: boolean; transparent?: boolean } }) => {
        const saved = asEventConfig(body.event)
        if (saved && !window.localStorage.getItem("hyphen-countdown-event")) updateEvent(saved)
        if (!clockRaw) {
          if (typeof body.testUntil === "number") setTestUntil(body.testUntil)
          if (typeof body.pausedAt === "number") setPausedAt(new Date(body.pausedAt))
        }
        if (!stageRaw && body.stage) {
          if (body.stage.checker) setChecker(body.stage.checker)
          if (typeof body.stage.showMeta === "boolean") setShowMeta(body.stage.showMeta)
          if (typeof body.stage.showLink === "boolean") setShowLink(body.stage.showLink)
          if (typeof body.stage.transparent === "boolean") setTransparent(body.stage.transparent)
        }
      })
      .finally(() => setHydrated(true))
  }, [updateEvent])

  useEffect(() => {
    if (!hydrated) return
    window.localStorage.setItem("hyphen-countdown-stage", JSON.stringify({ checker, showMeta, showLink, transparent, lineSpacing, blockGap, clockScale, clockText, logoUrl, speakers, gallerySeconds, galleryPause, galleryOffset, galleryScale }))
  }, [hydrated, checker, showMeta, showLink, transparent, lineSpacing, blockGap, clockScale, clockText, logoUrl, speakers, gallerySeconds, galleryPause, galleryOffset, galleryScale])

  useEffect(() => {
    if (!hydrated || !valid) return
    if (testUntil) setSkewMs(target.getTime() - testUntil)
    window.localStorage.setItem("hyphen-countdown-clock", JSON.stringify({ testUntil, pausedAt: pausedMs || null }))
  }, [hydrated, valid, target, testUntil, pausedMs])

  useEffect(() => {
    if (!hydrated) return
    window.localStorage.setItem("hyphen-countdown-rtmp", rtmpUrl)
  }, [hydrated, rtmpUrl])

  useEffect(() => {
    if (!token || !hydrated) return
    const id = window.setTimeout(() => {
      void fetch("/api/event", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-encoder-token": token },
        body: JSON.stringify({
          event,
          testUntil,
          pausedAt: pausedMs || null,
          stage: { checker, showMeta, showLink, transparent, lineSpacing, blockGap, clockScale, clockText, logoUrl, speakers, gallerySeconds, galleryPause, galleryOffset, galleryScale },
        }),
      })
        .then(async (response) => {
          if (response.ok) {
            setSyncState("saved")
            return
          }
          const body = await response.json().catch(() => null)
          setSyncState("local")
          if (body?.error) console.warn(body.error)
        })
        .catch(() => setSyncState("local"))
    }, 400)
    return () => window.clearTimeout(id)
  }, [event, token, testUntil, syncKey, hydrated])

  const stableHref = useMemo(() => {
    const params = new URLSearchParams()
    if (checker !== 6) params.set("grid", String(checker))
    if (!showMeta) params.set("meta", "0")
    if (!showLink) params.set("showlink", "0")
    if (transparent) params.set("bg", "clear")
    const query = params.toString()
    return query ? `/stream?${query}` : "/stream"
  }, [checker, showMeta, showLink, transparent])

  useEffect(() => {
    if (!previewReady.current) {
      previewReady.current = true
      return
    }
    setPreviewFlash(true)
    const id = window.setTimeout(() => setPreviewFlash(false), 1400)
    return () => window.clearTimeout(id)
  }, [streamHref])

  const previewNow = pausedAt ?? (now ? new Date(now.getTime() + skewMs) : null)
  const previewRemaining = valid && previewNow ? remainingUntil(target, previewNow) : remaining

  async function jumpPreview(seconds: number) {
    if (!valid) return
    setPausedAt(null)
    const nextUntil = Date.now() + seconds * 1000
    setTestUntil(nextUntil)
    setSkewMs(target.getTime() - nextUntil)
    void fetch("/api/event", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-encoder-token": token },
      body: JSON.stringify({ event, testUntil: nextUntil, pausedAt: null }),
    })
  }

  function goLiveNow() {
    if (!valid) return
    const nextUntil = Date.now() - 1000
    setPausedAt(null)
    setTestUntil(nextUntil)
    setSkewMs(target.getTime() - nextUntil)
    void fetch("/api/event", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-encoder-token": token },
      body: JSON.stringify({ event, testUntil: nextUntil, pausedAt: null }),
    })
  }

  function restoreFestival() {
    const restored = { date: DEFAULT_EVENT.date, time: DEFAULT_EVENT.time, timeZone: DEFAULT_EVENT.timeZone }
    setPausedAt(null)
    setTestUntil(null)
    setSkewMs(0)
    updateEvent(restored)
    void fetch("/api/event", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-encoder-token": token },
      body: JSON.stringify({ event: { ...event, ...restored }, testUntil: null, pausedAt: null }),
    })
  }

  async function copy(kind: "stream" | "file" | "link" | "params", value: string) {
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    window.setTimeout(() => setCopied(null), 1600)
  }

  return (
    <div className="min-h-full bg-[#F6F6F3] text-black [&_input]:rounded-xl [&_input]:border-black/10 [&_input]:bg-[#F6F6F3] [&_select]:rounded-xl [&_select]:border-black/10 [&_select]:bg-[#F6F6F3]">
      <header className="sticky top-0 z-20 border-b border-black/10 bg-white/90 px-4 py-4 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-mono text-[10px] tracking-[0.16em] text-black/50 uppercase">
              Hyphen Festival 2026
            </p>
            <h1 className="text-xl font-black tracking-tight uppercase">Countdown desk</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="hidden items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1.5 font-mono text-[11px] md:inline-flex">
              <span className="text-black/50">Target</span>
              <span>{valid ? formatClock(target, timeZone) : "—"}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${previewRemaining?.done ? "bg-[#ff3c00] text-white" : "bg-[#D9FF43]"}`}>
                {previewRemaining?.done ? "LIVE" : "Armed"}
              </span>
            </span>
            <span className="font-mono text-[10px] text-black/50 uppercase">
              Desk {syncState}
            </span>
            <Button type="button" className="rounded-full bg-black text-white" onClick={() => copy("link", `${window.location.origin}${stableHref}`)}>
              {copied === "link" ? "Copied" : "Copy OBS URL"}
            </Button>
            <Button nativeButton={false} render={<Link href={stableHref} target="_blank" rel="noreferrer" />} className="rounded-full bg-black text-white">
              Open /stream in new window
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1600px] items-start gap-6 px-4 py-6 lg:grid-cols-[380px_1fr] sm:px-6">
        <section className="space-y-4 lg:sticky lg:top-24">
          <div className="rounded-[20px] bg-black p-5 text-white">
            {previewRemaining?.done ? (
              <div>
                <p className="font-mono text-[11px] tracking-[0.14em] text-[#ff3c00] uppercase">Live</p>
                <p className="mt-2 text-2xl font-black">Doors are open</p>
              </div>
            ) : (
              <>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-mono text-[11px] tracking-[0.14em] text-white/60 uppercase">
                Live countdown · {timeZone}
              </h2>
              <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase">
                <span className="size-2 rounded-full bg-[#D9FF43]" />
                Ticking
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {[
                { value: previewRemaining ? String(previewRemaining.days) : "--", label: "Days" },
                { value: previewRemaining ? pad2(previewRemaining.hours) : "--", label: "Hours" },
                { value: previewRemaining ? pad2(previewRemaining.minutes) : "--", label: "Mins" },
                { value: previewRemaining ? pad2(previewRemaining.seconds) : "--", label: "Secs" },
              ].map((unit) => (
                <div key={unit.label} className="rounded-[14px] border border-white/10 bg-white/10 px-2 py-3 text-center">
                  <div className="font-mono text-[28px] leading-none font-black tabular-nums">{unit.value}</div>
                  <div className="mt-1 font-mono text-[10px] tracking-[0.12em] text-white/50 uppercase">{unit.label}</div>
                </div>
              ))}
            </div>
              </>
            )}
          </div>

          <Panel title="Transport" pill="Preview test">
            <div className="flex flex-wrap gap-2">
              {[
                [15, "15s"],
                [600, "10min"],
                [1800, "30min"],
                [3600, "1 hour"],
              ].map(([seconds, label]) => (
                <button key={label} type="button" className="rounded-full bg-black px-3 py-1.5 font-mono text-[11px] text-white" onClick={() => void jumpPreview(Number(seconds))}>
                  {label} left
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" className="rounded-full bg-black text-white" onClick={() => {
                if (pausedAt) {
                  setPausedAt(null)
                  return
                }
                if (previewNow) setPausedAt(previewNow)
              }}>
                {pausedAt ? "Play" : "Pause"}
              </Button>
              <button type="button" className="h-8 rounded-full border border-black bg-white text-sm font-medium text-black transition-colors hover:bg-black hover:text-white active:translate-y-px" onClick={() => { setPausedAt(null); setSkewMs(0); setTestUntil(null) }}>
                Reset clock
              </button>
              <Button type="button" className="rounded-full bg-[#ff3c00] text-white hover:bg-[#e03600]" onClick={goLiveNow}>
                Go live now
              </Button>
              <button type="button" className="h-8 rounded-full border border-black bg-white text-sm font-medium text-black transition-colors hover:bg-black hover:text-white active:translate-y-px" onClick={restoreFestival}>
                Restore 4 Nov
              </button>
            </div>
            <p className="font-mono text-[10px] leading-5 text-black/55">
              Pause, play, go live, and restore apply to this preview and /stream. Restore 4 Nov clears the test and puts 4 November 09:30 back in the date fields.
            </p>
          </Panel>

          <Panel title="Event core" pill="Editable">
            <Field label="Session title" htmlFor="name">
              <GrowingText id="name" value={name} onChange={(value) => updateEvent({ name: value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date" htmlFor="date">
                <Input id="date" type="date" value={date} onChange={(event) => updateEvent({ date: event.target.value })} />
              </Field>
              <Field label="Timezone" htmlFor="tz">
                <select id="tz" className="h-9 w-full px-3 text-sm" value={timeZone} onChange={(event) => updateEvent({ timeZone: event.target.value })}>
                  {TIME_ZONES.map((zoneOption) => (
                    <option key={zoneOption.id} value={zoneOption.id}>{zoneOption.label}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start time" htmlFor="time">
                <Input id="time" type="time" value={time} onChange={(event) => updateEvent({ time: event.target.value })} />
              </Field>
              <Field label="End time" htmlFor="endTime">
                <Input id="endTime" type="time" value={endTime} onChange={(event) => updateEvent({ endTime: event.target.value })} />
              </Field>
            </div>
            <Field label="Venue" htmlFor="venue">
              <GrowingText id="venue" value={venue} onChange={(value) => updateEvent({ venue: value })} />
            </Field>
          </Panel>

          <Panel title="Call to action">
            <Field label="RSVP URL" htmlFor="rsvp">
              <GrowingText id="rsvp" value={rsvpUrl} onChange={(value) => updateEvent({ rsvpUrl: value })} />
            </Field>
            <Field label="RSVP button text" htmlFor="rsvpLabel">
              <Input id="rsvpLabel" value={rsvpLabel} onChange={(event) => updateEvent({ rsvpLabel: event.target.value })} />
            </Field>
            <Field label="Badge" htmlFor="badge">
              <Input id="badge" value={badge} onChange={(event) => updateEvent({ badge: event.target.value })} />
            </Field>
            <Field label="Scan label" htmlFor="scan">
              <Input id="scan" value={scanLabel} onChange={(event) => updateEvent({ scanLabel: event.target.value })} />
            </Field>
            <Field label="Join Live label" htmlFor="join">
              <Input id="join" value={joinLabel} onChange={(event) => updateEvent({ joinLabel: event.target.value })} />
            </Field>
            <Field label="Event link" htmlFor="link">
              <GrowingText id="link" value={eventLink} onChange={(value) => updateEvent({ eventLink: value })} />
            </Field>
            <Field label="Event link text" htmlFor="linkText">
              <GrowingText id="linkText" value={eventLinkLabel} onChange={(value) => updateEvent({ eventLinkLabel: value })} />
            </Field>
          </Panel>

          <Panel title="Stage options">
            <label className="flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-black/70 uppercase">
              <input type="checkbox" className="size-4 accent-black" checked={showMeta} onChange={(event) => setShowMeta(event.target.checked)} />
              Show date and timezone
            </label>
            <label className="flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-black/70 uppercase">
              <input type="checkbox" className="size-4 accent-black" checked={showLink} onChange={(event) => setShowLink(event.target.checked)} />
              Show event link
            </label>
            <label className="flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-black/70 uppercase">
              <input type="checkbox" className="size-4 accent-black" checked={transparent} onChange={(event) => setTransparent(event.target.checked)} />
              Transparent background
            </label>
            <Field label="Title line spacing" htmlFor="spacing">
              <input id="spacing" type="range" min="0.8" max="2.2" step="0.05" value={lineSpacing} onChange={(event) => setLineSpacing(Number(event.target.value))} className="w-full accent-black" />
              <span className="font-mono text-[11px] text-black/50">{lineSpacing.toFixed(2)}</span>
            </Field>
            <Field label="Gap below address" htmlFor="blockGap">
              <input id="blockGap" type="range" min="0" max="8" step="0.1" value={blockGap} onChange={(event) => setBlockGap(Number(event.target.value))} className="w-full accent-black" />
              <span className="font-mono text-[11px] text-black/50">{blockGap.toFixed(1)}</span>
            </Field>
            <Field label="Countdown size (boxes and text)" htmlFor="clockScale">
              <input id="clockScale" type="range" min={CLOCK_SCALE_RANGE.min} max={CLOCK_SCALE_RANGE.max} step="0.05" value={clockScale} onChange={(event) => setClockScale(Number(event.target.value))} className="w-full accent-black" />
              <span className="font-mono text-[11px] text-black/50">
                {clockScale.toFixed(2)}×
                {fitClockScale(clockScale, clockText) < clockScale - 0.005
                  ? ` · shown at ${fitClockScale(clockScale, clockText).toFixed(2)}× so it fits beside the logo`
                  : ""}
              </span>
            </Field>
            <Field label="Text size inside boxes" htmlFor="clockText">
              <input id="clockText" type="range" min={CLOCK_TEXT_RANGE.min} max={CLOCK_TEXT_RANGE.max} step="0.05" value={clockText} onChange={(event) => setClockText(Number(event.target.value))} className="w-full accent-black" />
              <span className="font-mono text-[11px] text-black/50">{clockText.toFixed(2)}× of the countdown size</span>
            </Field>
            <Field label="Logo source" htmlFor="logo">
              <GrowingText id="logo" value={logoUrl} onChange={setLogoUrl} />
              <p className="font-mono text-[10px] text-black/45">Leave blank for the Hyphen PNG. Paste an image URL to replace it.</p>
            </Field>
            <Field label="Checker division" htmlFor="checker">
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" className="rounded-full" onClick={() => setChecker((value) => Math.max(4, value - 1))}>−</Button>
                <span id="checker" className="min-w-16 text-center font-mono text-sm tabular-nums">{checker}×{checker}</span>
                <Button type="button" variant="outline" className="rounded-full" onClick={() => setChecker((value) => Math.min(12, value + 1))}>+</Button>
              </div>
            </Field>
          </Panel>

          <details className="overflow-hidden rounded-[20px] border border-black/10 bg-white shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
            <summary className="cursor-pointer list-none px-5 py-4 text-[13px] font-black tracking-[0.12em] uppercase">
              Branding and socials
            </summary>
            <div className="space-y-4 border-t border-black/10 p-5">
              <Field label="X URL" htmlFor="x"><GrowingText id="x" value={xUrl} onChange={(value) => updateEvent({ xUrl: value })} /></Field>
              <Field label="Facebook URL" htmlFor="fb"><GrowingText id="fb" value={facebookUrl} onChange={(value) => updateEvent({ facebookUrl: value })} /></Field>
              <Field label="LinkedIn URL" htmlFor="li"><GrowingText id="li" value={linkedinUrl} onChange={(value) => updateEvent({ linkedinUrl: value })} /></Field>
              <Field label="Instagram URL" htmlFor="ig"><GrowingText id="ig" value={instagramUrl} onChange={(value) => updateEvent({ instagramUrl: value })} /></Field>
              <Field label="YouTube URL" htmlFor="yt"><GrowingText id="yt" value={youtubeUrl} onChange={(value) => updateEvent({ youtubeUrl: value })} /></Field>
            </div>
          </details>

          <Panel title="FFmpeg">
            <div className="flex items-center justify-between gap-3">
              <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 font-mono text-[10px] font-bold tracking-[0.14em] uppercase ${rtmpLive ? (rtmpReconnecting ? "bg-[#b45309] text-white" : "bg-[#128a3e] text-white") : "bg-black/5 text-black/45"}`}>
                <span className={`size-1.5 rounded-full ${rtmpLive ? "animate-pulse bg-white" : "bg-black/30"}`} />
                {rtmpLive ? (rtmpReconnecting ? "Reconnecting" : "Stream live") : "Stream off"}
                {rtmpRestarts > 0 ? ` · ${rtmpRestarts}` : ""}
              </span>
            </div>
            <Field label="RTMP URL" htmlFor="rtmp">
              <Input id="rtmp" type="password" autoComplete="off" placeholder="rtmp://uk.castr.io/static/…?password=…" value={rtmpUrl} onChange={(event) => setRtmpUrl(event.target.value)} />
            </Field>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-full bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                disabled={!valid || rtmpUrl.trim().length === 0}
                onClick={() => {
                  setRtmpState("idle")
                  setRtmpMessage("")
                  void fetch("/api/encoder", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-encoder-token": token },
                    body: JSON.stringify({ mode: "rtmp", rtmpUrl, eventName: name, dateLine, targetUnix, refreshSeconds: 0 }),
                  })
                    .then(async (response) => {
                      const body = await response.json().catch(() => null)
                      if (!response.ok) {
                        setRtmpState("error")
                        setRtmpMessage(body?.error || "The stream did not start.")
                        return
                      }
                      setRtmpState("live")
                      setRtmpLive(true)
                      setRtmpMessage("Sending to the pasted RTMP URL.")
                    })
                    .catch(() => {
                      setRtmpState("error")
                      setRtmpMessage("The desk could not reach the encoder.")
                    })
                }}
              >
                Start stream
              </button>
              <button
                type="button"
                className="rounded-full border border-black bg-white px-4 py-2 text-sm font-medium text-black"
                onClick={() => {
                  void fetch("/api/encoder?target=rtmp", { method: "DELETE", headers: { "x-encoder-token": token } }).then(() => {
                    setRtmpState("idle")
                    setRtmpLive(false)
                    setRtmpMessage("Stream stopped.")
                  })
                }}
              >
                Stop stream
              </button>
            </div>
            {strayPids.length > 0 ? <p className="font-mono text-[11px] text-red-600">Another ffmpeg is publishing outside this desk. PID {strayPids.join(", ")}. Stop that Terminal process, or the old picture stays on the air.</p> : null}
            <p className="font-mono text-[11px] leading-5 text-black/60">
              Start stream sends 1280×720, 30 fps, H.264 2500 kbps, yuv420p, AAC stereo 128 kbps, silent audio, FLV over RTMP. The local player is the same picture as 2-second HLS segments.
            </p>
            <CommandBlock value={streamCommand} copied={copied === "stream"} onCopy={() => copy("stream", streamCommand)} />
            <CommandBlock value={fileCommand} copied={copied === "file"} onCopy={() => copy("file", fileCommand)} />
          </Panel>
          <Panel title="Speaker gallery">
            <p className="font-mono text-[11px] leading-5 text-black/55">Plays over the logo on the OBS page during the countdown, then clears so the logo shows. It stops when the event is live. The encoded slate is unchanged.</p>
            <Field label="Seconds on each speaker" htmlFor="gallery-seconds">
              <Input id="gallery-seconds" type="number" min={2} max={30} value={gallerySeconds} onChange={(event) => setGallerySeconds(Math.min(30, Math.max(2, Number(event.target.value) || 4)))} />
            </Field>
            <Field label="Pause before it returns" htmlFor="gallery-pause">
              <Input id="gallery-pause" type="number" min={2} max={30} value={galleryPause} onChange={(event) => setGalleryPause(Math.min(30, Math.max(2, Number(event.target.value) || 6)))} />
            </Field>
            <Field label="Vertical position (px, higher moves it down)" htmlFor="gallery-offset">
              <Input id="gallery-offset" type="number" min={-600} max={400} value={galleryOffset} onChange={(event) => setGalleryOffset(Math.min(400, Math.max(-600, Number(event.target.value) || 0)))} />
            </Field>
            <Field label="Portrait size (%)" htmlFor="gallery-scale">
              <Input id="gallery-scale" type="number" min={40} max={160} value={galleryScale} onChange={(event) => setGalleryScale(Math.min(160, Math.max(40, Number(event.target.value) || 80)))} />
            </Field>
            {speakers.map((speaker, index) => (
              <div key={index} className="space-y-2 rounded-xl border border-black/10 p-3">
                <Field label="Image URL" htmlFor={`speaker-image-${index}`}>
                  <GrowingText id={`speaker-image-${index}`} value={speaker.image} onChange={(value) => setSpeakers((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, image: value } : item))} />
                </Field>
                <Field label="Title" htmlFor={`speaker-name-${index}`}>
                  <GrowingText id={`speaker-name-${index}`} value={speaker.name} onChange={(value) => setSpeakers((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, name: value } : item))} />
                </Field>
                <Field label="Description" htmlFor={`speaker-desc-${index}`}>
                  <GrowingText id={`speaker-desc-${index}`} value={speaker.description} onChange={(value) => setSpeakers((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, description: value } : item))} />
                </Field>
                <button type="button" className="rounded-full border border-black px-3 py-1 text-xs" onClick={() => setSpeakers((items) => items.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
              </div>
            ))}
            <button type="button" className="rounded-full bg-black px-4 py-2 text-sm text-white" onClick={() => setSpeakers((items) => [...items, { image: "", name: "", description: "" }])}>Add speaker</button>
          </Panel>
        </section>

        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h2 className="text-[13px] font-black tracking-[0.12em] uppercase">
                Preview · 16:9 hero · {transparent ? "clear edition" : "black edition"}
              </h2>
              <span className="rounded-full bg-[#ff3c00] px-2.5 py-1 font-mono text-[10px] font-bold tracking-[0.12em] text-white uppercase">
                Live update
              </span>
            </div>
            <span className="rounded-full border border-black/10 bg-white px-3 py-1.5 font-mono text-[10px] text-black/50">
              1920×1080 · official logo · {transparent ? "transparent bg" : "black bg"} · {transparent ? "no chrome" : "hero"}
            </span>
          </div>
          <div
            className={`relative overflow-hidden rounded-[24px] border shadow-[0_20px_60px_rgba(0,0,0,0.18)] ${previewFlash ? "border-[#ff3c00]" : "border-black/10"}`}
            style={
              transparent
                ? { backgroundImage: "linear-gradient(45deg,#d9d9d4 25%,transparent 25%),linear-gradient(-45deg,#d9d9d4 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d9d9d4 75%),linear-gradient(-45deg,transparent 75%,#d9d9d4 75%)", backgroundSize: "24px 24px", backgroundPosition: "0 0,0 12px,12px -12px,-12px 0" }
                : { background: "#000" }
            }
          >
            {previewFlash ? (
              <span className="absolute top-3 left-3 z-30 rounded-full bg-[#ff3c00] px-2.5 py-1 font-mono text-[10px] font-bold tracking-[0.12em] text-white uppercase">
                Preview updated
              </span>
            ) : null}
            <CountdownStage event={event} checker={checker} showMeta={showMeta} showLink={showLink} transparent={transparent} lineSpacing={lineSpacing} blockGap={blockGap} clockScale={clockScale} clockText={clockText} logoUrl={logoUrl} speakers={speakers} gallerySeconds={gallerySeconds} galleryPause={galleryPause} galleryOffset={galleryOffset} galleryScale={galleryScale} clock={previewNow} />
          </div>
          <div className="grid items-center gap-3 rounded-2xl border border-black/10 bg-white px-4 py-3 md:grid-cols-[1fr_auto]">
            <p className="font-mono text-[11px] leading-5 break-all">
              <span className="text-black/50">Stream params preview: </span>
              {streamHref}
            </p>
            <Button
              type="button"
              className="rounded-full bg-black text-white"
              onClick={() => copy("link", `${window.location.origin}${stableHref}`)}
            >
              {copied === "link" ? "Copied" : "Copy OBS URL"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-full"
              onClick={() => copy("params", `${window.location.origin}${streamHref}`)}
            >
              {copied === "params" ? "Copied" : "Copy full param URL"}
            </Button>
          </div>
          <p className="font-mono text-[11px] leading-5 text-black/55">
            — This is a local draft preview. No data leaves the browser. For OBS, add a Browser Source at 1920×1080 and paste the copied link. Countdown runs off this computer’s clock.
            {transparent ? " Transparent background is on: in OBS leave the browser source CSS empty so the page can show through." : ""}
          </p>
          <EncodedPreview eventName={name} dateLine={dateLine} targetUnix={targetUnix} valid={valid} />
        </section>
      </main>
    </div>
  )
}


function Panel({ title, pill, children }: { title: string; pill?: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-[20px] border border-black/10 bg-white shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-between border-b border-black/10 px-5 py-4">
        <h2 className="text-[13px] font-black tracking-[0.12em] uppercase">{title}</h2>
        {pill ? <span className="rounded-full bg-black px-2 py-1 font-mono text-[10px] text-white">{pill}</span> : null}
      </div>
      <div className="space-y-4 p-5">{children}</div>
    </section>
  )
}

function GrowingText({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <textarea
      id={id}
      rows={1}
      value={value}
      onChange={(event) => {
        event.target.style.height = "auto"
        event.target.style.height = `${event.target.scrollHeight}px`
        onChange(event.target.value)
      }}
      ref={(node) => {
        if (!node) return
        node.style.height = "auto"
        node.style.height = `${node.scrollHeight}px`
      }}
      className="w-full resize-none overflow-hidden rounded-xl border border-black/10 bg-[#F6F6F3] px-3 py-2 text-sm leading-5 break-all"
    />
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="font-mono text-[10px] tracking-[0.14em] text-black/60 uppercase">{label}</Label>
      {children}
    </div>
  )
}

function CommandBlock({
  value,
  copied,
  onCopy,
}: {
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto rounded-xl bg-[#F6F6F3] p-3 font-mono text-[11px] leading-5 text-black/80 whitespace-pre-wrap">
        {value}
      </pre>
      <Button variant="secondary" onClick={onCopy} className="w-full">
        {copied ? "Copied" : "Copy command"}
      </Button>
    </div>
  )
}
