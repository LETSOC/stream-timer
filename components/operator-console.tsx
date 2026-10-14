"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
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
import { NumberField } from "@/components/number-field"
import { Label } from "@/components/ui/label"
import { CountdownStage } from "@/components/countdown-stage"
import { EncodedPreview } from "@/components/encoded-preview"
import { ProgramPlayer, programOperatorSrc } from "@/components/program-feed"
import { failoverText, ProgramSourceSwitch, sourceStatus, useFailoverEvents } from "@/components/program-source-switch"
import type { FailoverSettings, ProgramSource } from "@/lib/program-source"
import type { ProgramSourcesView } from "@/lib/transport"
import { StreamPlayer } from "@/components/stream-player"
import { diagnose, type HealthStats, type Level, type SourceHealth } from "@/lib/stream-health"
import { CAPTURE_BITRATES } from "@/lib/capture-options"
import { EndStreamPage } from "@/app/end/page"
import {
  formatClock,
  pad2,
  remainingUntil,
  wallTimeInZone,
} from "@/lib/countdown"
import { CLOCK_SCALE_RANGE, CLOCK_TEXT_RANGE, clampSize, fitClockScale } from "@/lib/countdown-size"
import { useNow } from "@/lib/use-now"
import { applyTransport, endInstant, EXTENDS, extendTarget, type Screen, type TransportAction } from "@/lib/transport"
import { useDeckSocket } from "@/lib/use-deck-socket"
import { TIME_ZONES, DEFAULT_EVENT, eventProblems } from "@/lib/event"
import { asEventConfig, useStoredEvent } from "@/lib/event-storage"
import { handleUnauthorized, hardNavigate, useOperator } from "@/lib/use-operator"
import { DEFAULT_STAGE, parseStage, stageScreen, type ImageFit, type Overlay, type StageOptions } from "@/lib/stage"
import { IMMEDIATE_STAGE, pickSection, planRemoteSync, previewSkew, savePayloadStage, SECTIONS, withSection, type DeskSnapshot, type SectionId, type SectionValues } from "@/lib/desk-sections"
import { DraftBar, readStoredDrafts, useSectionDrafts } from "@/components/section-drafts"
import { OverlayCard } from "@/components/overlay-card"
import type { SpeakerCard } from "@/lib/event"
import { ConfirmButton } from "@/components/confirm-button"
import { CopyFallbackHost, copyOrShow } from "@/components/copy-fallback"
import {
  buildLocalTestCommand,
  buildStreamShellCommand,
} from "@/lib/ffmpeg-command"

export function OperatorConsole() {
  const [event, updateEvent] = useStoredEvent()
  const { name, date, time, endTime, timeZone, venue, rsvpUrl, badge, rsvpLabel, scanLabel, joinLabel, eventLink, eventLinkLabel, xUrl, facebookUrl, linkedinUrl, instagramUrl, youtubeUrl } = event
  // Named RTMP destinations live on the server (data/rtmp-destinations.json); the desk only sees masked values.
  const [dests, setDests] = useState<{ selectedId: string | null; selectedCaptureId: string | null; items: Dest[] }>({ selectedId: null, selectedCaptureId: null, items: [] })
  // Destination shown in the "Saved destinations" manager (rename/reveal/copy/delete); separate from what each channel streams to.
  const [manageId, setManageId] = useState<string | null>(null)
  const [destForm, setDestForm] = useState<{ mode: "add" | "rename" | null; name: string; url: string }>({ mode: null, name: "", url: "" })
  const [destError, setDestError] = useState("")
  const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(null)
  const [legacyRtmp, setLegacyRtmp] = useState<string | null>(null)
  // Per-device choice: what Start stream publishes. Remembered in this browser only.
  const [rtmpOwnCount, setRtmpOwnCount] = useState(0)
  const headerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const update = () => {
      document.documentElement.style.setProperty("--desk-header-h", `${el.offsetHeight}px`)
      // Sticky header (lg+): keep anchors / scrollIntoView targets below it instead of under it.
      document.documentElement.style.scrollPaddingTop = getComputedStyle(el).position === "sticky" ? `${el.offsetHeight + 12}px` : ""
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener("resize", update)
    return () => { observer.disconnect(); window.removeEventListener("resize", update); document.documentElement.style.scrollPaddingTop = "" }
  }, [])
  const [strayPids, setStrayPids] = useState<number[]>([])
  const [rtmpChannels, setRtmpChannels] = useState<Record<RtmpChannelId, RtmpChannelView>>({ slate: STOPPED_CHANNEL, capture: STOPPED_CHANNEL })
  const [rtmpNote, setRtmpNote] = useState("")
  const rtmpLive = rtmpChannels.slate.running || rtmpChannels.capture.running
  const selectedDest = dests.items.find((item) => item.id === (manageId ?? dests.selectedId)) ?? dests.items[0] ?? null
  const slateDest = dests.items.find((item) => item.id === dests.selectedId) ?? null
  const rtmpUrl = slateDest?.masked ?? "rtmp://YOUR-INGEST/STREAM-KEY"
  const [copied, setCopied] = useState<"stream" | "file" | "link" | "params" | "dest" | null>(null)
  const [checker, setChecker] = useState(6)
  const [showMeta, setShowMeta] = useState(true)
  const [showLink, setShowLink] = useState(true)
  const [transparent, setTransparent] = useState(false)
  const [lineSpacing, setLineSpacing] = useState(1.14)
  const [blockGap, setBlockGap] = useState(1.2)
  const [clockScale, setClockScale] = useState(1)
  const [clockText, setClockText] = useState(1)
  const [logoUrl, setLogoUrl] = useState("")
  const [speakers, setSpeakers] = useState<SpeakerCard[]>([])
  const [gallerySeconds, setGallerySeconds] = useState(4)
  const [galleryPause, setGalleryPause] = useState(6)
  const [galleryOffset, setGalleryOffset] = useState(-86)
  const [galleryScale, setGalleryScale] = useState(80)
  const [endTitle, setEndTitle] = useState("Thank you for joining")
  const [endSubtitle, setEndSubtitle] = useState("Hyphen Festival 2026")
  const [endDate, setEndDate] = useState("Wed, 04 Nov, 2026")
  const [endBody, setEndBody] = useState("The stream has ended. Thank you to all speakers, partners and attendees. Recordings will be available shortly.")
  const [endQrUrl, setEndQrUrl] = useState("https://linktr.ee/onlinehyphen")
  const [endButton, setEndButton] = useState("Watch replay — coming soon")
  const [endAt, setEndAt] = useState("")
  const [forceEnd, setForceEnd] = useState(false)
  const [holdCountdown, setHoldCountdown] = useState(false)
  const [breakTitle, setBreakTitle] = useState(DEFAULT_STAGE.breakTitle)
  const [breakMessage, setBreakMessage] = useState("")
  const [breakImage, setBreakImage] = useState("")
  const [breakFit, setBreakFit] = useState<ImageFit>("cover")
  const [holdTitle, setHoldTitle] = useState(DEFAULT_STAGE.holdTitle)
  const [holdMessage, setHoldMessage] = useState("")
  const [holdImage, setHoldImage] = useState("")
  const [holdFit, setHoldFit] = useState<ImageFit>("cover")
  const [welcomeTitle, setWelcomeTitle] = useState(DEFAULT_STAGE.welcomeTitle)
  const [welcomeMessage, setWelcomeMessage] = useState("")
  const [welcomeImage, setWelcomeImage] = useState("")
  const [welcomeFit, setWelcomeFit] = useState<ImageFit>("cover")
  const [overlay, setOverlay] = useState<Overlay>("none")
  const [overlayAt, setOverlayAt] = useState<number | null>(null)
  const [program, setProgram] = useState(false)
  const [programSource, setProgramSource] = useState<"main" | "backup">("main")
  // Both program inputs' health + failover settings (server monitor), polled; null = relay not armed.
  const [sources, setSources] = useState<ProgramSourcesView | null>(null)
  // What /stream has for the draft-managed sections (Event, Links, Look, Socials, End/Break/Hold card, Speakers).
  // The fields above are the desk's draft; only "Save" copies a section into `published`.
  const [published, setPublished] = useState<DeskSnapshot | null>(null)
  const [operator, setOperator] = useOperator()
  // Truthy once the session is confirmed; gates autosave like the old encoder token did.
  const token = operator.operator ? "session" : ""
  const [syncState, setSyncState] = useState<"idle" | "saved" | "local" | "error" | "conflict">("idle")
  const [syncError, setSyncError] = useState("")
  const [pausedAt, setPausedAt] = useState<Date | null>(null)
  const [skewMs, setSkewMs] = useState(0)
  const [testUntil, setTestUntil] = useState<number | null>(null)
  const [previewFlash, setPreviewFlash] = useState(false)
  // One toast at a time; each kind has its own title, duration and timer. Polling never touches it.
  type Toast = { id: number; kind: "copy" | "copy-failed" | "sync" | "conflict" | "error" | "extend" | "failover"; text: string; undo?: () => void }
  const [toast, setToastState] = useState<Toast | null>(null)
  const toastTimer = useRef<number | null>(null)
  const toastSeq = useRef(0)
  const lastSyncToastAt = useRef(0)
  const dismissToast = useCallback(() => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = null
    setToastState(null)
  }, [])
  const showToast = useCallback((kind: Toast["kind"], text: string, undo?: () => void) => {
    const ms = { copy: 2000, "copy-failed": 6000, sync: 2500, conflict: 5000, error: 5000, extend: 8000, failover: 8000 }[kind]
    const id = ++toastSeq.current
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToastState({ id, kind, text, undo })
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null
      setToastState((current) => (current?.id === id ? null : current))
    }, ms)
  }, [])
  /** Errors and messages that aren't copies or sync. */
  const setToast = useCallback((text: string | null) => (text ? showToast("error", text) : dismissToast()), [showToast, dismissToast])
  useEffect(() => {
    let stop = false
    const poll = () => fetch("/api/deck/state", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((body: { programSources?: ProgramSourcesView | null } | null) => {
      if (!stop && body) setSources(body.programSources ?? null)
    }).catch(() => undefined)
    void poll()
    const id = window.setInterval(poll, 1000)
    return () => { stop = true; window.clearInterval(id) }
  }, [])
  // Failovers (and switches from other devices) toast on every desk.
  useFailoverEvents(sources?.last, (e) => showToast("failover", failoverText(e)))
  // Preview-only aids (never sent to /stream), remembered in localStorage.
  const [trueObs, setTrueObs] = useSectionOpen("aid-true-obs", false)
  const [safeZone, setSafeZone] = useSectionOpen("aid-safe-zone", false)
  const [thirds, setThirds] = useSectionOpen("aid-thirds", false)
  const [footage, setFootage] = useSectionOpen("aid-footage", false)
  const [pinStored, setPinPreview] = useSectionOpen("aid-pin-preview", null)
  const wide = useMediaQuery("(min-width: 1400px)")
  // No saved choice yet: pinned by default on wide desks only, off on phones/laptops.
  const pinPreview = pinStored ?? wide
  const [showHelp, setShowHelp] = useState(false)
  const [revealParams, setRevealParams] = useState(false)
  const pauseRef = useRef<HTMLButtonElement>(null)
  const goLiveRef = useRef<HTMLButtonElement>(null)
  const resetRef = useRef<HTMLButtonElement>(null)
  const [hydrated, setHydrated] = useState(false)
  // Server revision this tab last saw; sent with each save so a stale tab gets a 409 instead of overwriting.
  const revRef = useRef<number | undefined>(undefined)
  const [recovered, setRecovered] = useState<"backup" | "defaults" | null>(null)
  // Live mode: test-clock buttons and keyboard shortcuts are locked so nothing rehearsal-only reaches /stream by accident.
  // Shared via the server (stage.deskLive) so every desk agrees on Rehearsal vs Live.
  const [liveMode, setLiveMode] = useState(false)
  const liveModeRef = useRef(liveMode)
  useEffect(() => {
    liveModeRef.current = liveMode
  })
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

  // The encoder burns in what /stream has (published Event), not the Event draft.
  const pubLine = eventLine(published?.event ?? event)

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
    if (operator.viewKey) params.set("k", operator.viewKey)
    return `/stream?${params.toString()}`
  }, [name, date, time, endTime, timeZone, venue, rsvpUrl, badge, rsvpLabel, scanLabel, joinLabel, eventLink, eventLinkLabel, xUrl, facebookUrl, linkedinUrl, instagramUrl, youtubeUrl, checker, showMeta, showLink, transparent, operator.viewKey])

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

  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetch("/api/encoder", { cache: "no-store" })
        .then((response) => response.json())
        .then((body: { strayPublishers?: { pid: number }[]; rtmpOwnProcesses?: number; rtmpChannels?: Partial<Record<RtmpChannelId, RtmpChannelView>> }) => {
          if (cancelled) return
          setRtmpOwnCount(typeof body.rtmpOwnProcesses === "number" ? body.rtmpOwnProcesses : 0)
          // Every desk polls the same server status, so both channels' state stays in sync across devices.
          setRtmpChannels({ slate: body.rtmpChannels?.slate ?? STOPPED_CHANNEL, capture: body.rtmpChannels?.capture ?? STOPPED_CHANNEL })
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

  const applyStage = useCallback((stage: Partial<StageOptions>) => {
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
    if (typeof stage.endTitle === "string") setEndTitle(stage.endTitle)
    if (typeof stage.endSubtitle === "string") setEndSubtitle(stage.endSubtitle)
    if (typeof stage.endDate === "string") setEndDate(stage.endDate)
    if (typeof stage.endBody === "string") setEndBody(stage.endBody)
    if (typeof stage.endQrUrl === "string") setEndQrUrl(stage.endQrUrl)
    if (typeof stage.endButton === "string") setEndButton(stage.endButton)
    if (typeof stage.endAt === "string") setEndAt(stage.endAt)
    if (typeof stage.forceEnd === "boolean") setForceEnd(stage.forceEnd)
    if (typeof stage.holdCountdown === "boolean") setHoldCountdown(stage.holdCountdown)
    if (typeof stage.breakTitle === "string") setBreakTitle(stage.breakTitle)
    if (typeof stage.breakMessage === "string") setBreakMessage(stage.breakMessage)
    if (typeof stage.breakImage === "string") setBreakImage(stage.breakImage)
    if (stage.breakFit === "cover" || stage.breakFit === "contain") setBreakFit(stage.breakFit)
    if (typeof stage.holdTitle === "string") setHoldTitle(stage.holdTitle)
    if (typeof stage.holdMessage === "string") setHoldMessage(stage.holdMessage)
    if (typeof stage.holdImage === "string") setHoldImage(stage.holdImage)
    if (stage.holdFit === "cover" || stage.holdFit === "contain") setHoldFit(stage.holdFit)
    if (typeof stage.welcomeTitle === "string") setWelcomeTitle(stage.welcomeTitle)
    if (typeof stage.welcomeMessage === "string") setWelcomeMessage(stage.welcomeMessage)
    if (typeof stage.welcomeImage === "string") setWelcomeImage(stage.welcomeImage)
    if (stage.welcomeFit === "cover" || stage.welcomeFit === "contain") setWelcomeFit(stage.welcomeFit)
    if (stage.overlay === "none" || stage.overlay === "break" || stage.overlay === "hold" || stage.overlay === "welcome") setOverlay(stage.overlay)
    if (stage.overlayAt === null || typeof stage.overlayAt === "number") setOverlayAt(stage.overlayAt ?? null)
    if (typeof stage.program === "boolean") setProgram(stage.program)
    if (stage.programSource === "main" || stage.programSource === "backup") setProgramSource(stage.programSource)
    if (typeof stage.deskLive === "boolean") setLiveMode(stage.deskLive)
  }, [setBlockGap, setBreakFit, setBreakImage, setBreakMessage, setBreakTitle, setChecker, setClockScale, setClockText, setEndAt, setEndBody, setEndButton, setEndDate, setEndQrUrl, setEndSubtitle, setEndTitle, setForceEnd, setGalleryOffset, setGalleryPause, setGalleryScale, setGallerySeconds, setHoldCountdown, setHoldFit, setHoldImage, setHoldMessage, setHoldTitle, setLineSpacing, setLiveMode, setLogoUrl, setShowLink, setShowMeta, setSpeakers, setTransparent, setWelcomeFit, setWelcomeImage, setWelcomeMessage, setWelcomeTitle])

  useEffect(() => {
    // The server is the source of truth. The browser keeps only section drafts, the RTMP URL and
    // per-device UI prefs; its cached stage/clock are used only if the server has nothing yet or is unreachable.
    const stageRaw = window.localStorage.getItem("hyphen-countdown-stage")
    const clockRaw = window.localStorage.getItem("hyphen-countdown-clock")
    const applyLocalFallback = () => {
      try {
        if (stageRaw) applyStage(JSON.parse(stageRaw) as Partial<StageOptions>)
        const clock = clockRaw ? (JSON.parse(clockRaw) as { testUntil?: number | null; pausedAt?: number | null }) : null
        if (typeof clock?.testUntil === "number") setTestUntil(clock.testUntil)
        if (typeof clock?.pausedAt === "number") setPausedAt(new Date(clock.pausedAt))
      } catch {
        /* ignore a bad local cache */
      }
    }
    const savedRtmp = window.localStorage.getItem("hyphen-countdown-rtmp")
    if (savedRtmp) setLegacyRtmp(savedRtmp) // pre-server-destinations URL: offered once as "Save to server as …"
    void fetch("/api/event", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { event?: unknown; testUntil?: unknown; pausedAt?: unknown; stage?: Partial<StageOptions>; hasSaved?: boolean; rev?: unknown; recovered?: unknown }) => {
        if (typeof body.rev === "number") revRef.current = body.rev
        if (body.recovered === "backup" || body.recovered === "defaults") setRecovered(body.recovered)
        const saved = asEventConfig(body.event)
        // data/event.json is the source of truth once it exists; localStorage is only a fallback draft.
        const serverWins = body.hasSaved === true
        if (saved && (serverWins || !window.localStorage.getItem("hyphen-countdown-event"))) updateEvent(saved)
        if (serverWins) {
          setTestUntil(typeof body.testUntil === "number" ? body.testUntil : null)
          setPausedAt(typeof body.pausedAt === "number" ? new Date(body.pausedAt) : null)
          if (body.stage) applyStage(body.stage)
        } else applyLocalFallback()
        setPublished({ event: saved ?? { ...DEFAULT_EVENT }, stage: parseStage(body.stage) })
        // Unsaved section drafts from before a reload stay drafts on top of what /stream has.
        for (const values of Object.values(readStoredDrafts())) {
          if (values?.event) updateEvent(values.event)
          if (values?.stage) applyStage(values.stage)
        }
      })
      .catch(applyLocalFallback)
      .finally(() => setHydrated(true))
  }, [updateEvent, applyStage])

  const draftStage: StageOptions = { checker, showMeta, showLink, transparent, lineSpacing, blockGap, clockScale, clockText, logoUrl, speakers, gallerySeconds, galleryPause, galleryOffset, galleryScale, endTitle, endSubtitle, endDate, endBody, endQrUrl, endButton, endAt, forceEnd, holdCountdown, breakTitle, breakMessage, breakImage, breakFit, holdTitle, holdMessage, holdImage, holdFit, welcomeTitle, welcomeMessage, welcomeImage, welcomeFit, overlay, overlayAt, program, programSource, deskLive: liveMode }
  const draftJson = JSON.stringify({ event, stage: draftStage })
  const draftSnap = useParsedJson<DeskSnapshot>(draftJson)
  const drafts = useSectionDrafts(draftSnap, published, hydrated)

  useEffect(() => {
    if (!hydrated) return
    window.localStorage.setItem("hyphen-countdown-stage", JSON.stringify(draftSnap.stage))
  }, [hydrated, draftSnap])

  useEffect(() => {
    if (!hydrated || !valid) return
    // Follows testUntil/pausedAt whoever set them (this desk or a synced one): clearing the test clock
    // on another device must put this preview back on real time too, not just hide the banner.
    setSkewMs((current) => previewSkew(target.getTime(), testUntil, pausedMs || null, current))
    window.localStorage.setItem("hyphen-countdown-clock", JSON.stringify({ testUntil, pausedAt: pausedMs || null }))
  }, [hydrated, valid, target, testUntil, pausedMs])

  const loadDests = useCallback(async () => {
    const response = await fetch("/api/rtmp-destinations", { cache: "no-store" }).catch(() => null)
    if (!response?.ok) return
    const body = (await response.json().catch(() => null)) as { selectedId?: string | null; selectedCaptureId?: string | null; items?: Dest[] } | null
    if (body && Array.isArray(body.items)) setDests({ selectedId: body.selectedId ?? null, selectedCaptureId: body.selectedCaptureId ?? null, items: body.items })
  }, [])
  useEffect(() => {
    if (!hydrated) return
    const first = window.setTimeout(() => void loadDests(), 0)
    // Same cadence as desk sync, so a destination added or selected on another device shows up here.
    const id = window.setInterval(() => void loadDests(), 2000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [hydrated, loadDests])
  async function destAction(payload: Record<string, unknown>): Promise<boolean> {
    setDestError("")
    const response = await fetch("/api/rtmp-destinations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null)
    if (!response) {
      setDestError("Could not reach the server.")
      return false
    }
    if (handleUnauthorized(response)) return false
    const body = (await response.json().catch(() => null)) as { error?: string; selectedId?: string | null; selectedCaptureId?: string | null; items?: Dest[] } | null
    if (!response.ok) {
      setDestError(body?.error ?? `Server returned ${response.status}.`)
      return false
    }
    if (body && Array.isArray(body.items)) setDests({ selectedId: body.selectedId ?? null, selectedCaptureId: body.selectedCaptureId ?? null, items: body.items })
    return true
  }
  async function revealDest(id: string) {
    if (revealed?.id === id) {
      setRevealed(null)
      return
    }
    const response = await fetch("/api/rtmp-destinations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reveal", id }) }).catch(() => null)
    if (!response || handleUnauthorized(response)) return
    const body = (await response.json().catch(() => null)) as { url?: string } | null
    if (response.ok && body?.url) {
      setRevealed({ id, url: body.url })
      window.setTimeout(() => setRevealed((current) => (current?.id === id ? null : current)), 30_000)
    }
  }
  // Two-step copy for secrets: the URL must be fetched first, and an awaited fetch would end the
  // click gesture (iOS/http copy then fails). First tap reveals + arms; the next tap copies synchronously.
  async function copyDest(id: string) {
    if (revealed?.id === id) {
      void copy("dest", revealed.url, "destination URL")
      return
    }
    await revealDest(id)
  }
  function forgetLegacy() {
    window.localStorage.removeItem("hyphen-countdown-rtmp")
    setLegacyRtmp(null)
  }

  // Autosave carries the published sections plus live switches; section drafts never leave the browser.
  const savePayload = {
    event: published?.event ?? event,
    testUntil,
    pausedAt: pausedMs || null,
    stage: published ? savePayloadStage(published, draftSnap) : draftStage,
  }
  const payloadJson = JSON.stringify(savePayload)
  const saveTimer = useRef<number | null>(null)
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  const saveSeq = useRef(0)
  const lastSent = useRef("")
  const pendingSaves = useRef(0)

  // ---------- live sync between desks (MacBook, iPhone, other tabs) ----------
  const [conflicts, setConflicts] = useState<Partial<Record<SectionId, SectionValues>>>({})
  const syncNowRef = useRef<() => void>(() => undefined)
  const syncStateRef = useRef({ published, draftSnap })
  useEffect(() => {
    syncStateRef.current = { published, draftSnap }
  })
  const pullRemote = useCallback(async (force = false) => {
    if (pendingSaves.current > 0 || saveTimer.current !== null) return // our own save is on its way; check next tick
    const response = await fetch("/api/event", { cache: "no-store" }).catch(() => null)
    if (!response?.ok) return
    const body = (await response.json().catch(() => null)) as { event?: unknown; testUntil?: unknown; pausedAt?: unknown; stage?: Partial<StageOptions>; rev?: unknown } | null
    if (!body || typeof body.rev !== "number") return
    if (!force && body.rev === revRef.current) return
    if (pendingSaves.current > 0) return
    const { published: current, draftSnap: draft } = syncStateRef.current
    if (!current) return
    const remote: DeskSnapshot = { event: asEventConfig(body.event) ?? current.event, stage: parseStage(body.stage) }
    const plan = planRemoteSync(draft, current, remote)
    for (const id of plan.take) {
      const values = pickSection(id, remote)
      if (values.event) updateEvent(values.event)
      if (values.stage) applyStage(values.stage)
    }
    // Live switches and the test clock always follow the server.
    applyStage(Object.fromEntries(IMMEDIATE_STAGE.map((key) => [key, remote.stage[key]])) as Partial<StageOptions>)
    setTestUntil(typeof body.testUntil === "number" ? body.testUntil : null)
    setPausedAt(typeof body.pausedAt === "number" ? new Date(body.pausedAt) : null)
    setPublished(remote)
    revRef.current = body.rev
    lastSent.current = ""
    setConflicts((existing) => {
      const next = { ...existing }
      for (const id of plan.conflicts) next[id] = pickSection(id, remote)
      for (const id of plan.take) delete next[id]
      return next
    })
    setSyncState("saved")
    setSyncError("")
    if (plan.conflicts.length) {
      showToast("conflict", `${plan.conflicts.map((id) => SECTIONS[id].label).join(", ")}: choose Load theirs or Keep mine.`)
    } else if (Date.now() - lastSyncToastAt.current > 10_000) {
      // Throttled: a busy other desk would otherwise toast on every change.
      lastSyncToastAt.current = Date.now()
      showToast("sync", "Settings updated from another device.")
    }
  }, [updateEvent, applyStage, showToast, setPausedAt, setTestUntil])
  useEffect(() => {
    syncNowRef.current = () => void pullRemote(true)
  }, [pullRemote])
  // Instant sync: the deck WebSocket pushes the rev on every save; the 2s poll below stays as the fallback.
  const { link: wsLink } = useDeckSocket({
    poll: false,
    onState: (remote) => {
      // pullRemote skips while this desk's own autosave is pending; retry briefly so a push isn't lost until the next poll.
      let tries = 0
      const pull = () => {
        if ((revRef.current ?? -1) >= remote.rev || tries++ > 15) return
        syncNowRef.current()
        window.setTimeout(pull, 150)
      }
      pull()
    },
  })
  useEffect(() => {
    if (!hydrated) return
    const id = window.setInterval(() => void pullRemote(), 2000)
    const onFocus = () => void pullRemote()
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onFocus)
    return () => {
      window.clearInterval(id)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onFocus)
    }
  }, [hydrated, pullRemote])

  /** Serialised save: one PUT at a time, in order; only the newest response updates the badge. */
  function sendSave(payload: typeof savePayload, after?: (ok: boolean) => void) {
    if (!token || !published) return
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const json = JSON.stringify(payload)
    if (json === lastSent.current) return
    lastSent.current = json
    const seq = ++saveSeq.current
    pendingSaves.current += 1
    saveChain.current = saveChain.current.then(async () => {
      try {
        const response = await fetch("/api/event", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...JSON.parse(json), rev: revRef.current }),
        })
        if (handleUnauthorized(response)) return
        after?.(response.ok)
        if (response.ok) {
          const saved = (await response.json().catch(() => null)) as { rev?: number } | null
          if (typeof saved?.rev === "number") revRef.current = saved.rev
        }
        if (seq !== saveSeq.current) return
        if (response.status === 409) {
          // Someone else saved first: pull their version in (drafts kept, conflicts flagged), then autosave retries.
          lastSent.current = ""
          setSyncState("conflict")
          setSyncError("Changed on another device. Pulled the latest; check any flagged sections.")
          window.setTimeout(() => syncNowRef.current(), 0)
          return
        }
        if (response.ok) {
          setSyncState("saved")
          setSyncError("")
          return
        }
        const body = (await response.json().catch(() => null)) as { error?: string } | null
        lastSent.current = ""
        setSyncState("error")
        setSyncError(body?.error ?? `Server returned ${response.status}.`)
      } catch {
        after?.(false)
        if (seq !== saveSeq.current) return
        lastSent.current = ""
        setSyncState("local")
        setSyncError("Could not reach the server.")
      } finally {
        pendingSaves.current -= 1
      }
    })
  }
  /** Put a section's saved values (or a stored draft) back into the desk fields. */
  function applyDraft(values: SectionValues) {
    if (values.event) updateEvent(values.event)
    if (values.stage) applyStage(values.stage)
  }

  /** Publish one or more sections: only their fields change on /stream. Failed saves (incl. 409) put the draft back. */
  function saveSections(ids: SectionId[]) {
    if (!published || ids.length === 0) return
    const before = published
    const next = ids.reduce((acc, id) => withSection(id, acc, draftSnap), before)
    setPublished(next)
    sendSave({ ...savePayload, event: next.event, stage: savePayloadStage(next, draftSnap) }, (ok) => {
      if (!ok) setPublished((current) => (current ? ids.reduce((acc, id) => withSection(id, acc, before), current) : current))
    })
  }

  function discardSection(id: SectionId) {
    if (published) applyDraft(pickSection(id, published))
  }

  function draftBar(id: SectionId) {
    const theirs = conflicts[id]
    const notice = theirs ? (
      <div role="alert" data-testid={`conflict-${id}`} className="flex flex-wrap items-center gap-2 rounded-xl border border-[#b45309]/40 bg-[#b45309]/10 px-3 py-2 font-mono text-[13px] font-bold text-[#7a3b06]">
        <span className="mr-auto">Changed on another device</span>
        <button type="button" data-testid={`load-theirs-${id}`} className={pillClass("outline", "sm")} onClick={() => { applyDraft(theirs); setConflicts((c) => { const n = { ...c }; delete n[id]; return n }) }}>Load theirs</button>
        <button type="button" data-testid={`keep-mine-${id}`} className={pillClass("live", "sm")} onClick={() => { setConflicts((c) => { const n = { ...c }; delete n[id]; return n }); saveSections([id]) }}>Keep mine</button>
      </div>
    ) : null
    return <>{notice}<DraftBar id={id} dirty={drafts.isDirty(id)} canSave={Boolean(token)} onSave={() => saveSections([id])} onDiscard={() => discardSection(id)} pillClass={(tone, size) => pillClass(tone, size)} /></>
  }

  /** Live switch for /stream: break, hold, end card or countdown (mutually exclusive). */
  function showScreen(next: Screen) {
    runTransport({ type: "screen", screen: next })
  }

  async function uploadImage(file: File, apply: (url: string) => void) {
    const response = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file })
    if (handleUnauthorized(response)) return
    const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null
    if (response.ok && body?.url) apply(body.url)
    else setToast(body?.error ?? `Upload failed (${response.status}).`)
  }

  const sendSaveRef = useRef(sendSave)
  useEffect(() => {
    sendSaveRef.current = sendSave
  })

  useEffect(() => {
    if (!token || !hydrated || !published) return
    const id = window.setTimeout(() => {
      saveTimer.current = null
      sendSaveRef.current(JSON.parse(payloadJson))
    }, 400)
    saveTimer.current = id
    return () => {
      window.clearTimeout(id)
      // A cancelled debounce must not leave a stale handle: live sync skips while a save is "pending".
      if (saveTimer.current === id) saveTimer.current = null
    }
  }, [payloadJson, token, hydrated, published])

  const stableHref = useMemo(() => {
    const params = new URLSearchParams()
    // The OBS link carries only published Look values, so a Look draft never leaks into OBS via the URL.
    const look = published?.stage ?? { checker, showMeta, showLink, transparent }
    if (look.checker !== 6) params.set("grid", String(look.checker))
    if (!look.showMeta) params.set("meta", "0")
    if (!look.showLink) params.set("showlink", "0")
    if (look.transparent) params.set("bg", "clear")
    if (operator.viewKey) params.set("k", operator.viewKey)
    const query = params.toString()
    return query ? `/stream?${query}` : "/stream"
  }, [published, checker, showMeta, showLink, transparent, operator.viewKey])
  const endHref = operator.viewKey ? `/end?k=${encodeURIComponent(operator.viewKey)}` : "/end"

  async function rotateViewKey() {
    const response = await fetch("/api/view-key", { method: "POST" })
    if (handleUnauthorized(response)) return
    const body = (await response.json().catch(() => null)) as { key?: string; error?: string } | null
    if (response.ok && body?.key) setOperator((current) => ({ ...current, viewKey: body.key ?? "" }))
    else if (body?.error) setToast(body.error)
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined)
    hardNavigate("/login")
  }

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
  const endTarget = endInstant(date, time, endAt || endTime, timeZone)
  const endRemaining = previewNow ? remainingUntil(endTarget, previewNow) : null
  const previewScreen = stageScreen({ overlay, forceEnd, holdCountdown, program }, Boolean(previewNow && endTarget.getTime() <= previewNow.getTime()))

  /**
   * Every Transport button goes through lib/transport (the same code the phone deck runs on the
   * server), then into this desk's state and straight to the server.
   */
  function runTransport(action: TransportAction) {
    const base = { event: published?.event ?? event, testUntil, pausedAt: pausedMs || null, stage: savePayload.stage }
    const result = applyTransport(base, action, nowMs())
    if (!result.ok) {
      setToast(result.error)
      return false
    }
    const next = result.next
    setTestUntil(next.testUntil)
    setPausedAt(next.pausedAt !== null ? new Date(next.pausedAt) : null)
    if (next.pausedAt === null) {
      const nextTarget = wallTimeInZone(next.event.date, next.event.time, next.event.timeZone).getTime()
      setSkewMs(next.testUntil !== null && Number.isFinite(nextTarget) ? nextTarget - next.testUntil : 0)
    }
    if (action.type === "screen") {
      setOverlay(next.stage.overlay)
      setOverlayAt(next.stage.overlayAt)
      setProgram(next.stage.program)
      setForceEnd(next.stage.forceEnd)
      setHoldCountdown(next.stage.holdCountdown)
    }
    if (action.type === "programSource") setProgramSource(next.stage.programSource)
    if (action.type === "mode") setLiveMode(next.stage.deskLive)
    if (action.type === "extendEnd" || action.type === "setEnd") {
      // A quick action: goes live straight away, like restore (the sections weren't dirty, see extendEnd).
      const end = { endTime: next.event.endTime }
      updateEvent(end)
      setEndAt(next.stage.endAt)
      setPublished((current) => (current ? { ...current, event: { ...current.event, ...end }, stage: { ...current.stage, endAt: next.stage.endAt } } : current))
    }
    if (action.type === "restore") {
      const restored = { date: next.event.date, time: next.event.time, timeZone: next.event.timeZone }
      // A transport action: the restored date goes live straight away (not a draft).
      updateEvent(restored)
      setPublished((current) => (current ? { ...current, event: { ...current.event, ...restored } } : current))
    }
    sendSave({ event: next.event, testUntil: next.testUntil, pausedAt: next.pausedAt, stage: next.stage })
    return true
  }
  /**
   * +5 / +10 min on the end time (the end card override if set, else Event › End time).
   * If that section has an unsaved draft, the extension goes into the draft (Save publishes it,
   * like any other edit); otherwise it's saved straight away with an Undo toast.
   */
  function extendEnd(minutes: number) {
    if (drafts.isDirty("endCard") || (!endAt && drafts.isDirty("event"))) {
      const t = extendTarget(endTime, endAt, minutes)
      const check = applyTransport({ event, testUntil, pausedAt: pausedMs || null, stage: { ...draftStage, deskLive: false } }, { type: "extendEnd", minutes }, nowMs())
      if (!check.ok) return setToast(check.error)
      if (t.field === "endAt") setEndAt(t.to)
      else updateEvent({ endTime: t.to })
      showToast("extend", `Draft end ${t.to} · Save to apply`)
      return
    }
    const prev = { endTime: published?.event.endTime ?? endTime, endAt: published?.stage.endAt ?? endAt }
    const t = extendTarget(prev.endTime, prev.endAt, minutes)
    if (!runTransport({ type: "extendEnd", minutes })) return
    showToast("extend", `${minutes < 0 ? "Shortened" : "Extended"} to ${t.to}`, () => {
      if (runTransport({ type: "setEnd", ...prev })) showToast("extend", `End back to ${prev.endAt || prev.endTime}`)
    })
  }
  /** Main/Backup: through the server's transport (logged, synced to every device over the deck socket). */
  async function switchProgramSource(source: ProgramSource) {
    const response = await fetch("/api/deck/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: { type: "programSource", source } }) }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as { ok?: boolean; error?: string; state?: { programSource?: ProgramSource; programSources?: ProgramSourcesView | null } } | null
    if (!response?.ok || !body?.ok) return setToast(body?.error ?? "Could not switch the program source.")
    if (body.state?.programSource) setProgramSource(body.state.programSource)
    if (body.state) setSources(body.state.programSources ?? null)
  }
  async function saveFailover(patch: Partial<FailoverSettings>) {
    const response = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "failover", failover: patch }) }).catch(() => null)
    if (!response?.ok) setToast("Could not save the failover setting.")
  }
  const jumpPreview = (seconds: number) => runTransport({ type: "jump", seconds })
  const goLiveNow = () => runTransport({ type: "goLive" })
  const restoreFestival = () => runTransport({ type: "restore" })

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      if (event.key === "?") {
        event.preventDefault()
        setShowHelp((value) => !value)
        return
      }
      if (event.key === "Escape") {
        setShowHelp(false)
        return
      }
      if (liveModeRef.current) return // Live mode: no keyboard shortcuts touch /stream
      // Buttons handle Space themselves when focused; only take it when focus is elsewhere.
      if (event.key === " " && target?.tagName !== "BUTTON" && target?.tagName !== "A") {
        event.preventDefault()
        pauseRef.current?.click()
        return
      }
      const confirmTarget = event.key.toLowerCase() === "g" ? goLiveRef.current : event.key.toLowerCase() === "r" ? resetRef.current : null
      if (confirmTarget) {
        // Same two-step confirm as clicking: first press arms, second press within 3s runs it.
        event.preventDefault()
        confirmTarget.focus()
        confirmTarget.click()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Call synchronously from the click (no await before it): on plain-http LAN origins only the
  // in-gesture execCommand fallback works. If the browser refuses, a dialog shows the text selected.
  async function copy(kind: "stream" | "file" | "link" | "params" | "dest", value: string, label = "text") {
    const result = await copyOrShow(label, value)
    if (result !== "copied") return
    setCopied(kind)
    window.setTimeout(() => setCopied(null), 1600)
    showToast("copy", kind === "dest" ? "Destination URL (with stream key)" : value)
  }

  return (
    <div data-desk-root data-pin-spacer={pinPreview ? "true" : undefined} className={`min-h-dvh bg-[#F6F6F3] text-black ${pinPreview ? "pt-[calc(min(26svh,(100vw-2rem)*9/16)+1rem+env(safe-area-inset-top))] sm:pt-[calc(min(26svh,(100vw-3rem)*9/16)+1rem+env(safe-area-inset-top))] lg:pt-0" : ""} [&_input]:rounded-xl [&_input]:border-black/10 [&_input]:bg-[#F6F6F3] [&_select]:rounded-xl [&_select]:border-black/10 [&_select]:bg-[#F6F6F3]`}>
      <BackToTop />
      <CopyFallbackHost />
      <header ref={headerRef} className="z-20 lg:sticky lg:top-0 border-b border-black/10 bg-white/90 px-4 py-4 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-mono text-[12px] tracking-[0.16em] text-black/70 uppercase">
              Hyphen Festival 2026
            </p>
            <h1 className="text-xl font-black tracking-tight uppercase">Countdown desk</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="hidden items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1.5 font-mono text-[13px] md:inline-flex">
              <span className="text-black/70">Target</span>
              <span>{valid ? formatClock(target, timeZone) : "—"}</span>
              <span className={`rounded px-1.5 py-0.5 text-[12px] ${previewRemaining?.done ? "bg-[#d93200] text-white" : "bg-[#D9FF43]"}`}>
                {previewRemaining?.done ? "LIVE" : "Armed"}
              </span>
            </span>
            {drafts.dirty.length ? (
              <Pill size="sm" tone="live" data-testid="save-all" disabled={!token} title={drafts.dirty.map((id) => SECTIONS[id].label).join(", ")} onClick={() => saveSections(drafts.dirty)}>
                Save all ({drafts.dirty.length})
              </Pill>
            ) : null}
            <Link href="/deck" data-testid="deck-link" title={wsLink === "live" ? "Instant sync on (WebSocket)" : "Instant sync off: syncing every 2s"} className={`${pillClass("outline", "sm")} inline-flex items-center gap-1.5 no-underline`}>
              <span aria-hidden className={`size-2 rounded-full ${wsLink === "live" ? "bg-[#12b76a]" : "bg-[#f79009]"}`} />
              Deck
            </Link>
            <SyncBadge state={syncState} hasToken={operator.operator || !operator.ready} error={syncError} />
            {operator.mode === "password" ? <Pill size="sm" tone="outline" onClick={() => void logout()}>Log out</Pill> : null}
            <Pill size="sm" tone="outline" aria-label="Keyboard shortcuts" aria-keyshortcuts="?" onClick={() => setShowHelp((value) => !value)}>?</Pill>
            <Pill size="sm" onClick={() => copy("link", `${window.location.origin}${stableHref}`)}>
              {copied === "link" ? "Copied" : "Copy OBS URL"}
            </Pill>
            <Button nativeButton={false} render={<Link href={stableHref} target="_blank" rel="noreferrer" />} className={pillClass()}>
              Open /stream in new window
            </Button>
          </div>
        </div>
      </header>
      {syncState === "conflict" ? (
        <div role="alert" data-testid="conflict-banner" className="border-b border-[#b42318]/40 bg-[#b42318]/10 px-4 py-3 font-mono text-[13px] text-[#8a1c13] sm:px-6">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
            <span>Changed in another tab or device. This tab is not saving, so it can&apos;t overwrite those changes.</span>
            <Pill size="sm" onClick={() => window.location.reload()}>Reload latest</Pill>
          </div>
        </div>
      ) : null}
      {recovered ? (
        <div role="alert" data-testid="recovered-banner" className="border-b border-[#b45309]/40 bg-[#b45309]/10 px-4 py-3 font-mono text-[13px] text-[#7a3b06] sm:px-6">
          <div className="mx-auto max-w-[1600px]">
            {recovered === "backup"
              ? "data/event.json was unreadable, so the last good copy (event.json.bak) is loaded. Check the event, then any change saves a fresh file."
              : "data/event.json and its backup were unreadable, so defaults are showing. Re-enter the event before going live."}
          </div>
        </div>
      ) : null}
      {testUntil !== null || pausedAt ? (
        <div role="status" data-testid="test-clock-banner" className="border-b border-black bg-[#D9FF43] px-4 py-2 font-mono text-[13px] font-bold text-black sm:px-6">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
            <span className="tracking-[0.12em] uppercase">Test clock active</span>
            <span className="font-normal">/stream shows the {pausedAt ? "paused" : "test"} clock, not the real countdown. It expires on /stream after 2 hours.</span>
            <Pill size="sm" onClick={() => { setPausedAt(null); setSkewMs(0); setTestUntil(null) }}>Clear test clock</Pill>
          </div>
        </div>
      ) : null}
      {!valid ? (
        <div role="alert" className="border-b border-[#ff3c00]/40 bg-[#ff3c00]/10 px-4 py-3 font-mono text-[13px] text-[#a32600] sm:px-6">
          <div className="mx-auto max-w-[1600px]">
            Countdown is not running: {eventProblems(event).join(" ") || "the start date or time is invalid."} Fix it in Event details; /stream keeps the last valid save.
          </div>
        </div>
      ) : null}

      <main className="mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-6 sm:px-6 w-full lg:flex-row">
        <section className="space-y-4 lg:w-[380px] lg:shrink-0">
          <div className="rounded-[20px] bg-black p-5 text-white">
            {previewRemaining?.done ? (
              <div>
                <p className="font-mono text-[13px] tracking-[0.14em] text-[#ff3c00] uppercase">Live</p>
                <p className="mt-2 text-2xl font-black">Doors are open</p>
              </div>
            ) : (
              <>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-mono text-[13px] tracking-[0.14em] text-white/75 uppercase">
                Live countdown · {timeZone}
              </h2>
              <span className="inline-flex items-center gap-1.5 font-mono text-[12px] uppercase">
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
                  <div className="mt-1 font-mono text-[12px] tracking-[0.12em] text-white/75 uppercase">{unit.label}</div>
                </div>
              ))}
            </div>
              </>
            )}
          </div>

          <div className="rounded-[20px] bg-black p-5 text-white">
            {forceEnd || (!holdCountdown && endRemaining?.done) ? (
              <div>
                <p className="font-mono text-[13px] tracking-[0.14em] text-[#ff3c00] uppercase">End card</p>
                <p className="mt-2 text-2xl font-black">End card is on</p>
              </div>
            ) : (
              <>
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="font-mono text-[13px] tracking-[0.14em] text-white/75 uppercase">End card in</h2>
                  <span className="font-mono text-[12px] text-white/75 uppercase">{endAt}</span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { value: endRemaining ? String(endRemaining.days) : "--", label: "Days" },
                    { value: endRemaining ? pad2(endRemaining.hours) : "--", label: "Hours" },
                    { value: endRemaining ? pad2(endRemaining.minutes) : "--", label: "Mins" },
                    { value: endRemaining ? pad2(endRemaining.seconds) : "--", label: "Secs" },
                  ].map((unit) => (
                    <div key={unit.label} className="rounded-[14px] border border-white/10 bg-white/10 px-2 py-3 text-center">
                      <div className="font-mono text-[28px] leading-none font-black tabular-nums">{unit.value}</div>
                      <div className="mt-1 font-mono text-[12px] tracking-[0.12em] text-white/75 uppercase">{unit.label}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <Panel title="Transport" pill={liveMode ? "Live · locked" : "Rehearsal"}>
            <div role="radiogroup" aria-label="Desk mode" className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-1 rounded-full bg-black/5 p-1">
              <button type="button" role="radio" aria-checked={!liveMode} data-testid="mode-rehearsal" onClick={() => runTransport({ type: "mode", live: false })} className={`h-8 rounded-full font-mono text-[13px] ${!liveMode ? "bg-black text-white" : "text-black/70"}`}>Rehearsal</button>
              <button type="button" role="radio" aria-checked={liveMode} data-testid="mode-live" onClick={() => runTransport({ type: "mode", live: true })} className={`h-8 rounded-full font-mono text-[13px] ${liveMode ? "bg-[#d93200] text-white" : "text-black/70"}`}>Live</button>
            </div>
            {program && rtmpChannels.slate.running ? <p data-testid="slate-program-note" className="rounded-lg bg-[#b45309]/10 px-2 py-1 font-mono text-[12px] leading-5 text-[#7a3b06]">The Slate channel (ffmpeg text) can&apos;t show the OBS program; it keeps the countdown. Use Browser capture for the program.</p> : null}
            {liveMode ? <p className="font-mono text-[12px] leading-5 text-black/70">Live: test clocks, pause, reset, restore and keyboard shortcuts are locked. Go live now and the end card still work.</p> : null}
            <div className="flex flex-wrap gap-2">
              {[
                [15, "15s"],
                [600, "10min"],
                [1800, "30min"],
                [3600, "1 hour"],
              ].map(([seconds, label]) => (
                <Pill key={label} size="sm" disabled={liveMode} title={liveMode ? "Switch to Rehearsal to use test clocks" : undefined} onClick={() => jumpPreview(Number(seconds))}>{label} left</Pill>
              ))}
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
              <Pill ref={pauseRef} aria-keyshortcuts="Space" disabled={liveMode} onClick={() => runTransport({ type: pausedAt ? "resume" : "pause" })}>
                {pausedAt ? "Play" : "Pause"}
              </Pill>
              <ConfirmButton ref={resetRef} aria-keyshortcuts="R" disabled={liveMode} className={pillClass("danger")} onConfirm={() => runTransport({ type: "reset" })}>Reset clock</ConfirmButton>
              <ConfirmButton ref={goLiveRef} aria-keyshortcuts="G" className={pillClass("live")} onConfirm={goLiveNow}>Go live now</ConfirmButton>
              <ConfirmButton disabled={liveMode} className={pillClass("danger")} onConfirm={restoreFestival}>Restore 4 Nov</ConfirmButton>
              <a href="/end" target="_blank" rel="noreferrer" className={`${pillClass()} col-span-2 no-underline`}>Open end card</a>
              <ConfirmButton data-testid="show-end" className={`${pillClass()} whitespace-nowrap`} confirmLabel="Show end card · confirm" onConfirm={() => showScreen("end")}>Show end card now</ConfirmButton>
              <ConfirmButton data-testid="back-to-countdown" className={`${pillClass("outline")} whitespace-nowrap`} confirmLabel="Back to countdown · confirm" onConfirm={() => showScreen("countdown")}>Back to countdown</ConfirmButton>
              <ConfirmButton data-testid="show-program" className={`${pillClass(program ? "solid" : "outline")} col-span-2 whitespace-nowrap`} confirmLabel="Show OBS program · confirm" title="Full-frame OBS feed (relay /program) on /stream. Break/hold/welcome cards still go on top." onConfirm={() => showScreen("program")}>{program ? (overlay !== "none" ? "● Program (under card)" : "● Program (OBS) on") : "Show program (OBS)"}</ConfirmButton>
              <div className="col-span-2"><ProgramSourceSwitch view={sources} active={programSource} onSwitch={(source) => void switchProgramSource(source)} onFailover={(patch) => void saveFailover(patch)} /></div>
              <ConfirmButton data-testid="show-break" className={`${pillClass(overlay === "break" ? "solid" : "outline")} whitespace-nowrap`} confirmLabel="Show break · confirm" onConfirm={() => showScreen("break")}>{overlay === "break" ? "● Break card on" : "Show break card"}</ConfirmButton>
              <ConfirmButton data-testid="show-hold" className={`${pillClass(overlay === "hold" ? "solid" : "outline")} whitespace-nowrap`} confirmLabel="Show hold · confirm" onConfirm={() => showScreen("hold")}>{overlay === "hold" ? "● Hold card on" : "Show hold card"}</ConfirmButton>
              <ConfirmButton data-testid="show-welcome" className={`${pillClass(overlay === "welcome" ? "solid" : "outline")} whitespace-nowrap`} confirmLabel="Show welcome · confirm" onConfirm={() => showScreen("welcome")}>{overlay === "welcome" ? "● Welcome card on" : "Show welcome card"}</ConfirmButton>
            </div>
            <p className="font-mono text-[12px] leading-5 text-black/70">
              Pause, play, go live, restore and the break/hold/welcome/end card buttons go to the live /stream straight away. On /stream a break, hold or welcome card beats the end card, which beats the countdown. Restore 4 Nov clears the test and puts 4 November 09:30 back in the date fields.
            </p>
          </Panel>

          <Panel id="event" title="Event" pill="Editable" dirty={drafts.isDirty("event")}>
            {draftBar("event")}
            <Field label="Session title" htmlFor="name">
              <GrowingText id="name" value={name} onChange={(value) => updateEvent({ name: value })} />
            </Field>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
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
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
              <Field label="Start time" htmlFor="time">
                <Input id="time" type="time" value={time} onChange={(event) => updateEvent({ time: event.target.value })} />
              </Field>
              <Field label="End time" htmlFor="endTime">
                <Input id="endTime" type="time" value={endTime} onChange={(event) => updateEvent({ endTime: event.target.value })} />
                {endAt ? null : <div className="mt-1.5 flex flex-wrap items-center gap-1">{EXTENDS.map((m) => <button key={m} type="button" data-testid={`extend-event-${m < 0 ? `minus${-m}` : m}`} disabled={!token} onClick={() => extendEnd(m)} className="h-7 min-w-10 rounded-full border border-black/20 bg-white px-2 font-mono text-[12px] font-bold tabular-nums hover:bg-black/5 disabled:opacity-40">{m < 0 ? `−${-m}` : `+${m}`}</button>)}<span className="ml-0.5 font-mono text-[12px] text-black/60">min</span></div>}
              </Field>
            </div>
            <Field label="Venue" htmlFor="venue">
              <GrowingText id="venue" value={venue} onChange={(value) => updateEvent({ venue: value })} />
            </Field>
          </Panel>

          <Panel id="cta" title="Links & call to action" dirty={drafts.isDirty("cta")}>
            {draftBar("cta")}
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

          <Panel id="look" title="Look" dirty={drafts.isDirty("look")}>
            {draftBar("look")}
            <label className="flex items-center gap-2 font-mono text-[13px] tracking-[0.08em] text-black/70 uppercase">
              <input type="checkbox" className="size-4 accent-black" checked={showMeta} onChange={(event) => setShowMeta(event.target.checked)} />
              Show date and timezone
            </label>
            <label className="flex items-center gap-2 font-mono text-[13px] tracking-[0.08em] text-black/70 uppercase">
              <input type="checkbox" className="size-4 accent-black" checked={showLink} onChange={(event) => setShowLink(event.target.checked)} />
              Show event link
            </label>
            <label className="flex items-center gap-2 font-mono text-[13px] tracking-[0.08em] text-black/70 uppercase">
              <input type="checkbox" className="size-4 accent-black" checked={transparent} onChange={(event) => setTransparent(event.target.checked)} />
              Transparent background
            </label>
            <Field label="Title line spacing" htmlFor="spacing">
              <input id="spacing" type="range" min="0.8" max="2.2" step="0.05" value={lineSpacing} onChange={(event) => setLineSpacing(Number(event.target.value))} className="w-full accent-black" />
              <span className="font-mono text-[13px] text-black/70">{lineSpacing.toFixed(2)}</span>
            </Field>
            <Field label="Gap below address" htmlFor="blockGap">
              <input id="blockGap" type="range" min="0" max="8" step="0.1" value={blockGap} onChange={(event) => setBlockGap(Number(event.target.value))} className="w-full accent-black" />
              <span className="font-mono text-[13px] text-black/70">{blockGap.toFixed(1)}</span>
            </Field>
            <Field label="Countdown size (boxes and text)" htmlFor="clockScale">
              <input id="clockScale" type="range" min={CLOCK_SCALE_RANGE.min} max={CLOCK_SCALE_RANGE.max} step="0.05" value={clockScale} onChange={(event) => setClockScale(Number(event.target.value))} className="w-full accent-black" />
              <span className="font-mono text-[13px] text-black/70">
                {clockScale.toFixed(2)}×
                {fitClockScale(clockScale, clockText) < clockScale - 0.005
                  ? ` · shown at ${fitClockScale(clockScale, clockText).toFixed(2)}× so it fits beside the logo`
                  : ""}
              </span>
            </Field>
            <Field label="Text size inside boxes" htmlFor="clockText">
              <input id="clockText" type="range" min={CLOCK_TEXT_RANGE.min} max={CLOCK_TEXT_RANGE.max} step="0.05" value={clockText} onChange={(event) => setClockText(Number(event.target.value))} className="w-full accent-black" />
              <span className="font-mono text-[13px] text-black/70">{clockText.toFixed(2)}× of the countdown size</span>
            </Field>
            <Field label="Logo source" htmlFor="logo">
              <GrowingText id="logo" value={logoUrl} onChange={setLogoUrl} />
              <p className="font-mono text-[12px] text-black/70">Leave blank for the Hyphen PNG. Paste an image URL to replace it.</p>
            </Field>
            <Field label="Checker division" htmlFor="checker">
              <div className="flex items-center gap-2">
                <Pill tone="outline" size="sm" aria-label="Fewer checker divisions" onClick={() => setChecker((value) => Math.max(4, value - 1))}>−</Pill>
                <span id="checker" className="min-w-16 text-center font-mono text-sm tabular-nums">{checker}×{checker}</span>
                <Pill tone="outline" size="sm" aria-label="More checker divisions" onClick={() => setChecker((value) => Math.min(12, value + 1))}>+</Pill>
              </div>
            </Field>
          </Panel>

          <Panel id="socials" title="Socials" pill={`${[xUrl, facebookUrl, linkedinUrl, instagramUrl, youtubeUrl].filter((url) => url.trim()).length}/5 links set`} defaultOpen={false} dirty={drafts.isDirty("socials")}>
            {draftBar("socials")}
              <Field label="X URL" htmlFor="x"><GrowingText id="x" value={xUrl} onChange={(value) => updateEvent({ xUrl: value })} /></Field>
              <Field label="Facebook URL" htmlFor="fb"><GrowingText id="fb" value={facebookUrl} onChange={(value) => updateEvent({ facebookUrl: value })} /></Field>
              <Field label="LinkedIn URL" htmlFor="li"><GrowingText id="li" value={linkedinUrl} onChange={(value) => updateEvent({ linkedinUrl: value })} /></Field>
              <Field label="Instagram URL" htmlFor="ig"><GrowingText id="ig" value={instagramUrl} onChange={(value) => updateEvent({ instagramUrl: value })} /></Field>
              <Field label="YouTube URL" htmlFor="yt"><GrowingText id="yt" value={youtubeUrl} onChange={(value) => updateEvent({ youtubeUrl: value })} /></Field>
            </Panel>

          <Panel id="encoder" title="Encoder (FFmpeg)" pill={rtmpChannels.slate.running && rtmpChannels.capture.running ? "2 live" : rtmpLive ? "1 live" : "off"}>
            <p className="font-mono text-[12px] text-black/70">Slate and Browser capture are separate outputs. Run either, or both at once to different destinations.</p>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
              {(["slate", "capture"] as const).map((ch) => {
                const other = ch === "slate" ? "capture" : "slate"
                const pick = (c: RtmpChannelId) => (c === "slate" ? dests.selectedId : dests.selectedCaptureId)
                return (
                  <RtmpChannelCard key={ch} channel={ch} status={rtmpChannels[ch]} dests={dests.items} selectedId={pick(ch)} otherSelectedId={pick(other)} otherRunning={rtmpChannels[other].running} canStart={valid} pubLine={pubLine}
                    onSelect={(id) => {
                      setDests((current) => (ch === "slate" ? { ...current, selectedId: id } : { ...current, selectedCaptureId: id }))
                      void destAction({ action: "select", id, channel: ch })
                    }} />
                )
              })}
              <RelayCard dests={dests.items} />
              <AudioCard />
            </div>
            <Field label="Saved destinations" htmlFor="rtmp">
              <div className="space-y-2">
                {dests.items.length ? (
                  <select
                    id="rtmp"
                    data-testid="dest-manage"
                    className="h-9 w-full px-3 text-sm"
                    value={selectedDest?.id ?? ""}
                    onChange={(event) => {
                      setRevealed(null)
                      setManageId(event.target.value || null)
                    }}
                  >
                    {dests.items.map((item) => (
                      <option key={item.id} value={item.id}>{item.name} · {item.host}</option>
                    ))}
                  </select>
                ) : (
                  <p className="font-mono text-[13px] text-black/70">No destinations saved yet. Add one (name + ingest URL with key); it is stored on this server, not in the browser.</p>
                )}
                {selectedDest ? (
                  <p data-testid="rtmp-masked" className="font-mono text-[12px] break-all text-black/70">{revealed?.id === selectedDest.id ? revealed.url : selectedDest.masked}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Pill size="sm" tone="outline" data-testid="dest-add" onClick={() => setDestForm({ mode: destForm.mode === "add" ? null : "add", name: "", url: "" })}>+ Add destination</Pill>
                  {selectedDest ? (
                    <>
                      <Pill size="sm" tone="outline" data-testid="dest-rename" onClick={() => setDestForm({ mode: destForm.mode === "rename" ? null : "rename", name: selectedDest.name, url: "" })}>Rename</Pill>
                      <Pill size="sm" tone="outline" data-testid="dest-reveal" aria-pressed={revealed?.id === selectedDest.id} onClick={() => void revealDest(selectedDest.id)}>{revealed?.id === selectedDest.id ? "Hide" : "Reveal"}</Pill>
                      <Pill size="sm" tone="outline" data-testid="dest-copy" onClick={() => void copyDest(selectedDest.id)}>{revealed?.id === selectedDest.id ? (copied === "dest" ? "Copied" : "Tap to copy") : "Copy"}</Pill>
                      <ConfirmButton data-testid="dest-delete" className={pillClass("danger", "sm")} disabled={[dests.selectedId, dests.selectedCaptureId].includes(selectedDest.id) && rtmpLive} confirmLabel={`Delete ${selectedDest.name}? · confirm`} onConfirm={() => void destAction({ action: "delete", id: selectedDest.id })}>Delete</ConfirmButton>
                    </>
                  ) : null}
                </div>
                {destForm.mode ? (
                  <form
                    data-testid="dest-form"
                    className="space-y-2 rounded-xl border border-black/10 bg-white p-3"
                    onSubmit={(event) => {
                      event.preventDefault()
                      const payload = destForm.mode === "add" ? { action: "add", name: destForm.name, url: destForm.url } : { action: "rename", id: selectedDest?.id, name: destForm.name }
                      void destAction(payload).then((ok) => {
                        if (ok) setDestForm({ mode: null, name: "", url: "" })
                      })
                    }}
                  >
                    <Input aria-label="Destination name" data-testid="dest-name" placeholder="Name, e.g. Restream main" value={destForm.name} onChange={(event) => setDestForm({ ...destForm, name: event.target.value })} />
                    {destForm.mode === "add" ? (
                      <Input aria-label="Ingest URL with key" data-testid="dest-url" type="password" autoComplete="off" placeholder="rtmp://live.restream.io/live/KEY" value={destForm.url} onChange={(event) => setDestForm({ ...destForm, url: event.target.value })} />
                    ) : null}
                    <div className="flex gap-2">
                      <button type="submit" data-testid="dest-save" className={pillClass("live", "sm")}>{destForm.mode === "add" ? "Save destination" : "Save name"}</button>
                      <button type="button" className={pillClass("outline", "sm")} onClick={() => setDestForm({ mode: null, name: "", url: "" })}>Cancel</button>
                    </div>
                  </form>
                ) : null}
                {destError ? <p role="alert" className="font-mono text-[13px] font-bold text-[#b42318]">{destError}</p> : null}
                {legacyRtmp ? (
                  <div data-testid="dest-legacy" className="space-y-2 rounded-xl border border-[#b45309]/40 bg-[#b45309]/10 p-3 font-mono text-[13px] text-[#7a3b06]">
                    <p className="font-bold">This browser has an old RTMP URL saved ({hostOf(legacyRtmp, "unknown host")}). Move it to the server so every desk can use it?</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" data-testid="dest-legacy-save" className={pillClass("live", "sm")} onClick={() => {
                        void destAction({ action: "add", name: hostOf(legacyRtmp, "Saved stream"), url: legacyRtmp }).then((ok) => { if (ok) forgetLegacy() })
                      }}>Save to server as “{hostOf(legacyRtmp, "Saved stream")}”</button>
                      <button type="button" className={pillClass("outline", "sm")} onClick={forgetLegacy}>Discard</button>
                    </div>
                  </div>
                ) : null}
              </div>
            </Field>
            {rtmpOwnCount > Math.max(1, Number(rtmpChannels.slate.running) + Number(rtmpChannels.capture.running)) || (rtmpLive && strayPids.length > 0) || (!rtmpLive && rtmpOwnCount + strayPids.length > 1) ? (
              <div role="alert" data-testid="rtmp-multiple" className="flex flex-wrap items-center gap-2 rounded-xl border border-[#b42318]/40 bg-[#b42318]/10 px-3 py-2 font-mono text-[13px] font-bold text-[#8a1c13]">
                <span>More than one stream process is running ({rtmpOwnCount} desk supervisor{rtmpOwnCount === 1 ? "" : "s"}, {strayPids.length} other ffmpeg). Viewers may see the wrong picture.</span>
                <ConfirmButton data-testid="rtmp-stop-all" className={pillClass("danger")} confirmLabel="Stop ALL streams? · confirm" onConfirm={async () => {
                  const response = await fetch("/api/encoder?target=rtmp-all", { method: "DELETE" })
                  if (handleUnauthorized(response)) return
                  const body = (await response.json().catch(() => null)) as { note?: string } | null
                  setRtmpNote(body?.note ?? "Stopped all.")
                }}>Stop all</ConfirmButton>
              </div>
            ) : null}
            {rtmpNote ? <p role="status" data-testid="rtmp-message" className="font-mono text-[13px] text-black/70">{rtmpNote}</p> : null}
            {strayPids.length > 0 ? <p className="font-mono text-[13px] text-red-600">Another ffmpeg is publishing outside this desk. PID {strayPids.join(", ")}. Stop that Terminal process, or the old picture stays on the air.</p> : null}
            <p className="font-mono text-[13px] leading-5 text-black/70">
              Start stream sends 1280×720, 30 fps, H.264 2500 kbps, yuv420p, AAC stereo 128 kbps, silent audio, FLV over RTMP. The local player is the same picture as 2-second HLS segments.
            </p>
            <CommandBlock value={streamCommand} copied={copied === "stream"} onCopy={() => copy("stream", streamCommand)} />
            <CommandBlock value={fileCommand} copied={copied === "file"} onCopy={() => copy("file", fileCommand)} />
          </Panel>
        </section>

        <section className="min-w-0 space-y-4 lg:flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              <h2 className="min-w-0 text-[13px] font-black tracking-[0.12em] uppercase">
                Preview · 16:9 hero · {transparent ? "clear edition" : "black edition"}
              </h2>
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#d93200] px-2.5 py-1 font-mono text-[12px] leading-none font-bold tracking-[0.12em] whitespace-nowrap text-white uppercase">
                <span aria-hidden className="size-1.5 rounded-full bg-white" />
                Live update
              </span>
            </div>
            <span className="max-w-full rounded-full border border-black/10 bg-white px-3 py-1.5 font-mono text-[12px] leading-4 text-black/70">
              1920×1080 · official logo · {transparent ? "transparent bg" : "black bg"} · {transparent ? "no chrome" : "hero"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 [&>button]:whitespace-nowrap" role="group" aria-label="Preview aids (preview only, not sent to OBS)">
            <span className="w-full font-mono text-[12px] tracking-[0.12em] text-black/70 uppercase sm:w-auto">Preview aids</span>
            <Pill size="sm" tone={pinPreview ? "solid" : "outline"} aria-pressed={pinPreview} onClick={() => setPinPreview(!pinPreview)}>Pin preview</Pill>
            <Pill size="sm" tone={trueObs ? "solid" : "outline"} aria-pressed={trueObs} onClick={() => setTrueObs(!trueObs)}>True OBS frame</Pill>
            <Pill size="sm" tone={safeZone ? "solid" : "outline"} aria-pressed={safeZone} onClick={() => setSafeZone(!safeZone)}>Safe zone</Pill>
            <Pill size="sm" tone={thirds ? "solid" : "outline"} aria-pressed={thirds} onClick={() => setThirds(!thirds)}>3×3 grid</Pill>
            <Pill size="sm" tone={footage ? "solid" : "outline"} aria-pressed={footage} disabled={!transparent} title={transparent ? undefined : "Turn on transparent background to preview over footage"} onClick={() => setFootage(!footage)}>Game footage bg</Pill>
          </div>
          <div data-testid="preview-pin" data-pinned={pinPreview ? "true" : "false"} className={pinPreview ? "fixed inset-x-0 top-0 z-40 lg:pr-12 border-b border-black/15 bg-[#F6F6F3]/95 px-4 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 shadow-[0_10px_16px_-12px_rgba(0,0,0,0.35)] backdrop-blur [-webkit-backdrop-filter:blur(8px)] sm:px-6 lg:sticky lg:top-[var(--desk-header-h,5.5rem)] lg:inset-x-auto lg:z-10 lg:-mx-1 lg:px-1 lg:pt-1 lg:pb-3 lg:backdrop-blur-none" : ""}>
            {pinPreview ? (
              <button
                type="button"
                data-testid="unpin-preview"
                aria-label="Unpin preview"
                onClick={() => setPinPreview(false)}
                className="group absolute top-full right-[max(0.5rem,env(safe-area-inset-right))] z-30 inline-flex p-1 focus-visible:outline-none lg:top-1 lg:right-0"
              >
                <span aria-hidden className="inline-flex size-8 items-center justify-center rounded-full border border-black/15 bg-white text-[18px] leading-none font-bold text-black shadow-md group-hover:bg-black group-hover:text-white group-focus-visible:ring-2 group-focus-visible:ring-[#ff3c00] lg:size-9">×</span>
              </button>
            ) : null}
          <div
            data-testid="preview-frame"
            data-skew={skewMs}
            className={`relative mx-auto overflow-hidden ${pinPreview ? "max-w-[min(100%,calc(26svh*16/9))] lg:max-w-[calc(35dvh*16/9)]" : ""} ${trueObs ? "" : `rounded-[24px] border shadow-[0_20px_60px_rgba(0,0,0,0.18)] ${previewFlash ? "border-[#ff3c00]" : "border-black/10"}`}`}
            style={
              transparent && footage
                ? { background: "#111" }
                : transparent
                ? { backgroundImage: "linear-gradient(45deg,#d9d9d4 25%,transparent 25%),linear-gradient(-45deg,#d9d9d4 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d9d9d4 75%),linear-gradient(-45deg,transparent 75%,#d9d9d4 75%)", backgroundSize: "24px 24px", backgroundPosition: "0 0,0 12px,12px -12px,-12px 0" }
                : { background: "#000" }
            }
          >
            {transparent && footage ? (
              <div aria-hidden className="pointer-events-none absolute inset-0 scale-110 bg-cover bg-center blur-md brightness-75" style={{ backgroundImage: "url(/brand/hero-bg.png)" }} />
            ) : null}
            {safeZone ? (
              <div aria-hidden data-testid="safe-zone" className="pointer-events-none absolute inset-[5%] z-20 border-2 border-dashed border-[#D9FF43]/80" />
            ) : null}
            {thirds ? (
              <div aria-hidden data-testid="thirds" className="pointer-events-none absolute inset-0 z-20 grid grid-cols-3 grid-rows-3">
                {Array.from({ length: 9 }, (_, index) => <div key={index} className="border border-white/35" />)}
              </div>
            ) : null}
            {drafts.dirty.length ? (
              <span data-testid="draft-tag" className="absolute right-3 bottom-3 z-30 max-w-[70%] truncate rounded-full bg-[#b45309] px-2.5 py-1 font-mono text-[12px] font-bold tracking-[0.12em] text-white uppercase">
                Draft · {drafts.dirty.map((id) => SECTIONS[id].label).join(", ")}
              </span>
            ) : null}
            {previewFlash ? (
              <span className="absolute top-3 left-3 z-30 rounded-full bg-[#d93200] px-2.5 py-1 font-mono text-[12px] font-bold tracking-[0.12em] text-white uppercase">
                Preview updated
              </span>
            ) : null}
            {previewScreen === "break" || previewScreen === "hold" || previewScreen === "welcome" ? (
              <OverlayCard
                kind={previewScreen}
                title={previewScreen === "break" ? breakTitle : previewScreen === "welcome" ? welcomeTitle : holdTitle}
                message={previewScreen === "break" ? breakMessage : previewScreen === "welcome" ? welcomeMessage : holdMessage}
                image={previewScreen === "break" ? breakImage : previewScreen === "welcome" ? welcomeImage : holdImage}
                fit={previewScreen === "break" ? breakFit : previewScreen === "welcome" ? welcomeFit : holdFit}
                since={overlayAt}
                clock={now}
              />
            ) : previewScreen === "end" ? (
              <EndStreamPage card={{
                title: endTitle,
                subtitle: endSubtitle,
                date: endDate,
                body: endBody,
                qrUrl: endQrUrl,
                button: endButton,
                socials: [
                  { label: "X", href: xUrl, icon: null },
                  { label: "Facebook", href: facebookUrl, icon: null },
                  { label: "LinkedIn", href: linkedinUrl, icon: null },
                  { label: "Instagram", href: instagramUrl, icon: null },
                  { label: "YouTube", href: youtubeUrl, icon: null },
                ],
              }} />
            ) : (
            <CountdownStage event={event} checker={checker} showMeta={showMeta} showLink={showLink} transparent={transparent} lineSpacing={lineSpacing} blockGap={blockGap} clockScale={clockScale} clockText={clockText} logoUrl={logoUrl} speakers={speakers} gallerySeconds={gallerySeconds} galleryPause={galleryPause} galleryOffset={galleryOffset} galleryScale={galleryScale} clock={previewNow} />
            )}
            {/* OBS program feed (operator HLS, muted by default); the countdown stays underneath until its first frame. */}
            {previewScreen === "program" ? <ProgramPlayer key={programSource} scope="desk" src={programOperatorSrc(programSource === "backup" ? "program-backup" : "program")} className="z-10" /> : null}
          </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-black/10 bg-white px-4 py-3 [&>*:first-child]:basis-full xl:[&>*:first-child]:basis-0 xl:[&>*:first-child]:grow">
            <div className="flex min-w-0 items-center gap-2 font-mono text-[13px] leading-5">
              <span className="shrink-0 text-black/70">Stream URL</span>
              <code data-testid="params-line" className="min-w-0 flex-1 truncate rounded-lg bg-[#F6F6F3] px-2 py-1">
                {revealParams ? streamHref : maskKey(streamHref)}
              </code>
              <button type="button" className="shrink-0 underline underline-offset-2" aria-pressed={revealParams} onClick={() => setRevealParams(!revealParams)}>
                {revealParams ? "Hide" : "Reveal"}
              </button>
            </div>
            <Pill size="sm" onClick={() => copy("link", `${window.location.origin}${stableHref}`)}>
              {copied === "link" ? "Copied" : "Copy OBS URL"}
            </Pill>
            <Pill size="sm" tone="outline" aria-label="Copy full stream URL" onClick={() => copy("params", `${window.location.origin}${streamHref}`)}>
              {copied === "params" ? "Copied" : "Copy full URL"}
            </Pill>
            {operator.viewKey && !operator.viewKeyFromEnv ? (
              <ConfirmButton className={pillClass("danger", "sm")} confirmLabel="Old OBS URLs stop working · confirm" onConfirm={() => void rotateViewKey()}>
                Rotate view key
              </ConfirmButton>
            ) : null}
          </div>
          <p className="font-mono text-[13px] leading-5 text-black/70">
            — Changes save to this server automatically and go live on /stream within a second. For OBS, add a Browser Source at 1920×1080 and paste the copied link. Countdown runs off this computer’s clock.
            {transparent ? " Transparent background is on: in OBS leave the browser source CSS empty so the page can show through." : ""}
          </p>
          <EncodedPreview eventName={pubLine.name} dateLine={pubLine.dateLine} targetUnix={pubLine.targetUnix} valid={pubLine.valid} />
          <Panel id="end-card" title="End card" dirty={drafts.isDirty("endCard")}>
            {draftBar("endCard")}
            <p className="font-mono text-[13px] leading-5 break-all text-black/70">OBS browser source: {operator.origin}{endHref}. This page is separate from the countdown.</p>
            <Field label="Title" htmlFor="end-title"><GrowingText id="end-title" value={endTitle} onChange={setEndTitle} /></Field>
            <Field label="Subtitle" htmlFor="end-subtitle"><GrowingText id="end-subtitle" value={endSubtitle} onChange={setEndSubtitle} /></Field>
            <Field label="Date line" htmlFor="end-date"><GrowingText id="end-date" value={endDate} onChange={setEndDate} /></Field>
            <Field label="Message" htmlFor="end-body"><GrowingText id="end-body" value={endBody} onChange={setEndBody} /></Field>
            <Field label="QR link" htmlFor="end-qr"><GrowingText id="end-qr" value={endQrUrl} onChange={setEndQrUrl} /></Field>
            <Field label="End card override (optional)" htmlFor="end-at"><p className="-mt-1 mb-1 font-mono text-[12px] text-black/70">Blank = use Event › End time ({endTime}). Set only to show the end card at a different time.</p><div className="flex gap-2"><Input id="end-at" type="time" value={endAt} onChange={(event) => { setEndAt(event.target.value); setHoldCountdown(false); setForceEnd(false) }} />{endAt ? <Pill size="sm" tone="outline" onClick={() => setEndAt("")}>Clear</Pill> : null}</div>{endAt ? <div className="mt-1.5 flex flex-wrap items-center gap-1">{EXTENDS.map((m) => <button key={m} type="button" data-testid={`extend-endcard-${m < 0 ? `minus${-m}` : m}`} disabled={!token} onClick={() => extendEnd(m)} className="h-7 min-w-10 rounded-full border border-black/20 bg-white px-2 font-mono text-[12px] font-bold tabular-nums hover:bg-black/5 disabled:opacity-40">{m < 0 ? `−${-m}` : `+${m}`}</button>)}<span className="ml-0.5 font-mono text-[12px] text-black/60">min</span></div> : null}</Field>
            <Field label="Button label" htmlFor="end-button"><GrowingText id="end-button" value={endButton} onChange={setEndButton} /></Field>
            <div className="flex flex-wrap gap-2">
              <ConfirmButton data-testid="show-end" className={`${pillClass()} whitespace-nowrap`} confirmLabel="Show end card · confirm" onConfirm={() => showScreen("end")}>Show end card now</ConfirmButton>
              <ConfirmButton data-testid="back-to-countdown" className={`${pillClass("outline")} whitespace-nowrap`} confirmLabel="Back to countdown · confirm" onConfirm={() => showScreen("countdown")}>Back to countdown</ConfirmButton>
              <a href="/end" target="_blank" rel="noreferrer" className={`${pillClass("outline")} no-underline`}>Open end card</a>
            </div>
          </Panel>
          <Panel id="break-card" title="Break card" defaultOpen={false} dirty={drafts.isDirty("breakCard")} pill={overlay === "break" ? "On air" : undefined}>
            {draftBar("breakCard")}
            <p className="font-mono text-[12px] leading-5 text-black/70">Shown full-frame on /stream with Transport › Show break card. Edits here are a draft until you Save.</p>
            <Field label="Title" htmlFor="break-title"><GrowingText id="break-title" value={breakTitle} onChange={setBreakTitle} /></Field>
            <Field label="Message (optional)" htmlFor="break-message"><GrowingText id="break-message" value={breakMessage} onChange={setBreakMessage} /></Field>
            <Field label="Image (optional): URL or upload" htmlFor="break-image">
              <GrowingText id="break-image" value={breakImage} onChange={setBreakImage} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className={`${pillClass("outline", "sm")} cursor-pointer`}>
                  Upload image
                  <input data-testid="break-upload" type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file, setBreakImage); event.target.value = "" }} />
                </label>
                {breakImage ? <Pill size="sm" tone="outline" onClick={() => setBreakImage("")}>Remove image</Pill> : null}
                <select aria-label="Image fit" value={breakFit} onChange={(event) => setBreakFit(event.target.value === "contain" ? "contain" : "cover")} className="h-8 border px-2 font-mono text-[13px]">
                  <option value="cover">Fill frame (cover)</option>
                  <option value="contain">Fit inside (contain)</option>
                </select>
              </div>
            </Field>
          </Panel>
          <Panel id="hold-card" title="Hold card" defaultOpen={false} dirty={drafts.isDirty("holdCard")} pill={overlay === "hold" ? "On air" : undefined}>
            {draftBar("holdCard")}
            <p className="font-mono text-[12px] leading-5 text-black/70">Shown full-frame on /stream with Transport › Show hold card. Edits here are a draft until you Save.</p>
            <Field label="Title" htmlFor="hold-title"><GrowingText id="hold-title" value={holdTitle} onChange={setHoldTitle} /></Field>
            <Field label="Message (optional)" htmlFor="hold-message"><GrowingText id="hold-message" value={holdMessage} onChange={setHoldMessage} /></Field>
            <Field label="Image (optional): URL or upload" htmlFor="hold-image">
              <GrowingText id="hold-image" value={holdImage} onChange={setHoldImage} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className={`${pillClass("outline", "sm")} cursor-pointer`}>
                  Upload image
                  <input data-testid="hold-upload" type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file, setHoldImage); event.target.value = "" }} />
                </label>
                {holdImage ? <Pill size="sm" tone="outline" onClick={() => setHoldImage("")}>Remove image</Pill> : null}
                <select aria-label="Image fit" value={holdFit} onChange={(event) => setHoldFit(event.target.value === "contain" ? "contain" : "cover")} className="h-8 border px-2 font-mono text-[13px]">
                  <option value="cover">Fill frame (cover)</option>
                  <option value="contain">Fit inside (contain)</option>
                </select>
              </div>
            </Field>
          </Panel>
          <Panel id="welcome-card" title="Welcome back card" defaultOpen={false} dirty={drafts.isDirty("welcomeCard")} pill={overlay === "welcome" ? "On air" : undefined}>
            {draftBar("welcomeCard")}
            <p className="font-mono text-[12px] leading-5 text-black/70">Shown full-frame on /stream with Transport › Show welcome card. Edits here are a draft until you Save.</p>
            <Field label="Title" htmlFor="welcome-title"><GrowingText id="welcome-title" value={welcomeTitle} onChange={setWelcomeTitle} /></Field>
            <Field label="Message (optional)" htmlFor="welcome-message"><GrowingText id="welcome-message" value={welcomeMessage} onChange={setWelcomeMessage} /></Field>
            <Field label="Image (optional): URL or upload" htmlFor="welcome-image">
              <GrowingText id="welcome-image" value={welcomeImage} onChange={setWelcomeImage} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className={`${pillClass("outline", "sm")} cursor-pointer`}>
                  Upload image
                  <input data-testid="welcome-upload" type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadImage(file, setWelcomeImage); event.target.value = "" }} />
                </label>
                {welcomeImage ? <Pill size="sm" tone="outline" onClick={() => setWelcomeImage("")}>Remove image</Pill> : null}
                <select aria-label="Image fit" value={welcomeFit} onChange={(event) => setWelcomeFit(event.target.value === "contain" ? "contain" : "cover")} className="h-8 border px-2 font-mono text-[13px]">
                  <option value="cover">Fill frame (cover)</option>
                  <option value="contain">Fit inside (contain)</option>
                </select>
              </div>
            </Field>
          </Panel>
          <Panel id="speakers" title="Speakers" pill={`${published?.stage.speakers.length ?? 0} live`} dirty={drafts.isDirty("speakers")}>
            {draftBar("speakers")}
            <p className="font-mono text-[13px] leading-5 text-black/70">Plays over the logo on the OBS page during the countdown, then clears so the logo shows. It stops when the event is live. The encoded slate is unchanged.</p>
            <Field label="Seconds on each speaker" htmlFor="gallery-seconds">
              <NumberField id="gallery-seconds" value={gallerySeconds} onChange={setGallerySeconds} rule={{ min: 2, max: 30, integer: true }} unit="s" />
            </Field>
            <Field label="Pause before it returns" htmlFor="gallery-pause">
              <NumberField id="gallery-pause" value={galleryPause} onChange={setGalleryPause} rule={{ min: 2, max: 30, integer: true }} unit="s" />
            </Field>
            <Field label="Vertical position (px, higher moves it down)" htmlFor="gallery-offset">
              <NumberField id="gallery-offset" value={galleryOffset} onChange={setGalleryOffset} rule={{ min: -600, max: 400, integer: true }} unit="px" />
            </Field>
            <Field label="Portrait size (%)" htmlFor="gallery-scale">
              <NumberField id="gallery-scale" value={galleryScale} onChange={setGalleryScale} rule={{ min: 40, max: 200, integer: true }} unit="%" />
            </Field>
            {speakers.length > 0 ? <div><Pill data-testid="add-speaker-top" tone="outline" onClick={() => setSpeakers((items) => [...items, { image: "", name: "", description: "" }])}>+ Add speaker</Pill></div> : null}
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
                <Pill tone="outline" size="sm" onClick={() => setSpeakers((items) => items.filter((_, itemIndex) => itemIndex !== index))}>Remove</Pill>
              </div>
            ))}
            <Pill data-testid="add-speaker" onClick={() => setSpeakers((items) => [...items, { image: "", name: "", description: "" }])}>+ Add speaker</Pill>

          </Panel>
        </section>
      </main>
      <footer
        id="desk-footer"
        data-testid="desk-footer"
        className="mx-auto mt-2 flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-black/10 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] font-mono text-[12px] text-black/60 sm:px-6 lg:pb-6"
      >
        <span className="font-bold tracking-[0.12em] text-black/80 uppercase">Stream timer desk</span>
        <span data-testid="footer-saved">{drafts.dirty.length ? `${drafts.dirty.length} section${drafts.dirty.length === 1 ? "" : "s"} unsaved` : "All changes saved"}</span>
        <span>v{process.env.APP_VERSION || "0"} · build {(process.env.APP_BUILD ?? "dev").slice(-6)}</span>
        <a href="#top" className="font-bold text-black underline underline-offset-4" onClick={(event) => { event.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }) }}>↑ Back to top</a>
      </footer>
      {toast ? (
        <button
          type="button"
          key={toast.id}
          role="status"
          aria-live="polite"
          data-testid="toast"
          data-kind={toast.kind}
          title={toast.undo ? "Tap to undo" : "Tap to dismiss"}
          onClick={toast.kind === "copy-failed" ? undefined : () => { dismissToast(); toast.undo?.() }}
          onTouchMove={toast.kind === "copy-failed" ? undefined : dismissToast}
          className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[60] flex max-w-[min(90vw,32rem)] items-center gap-3 rounded-2xl bg-black px-4 py-3 text-left text-white shadow-[0_12px_40px_rgba(0,0,0,0.3)]"
        >
          <svg viewBox="0 0 24 24" className={`size-5 shrink-0 ${toast.kind === "conflict" || toast.kind === "error" || toast.kind === "failover" ? "text-[#ffb020]" : "text-[#D9FF43]"}`} fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d={toast.kind === "conflict" || toast.kind === "error" ? "M12 7v6m0 4h.01" : toast.kind === "sync" ? "M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2" : "m5 12 5 5 9-11"} /></svg>
          <span className="min-w-0">
            <span className="block text-[13px] font-bold">{{ copy: "Copied to clipboard", "copy-failed": "Copy this (clipboard blocked)", sync: "Synced from another device", conflict: "Changed on another device", error: "Heads up", extend: "End time", failover: "Program source" }[toast.kind]}</span>
            <span className={`block font-mono text-[12px] text-white/75 ${toast.kind === "copy-failed" ? "break-all select-all" : "truncate"}`}>{toast.text}</span>
          </span>
          {toast.undo ? <span data-testid="toast-undo" className="shrink-0 rounded-full bg-[#D9FF43] px-3 py-1 font-mono text-[12px] font-bold text-black">Undo</span> : null}
        </button>
      ) : null}
      {showHelp ? (
        <div role="dialog" aria-modal="false" aria-label="Keyboard shortcuts" className="fixed left-4 bottom-4 z-50 w-72 rounded-2xl border border-black/10 bg-white p-4 shadow-[0_12px_40px_rgba(0,0,0,0.2)]">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-black tracking-[0.12em] uppercase">Shortcuts</h2>
            <button type="button" className="font-mono text-[12px] text-black/70" onClick={() => setShowHelp(false)}>Esc</button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 font-mono text-[13px]">
            <dt><kbd>Space</kbd></dt><dd>Pause / play preview clock</dd>
            <dt><kbd>G</kbd> <kbd>G</kbd></dt><dd>Go live now (press twice)</dd>
            <dt><kbd>R</kbd> <kbd>R</kbd></dt><dd>Reset clock (press twice)</dd>
            <dt><kbd>?</kbd></dt><dd>Toggle this help</dd>
          </dl>
          <p className="mt-2 font-mono text-[12px] text-black/70">Ignored while typing in a field.</p>
        </div>
      ) : null}
    </div>
  )
}


function pillClass(tone: "solid" | "outline" | "danger" | "live" = "solid", size: "sm" | "md" = "md") {
  const tones = {
    solid: "bg-black text-white hover:-translate-y-px hover:bg-[#222] hover:shadow-[0_4px_12px_rgba(0,0,0,0.15)]",
    outline: "border border-black bg-white text-black hover:-translate-y-px hover:bg-black hover:text-white",
    // Go-live / primary action: deep orange, 4.77:1 with white text (brand #ff3c00 stays on /stream only).
    live: "bg-[#d93200] text-white hover:-translate-y-px hover:bg-[#bf2c00] hover:shadow-[0_4px_12px_rgba(217,50,0,0.3)]",
    // Destructive: outlined red with a warning glyph so it never looks like Go live.
    danger: "border-2 border-[#b42318] bg-white text-[#b42318] before:mr-1.5 before:content-['⚠'] hover:-translate-y-px hover:bg-[#b42318] hover:text-white",
  }
  const sizes = {
    sm: "h-8 px-3.5 font-mono text-[13px] tracking-wide",
    md: "h-9 px-5 text-[13px]",
  }
  return `inline-flex items-center justify-center rounded-full font-medium transition-all duration-150 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 ${tones[tone]} ${sizes[size]}`
}

function Pill({
  tone = "solid",
  size = "md",
  className = "",
  ...props
}: React.ComponentProps<"button"> & { tone?: "solid" | "outline" | "danger" | "live"; size?: "sm" | "md" }) {
  return <button type="button" className={`${pillClass(tone, size)} ${className}`} {...props} />
}

const SECTIONS_KEY = "hyphen-countdown-sections"
const sectionListeners = new Set<() => void>()

function readSections(): string {
  try {
    return window.localStorage.getItem(SECTIONS_KEY) ?? "{}"
  } catch {
    return "{}"
  }
}

function subscribeSections(listener: () => void) {
  sectionListeners.add(listener)
  return () => sectionListeners.delete(listener)
}

function setSectionOpen(id: string, open: boolean) {
  let current: Record<string, boolean> = {}
  try {
    current = JSON.parse(readSections()) as Record<string, boolean>
  } catch {
    /* start fresh */
  }
  window.localStorage.setItem(SECTIONS_KEY, JSON.stringify({ ...current, [id]: open }))
  sectionListeners.forEach((listener) => listener())
}

/** Open/closed state per section, remembered in localStorage. */
function useSectionOpen<D extends boolean | null>(id: string | undefined, defaultOpen: D): [boolean | D, (open: boolean) => void] {
  const raw = useSyncExternalStore(subscribeSections, readSections, () => "{}")
  let open: boolean | D = defaultOpen
  if (id) {
    try {
      const value = (JSON.parse(raw) as Record<string, unknown>)[id]
      if (typeof value === "boolean") open = value
    } catch {
      /* keep default */
    }
  }
  return [id ? open : true, (next) => { if (id) setSectionOpen(id, next) }]
}

function Panel({ id, title, pill, dirty = false, defaultOpen = true, children }: { id?: string; title: string; pill?: string; dirty?: boolean; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useSectionOpen(id, defaultOpen)
  const bodyId = id ? `section-${id}` : undefined
  const heading = (
    <>
      <h2 className="text-[13px] font-black tracking-[0.12em] uppercase">{title}</h2>
      <span className="flex items-center gap-2">
        {dirty ? <span data-testid={`unsaved-${id}`} className="rounded-full bg-[#b45309] px-2 py-1 font-mono text-[12px] font-bold text-white">Unsaved changes</span> : null}
        {pill && !dirty ? <span className="rounded-full bg-black px-2 py-1 font-mono text-[12px] text-white">{pill}</span> : null}
        {id ? (
          <svg viewBox="0 0 24 24" className={`size-4 transition-transform duration-150 ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        ) : null}
      </span>
    </>
  )
  return (
    <section className="overflow-hidden rounded-[20px] border border-black/10 bg-white shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
      {id ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className={`flex w-full items-center justify-between px-5 py-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-inset ${open ? "border-b border-black/10" : ""}`}
        >
          {heading}
        </button>
      ) : (
        <div className="flex items-center justify-between border-b border-black/10 px-5 py-4">{heading}</div>
      )}
      <div id={bodyId} hidden={!open} className="space-y-4 p-5">{children}</div>
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
      className="max-h-32 w-full resize-none overflow-y-auto rounded-xl border border-black/10 bg-[#F6F6F3] px-3 py-2 text-sm leading-5 break-all"
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
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={htmlFor} className="font-mono text-[12px] tracking-[0.14em] text-black/70 uppercase">{label}</Label>
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
      <pre className="overflow-x-auto rounded-xl bg-[#F6F6F3] p-3 font-mono text-[13px] leading-5 text-black/80 whitespace-pre-wrap">
        {value}
      </pre>
      <Pill tone="outline" onClick={onCopy} className="w-full">
        {copied ? "Copied" : "Copy command"}
      </Pill>
    </div>
  )
}

function SyncBadge({ state, hasToken, error }: { state: "idle" | "saved" | "local" | "error" | "conflict"; hasToken: boolean; error?: string }) {
  const view = state === "conflict"
    ? { label: "Changed elsewhere · reload", tone: "border-[#b42318] bg-[#b42318] text-white", dot: "bg-white" }
    : state === "saved"
    ? { label: "Saved · /stream in sync", tone: "border-[#128a3e]/30 bg-[#128a3e]/10 text-[#0b5e2a]", dot: "bg-[#128a3e]" }
    : state === "error"
      ? { label: `Save failed · ${error || "server rejected the change"}`, tone: "border-[#d93200] bg-[#d93200] text-white", dot: "bg-white" }
    : state === "local"
      ? { label: "Local only · /stream not updated", tone: "border-[#d93200] bg-[#d93200] text-white", dot: "bg-white" }
      : hasToken
        ? { label: "Syncing…", tone: "border-black/15 bg-black/5 text-black/75", dot: "bg-black/40" }
        : { label: "Out of sync · not logged in", tone: "border-[#d93200] bg-[#d93200] text-white", dot: "bg-white" }
  return (
    <span role="status" aria-live="polite" title={error || undefined} className={`max-w-[42ch] truncate inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[12px] font-bold tracking-[0.08em] uppercase ${view.tone}`}>
      <span className={`size-2 rounded-full ${view.dot}`} aria-hidden />
      {view.label}
    </span>
  )
}

/** Shows the shape of the URL without the view key or param values (safe for screen-share). */
function maskKey(href: string) {
  const [path, query = ""] = href.split("?")
  const keys = [...new URLSearchParams(query).keys()]
  const shown = keys.slice(0, 4).map((k) => (k === "k" ? "k=••••••" : `${k}=…`))
  return `${path}?${shown.join("&")}${keys.length > 4 ? `&… (+${keys.length - 4})` : ""}`
}

function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query)
      list.addEventListener("change", listener)
      return () => list.removeEventListener("change", listener)
    },
    () => window.matchMedia(query).matches,
    () => false,
  )
}


function eventLine(ev: { name: string; date: string; time: string; timeZone: string }) {
  const target = wallTimeInZone(ev.date, ev.time, ev.timeZone)
  const valid = Number.isFinite(target.getTime())
  const dateLine = valid
    ? `${new Intl.DateTimeFormat("en-GB", { timeZone: ev.timeZone, day: "numeric", month: "long", year: "numeric" }).format(target)}  •  ${ev.time}`
    : `${ev.date}  •  ${ev.time}`
  return { name: ev.name, valid, targetUnix: valid ? Math.floor(target.getTime() / 1000) : 0, dateLine }
}

/** Same object for the same JSON, so effects keyed on the draft only run when it really changes. */
function useParsedJson<T>(json: string): T {
  return useMemo(() => JSON.parse(json) as T, [json])
}

/** Click-time clock for event handlers. */
function nowMs() {
  return Date.now()
}

/** Floating "back to top" once you're well down the page; clear of Safari's toolbar and the home bar. */
function BackToTop() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    // Hidden once the footer is on screen: the footer has its own Back to top link, and the
    // floating button would otherwise sit over the last section's Save / Add buttons.
    const update = () => {
      const footer = document.getElementById("desk-footer")
      const footerVisible = footer ? footer.getBoundingClientRect().top < window.innerHeight : false
      setShow(window.scrollY > Math.max(600, window.innerHeight * 1.2) && !footerVisible)
    }
    update()
    window.addEventListener("scroll", update, { passive: true })
    window.addEventListener("resize", update)
    return () => {
      window.removeEventListener("scroll", update)
      window.removeEventListener("resize", update)
    }
  }, [])
  if (!show) return null
  return (
    <button
      type="button"
      data-testid="back-to-top"
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}
      className="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 inline-flex h-12 items-center gap-1.5 rounded-full bg-black px-4 font-mono text-[13px] font-bold tracking-[0.1em] text-white uppercase shadow-[0_8px_24px_rgba(0,0,0,0.3)] hover:bg-black/85 focus-visible:ring-2 focus-visible:ring-[#ff3c00] focus-visible:outline-none"
    >
      <span aria-hidden>↑</span> Top
    </button>
  )
}

type Dest = { id: string; name: string; host: string; masked: string; createdAt: number }

function hostOf(url: string, fallback: string): string {
  try {
    return new URL(url).host || fallback
  } catch {
    return fallback
  }
}

type RtmpChannelId = "slate" | "capture"
type RtmpPhase = "stopped" | "starting" | "connected" | "reconnecting" | "stalled" | "failed"
type RtmpChannelView = { running: boolean; state: RtmpPhase; reconnecting: boolean; restarts: number; adopted: boolean; host: string | null; size: string | null; relay?: boolean; bitrateK?: number | null; encoder?: string | null; health?: SourceHealth | HealthStats; audio?: { mode: "silent" | "tone" | "bed"; warning: string | null; pending: boolean; live?: boolean; applying?: boolean; peakDb?: number | null; underruns?: number } | null; connectError: string | null; failure: string | null }
const STOPPED_CHANNEL: RtmpChannelView = { running: false, state: "stopped", reconnecting: false, restarts: 0, adopted: false, host: null, size: null, connectError: null, failure: null }

/** One independent RTMP output (Slate or Browser capture): its own destination, Start/Stop, status and messages. */
function RtmpChannelCard({ channel, status, dests, selectedId, otherSelectedId, otherRunning, canStart, pubLine, onSelect }: {
  channel: RtmpChannelId
  status: RtmpChannelView
  dests: Dest[]
  selectedId: string | null
  otherSelectedId: string | null
  otherRunning: boolean
  canStart: boolean
  pubLine: { name: string; dateLine: string; targetUnix: number }
  onSelect: (id: string | null) => void
}) {
  const [busy, setBusy] = useState<"starting" | "stopping" | null>(null)
  const busyRef = useRef<"starting" | "stopping" | null>(null)
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null)
  // Optimistic override until the next status poll lands.
  const [override, setOverride] = useState<{ running: boolean; state: RtmpPhase } | null>(null)
  const [captureSize, setCaptureSizeState] = useState<"1280x720" | "1920x1080">("1280x720")
  const [bitrates, setBitrates] = useState<Record<"1280x720" | "1920x1080", number>>({ "1280x720": 2500, "1920x1080": 4500 })
  const [captureEncoder, setCaptureEncoderState] = useState<"auto" | "libx264" | "videotoolbox">("auto")
  const captureBitrate = bitrates[captureSize]
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (window.localStorage.getItem("rtmp-capture-size") === "1920x1080") setCaptureSizeState("1920x1080")
      const saved = (size: "1280x720" | "1920x1080") => {
        const value = Number(window.localStorage.getItem(`rtmp-capture-bitrate-${size}`))
        return (CAPTURE_BITRATES[size] as readonly number[]).includes(value) ? value : CAPTURE_BITRATES[size][1]
      }
      setBitrates({ "1280x720": saved("1280x720"), "1920x1080": saved("1920x1080") })
      const enc = window.localStorage.getItem("rtmp-capture-encoder")
      if (enc === "libx264" || enc === "videotoolbox") setCaptureEncoderState(enc)
    }, 0)
    return () => window.clearTimeout(id)
  }, [])
  useEffect(() => {
    const id = window.setTimeout(() => setOverride(null), 0)
    return () => window.clearTimeout(id)
  }, [status])
  const live = override ? override.running : status.running
  const phase = override ? override.state : status.state
  const viaRelay = selectedId === "relay"
  const selected = viaRelay ? { id: "relay", name: `relay /${channel}` } : (dests.find((item) => item.id === selectedId) ?? null)
  const sameAsOther = Boolean(selected && !viaRelay && otherRunning && otherSelectedId === selected.id)
  const label = channel === "slate" ? "Slate" : "Browser capture"
  const tid = (name: string) => `rtmp-${name}-${channel}`

  function start() {
    if (busyRef.current || !selected) return
    busyRef.current = "starting"
    setBusy("starting")
    setMessage({ tone: "info", text: "Connecting to the ingest server…" })
    void fetch("/api/encoder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "rtmp", source: channel, destinationId: selected.id, captureSize, captureBitrate, captureEncoder, eventName: pubLine.name, dateLine: pubLine.dateLine, targetUnix: pubLine.targetUnix, refreshSeconds: 0 }),
    })
      .then(async (response) => {
        if (handleUnauthorized(response)) return
        const body = (await response.json().catch(() => null)) as { error?: string; note?: string | null; rtmpChannels?: Record<RtmpChannelId, RtmpChannelView> } | null
        const mine = body?.rtmpChannels?.[channel]
        if (mine) setOverride({ running: mine.running, state: mine.state })
        if (!response.ok) return setMessage({ tone: "error", text: body?.error || "The stream did not start." })
        setMessage({ tone: "info", text: body?.note || (mine?.state === "connected" ? `Connected. Sending to ${selected.name}.` : "Started; still connecting. Watch the status above.") })
      })
      .catch(() => setMessage({ tone: "error", text: "The desk could not reach the encoder." }))
      .finally(() => { busyRef.current = null; setBusy(null) })
  }
  function stop() {
    if (busyRef.current) return
    busyRef.current = "stopping"
    setBusy("stopping")
    setMessage({ tone: "info", text: "Stopping…" })
    void fetch(`/api/encoder?target=rtmp&source=${channel}`, { method: "DELETE" })
      .then(async (response) => {
        if (handleUnauthorized(response)) return
        const body = (await response.json().catch(() => null)) as { error?: string; note?: string | null } | null
        if (!response.ok) return setMessage({ tone: "error", text: body?.error || `Stop failed (server returned ${response.status}). The stream may still be live.` })
        setOverride({ running: false, state: "stopped" })
        setMessage({ tone: "info", text: body?.note || `${label} stopped.` })
      })
      .catch(() => setMessage({ tone: "error", text: "Could not reach the encoder to stop. The stream may still be live." }))
      .finally(() => { busyRef.current = null; setBusy(null) })
  }

  const pillText = busy === "starting" ? "Starting…" : busy === "stopping" ? "Stopping…" : status.connectError && live && phase !== "connected" ? "Can't connect" : { stopped: live ? "Live" : "Off", starting: "Connecting…", connected: status.adopted ? "Live (found running)" : "Live", reconnecting: "Reconnecting", stalled: "Stalled · no frames", failed: "Failed" }[phase]
  return (
    <div data-testid={`rtmp-card-${channel}`} className="min-w-0 break-words [overflow-wrap:anywhere] space-y-2 rounded-2xl border border-black/10 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p data-testid={tid("heading")} className="font-mono text-[13px] font-bold tracking-[0.04em]">{channel === "slate" ? "/slate" : "/browser capture"}</p>
        <span data-testid={tid("status")} data-state={live ? phase : "stopped"} className={`inline-flex items-center gap-2 rounded-full px-3 py-1 font-mono text-[12px] font-bold tracking-[0.14em] uppercase ${phase === "connected" || (live && phase === "stopped") ? "bg-[#128a3e] text-white" : phase === "reconnecting" || phase === "starting" ? "bg-[#b45309] text-white" : phase === "failed" || phase === "stalled" ? "bg-[#d93200] text-white" : "bg-black/5 text-black/70"}`}>
          <span className={`size-1.5 rounded-full ${live ? "animate-pulse bg-white" : "bg-black/30"}`} />
          {pillText}{status.restarts > 0 ? <span title="Times the supervisor restarted the encoder after it exited (dropped connection, crash, or failed connect)"> · {status.restarts} {status.restarts === 1 ? "restart" : "restarts"}</span> : ""}
        </span>
      </div>
      <p className="font-mono text-[12px] text-black/70">{channel === "slate" ? "ffmpeg drawtext: light on CPU, countdown text only (no break/hold/welcome/end cards)." : "Headless Chromium streams exactly what /stream shows, cards included. More CPU."}</p>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-black/70">
        <label htmlFor={tid("destination")}>Destination</label>
        {dests.length ? (
          <select id={tid("destination")} data-testid={tid("destination")} disabled={live} className="h-8 min-w-0 max-w-full flex-1 basis-40 border px-2" value={selectedId ?? ""} onChange={(event) => onSelect(event.target.value || null)}>
            <option value="">Choose…</option>
            <option value="relay">Relay (MediaMTX) → /{channel}</option>
            {dests.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.host}</option>)}
          </select>
        ) : (
          <select id={tid("destination")} data-testid={tid("destination")} disabled={live} className="h-8 min-w-0 max-w-full flex-1 basis-40 border px-2" value={selectedId ?? ""} onChange={(event) => onSelect(event.target.value || null)}>
            <option value="">Add a destination below, or…</option>
            <option value="relay">Relay (MediaMTX) → /{channel}</option>
          </select>
        )}
        {channel === "capture" ? (
          <>
            <label htmlFor="capture-size">Size</label>
            <select id="capture-size" data-testid="capture-size" disabled={live} value={captureSize} onChange={(event) => { const v = event.target.value === "1920x1080" ? "1920x1080" : "1280x720"; setCaptureSizeState(v); window.localStorage.setItem("rtmp-capture-size", v) }} className="h-8 border px-2">
              <option value="1280x720">1280×720</option>
              <option value="1920x1080">1920×1080</option>
            </select>
            <label htmlFor="capture-bitrate">Bitrate</label>
            <select id="capture-bitrate" data-testid="capture-bitrate" disabled={live} value={captureBitrate} onChange={(event) => { const v = Number(event.target.value); setBitrates((b) => ({ ...b, [captureSize]: v })); window.localStorage.setItem(`rtmp-capture-bitrate-${captureSize}`, String(v)) }} className="h-8 border px-2">
              {CAPTURE_BITRATES[captureSize].map((value) => <option key={value} value={value}>{value}k</option>)}
            </select>
            <label htmlFor="capture-encoder">Encoder</label>
            <select id="capture-encoder" data-testid="capture-encoder" disabled={live} value={captureEncoder} onChange={(event) => { const v = event.target.value === "libx264" || event.target.value === "videotoolbox" ? event.target.value : "auto"; setCaptureEncoderState(v); window.localStorage.setItem("rtmp-capture-encoder", v) }} className="h-8 border px-2">
              <option value="auto">Auto (VideoToolbox if it can hold CBR, else libx264)</option>
              <option value="libx264">libx264 (CPU)</option>
              <option value="videotoolbox">VideoToolbox (always)</option>
            </select>
            <span className="basis-full">Keyframe every 2s, constant bitrate (maxrate = bitrate, 2s buffer), + 128k audio.</span>
          </>
        ) : null}
      </div>
      {live && status.relay ? <p data-testid={tid("via-relay")} className="font-mono text-[12px] text-black/70">Publishing to relay /{channel}{status.size ? ` · ${status.size}` : ""}. Forwards are set in the Relay card.</p> : live && status.host ? <p className="font-mono text-[12px] text-black/70">Sending to {status.host}{status.size ? ` · ${status.size}` : ""}</p> : null}
      {live && status.health ? <SourceHealthLine channel={channel} health={status.health} /> : null}
      {live && status.audio ? (
        <p data-testid={tid("audio")} data-live={status.audio.live ? "1" : "0"} data-applying={status.audio.applying ? "1" : "0"} className="font-mono text-[12px] text-black/70">
          Audio: {status.audio.mode === "bed" ? "audio bed" : status.audio.mode}
          {status.audio.live ? <span data-testid={tid("audio-level")}> · {typeof status.audio.peakDb === "number" ? `peak ${status.audio.peakDb.toFixed(0)} dBFS` : "silent"}</span> : null}
          {status.audio.live && status.audio.applying ? <span data-testid={tid("audio-applying")} className="ml-2 rounded-full bg-black/10 px-2 py-0.5 text-[11px] font-bold uppercase">Applying…</span> : null}
          {status.audio.live && !status.audio.applying ? <span data-testid={tid("audio-hot")} className="ml-2 inline-block rounded-full bg-[#128a3e] px-2 py-0.5 text-[11px] font-bold whitespace-nowrap text-white uppercase" title="Audio changes switch live: no restart, no reconnect">Applied live</span> : null}
          {status.audio.pending ? <span data-testid={tid("audio-pending")} className="ml-2 rounded-full bg-[#b45309] px-2 py-0.5 text-[11px] font-bold text-white uppercase" title="This channel started before live audio switching; restart it once to get it.">Restart to apply new audio</span> : null}
          {status.audio.warning ? <span className="block text-[#8a4b06]">{status.audio.warning}</span> : null}
        </p>
      ) : null}
      {live && status.audio?.warning ? <p role="alert" data-testid={tid("audio-warning")} className="font-mono text-[12px] font-bold text-[#8a4b06]">{status.audio.warning}</p> : null}
      {live && status.health && !status.relay ? <DiagnosisLine testid={tid("diagnosis")} value={diagnose({ source: { label: label, health: status.health }, forwards: [], totalKbps: status.health.kbps })} /> : null}
      {sameAsOther && !live ? <p role="alert" data-testid={tid("same-dest")} className="font-mono text-[12px] font-bold text-[#b42318]">The other channel is already live on this destination. One stream key takes one publisher; choose a different destination.</p> : null}
      <div className="flex flex-wrap gap-2">
        <Pill data-testid={tid("start")} disabled={!canStart || !selected || busy !== null || live} aria-busy={busy === "starting"} onClick={start}>{busy === "starting" ? "Starting…" : `Start ${label.toLowerCase()}`}</Pill>
        <ConfirmButton data-testid={tid("stop")} className={pillClass("danger")} disabled={busy !== null || !live} confirmLabel={`Stop ${label.toLowerCase()}? · confirm`} onConfirm={stop}>{busy === "stopping" ? "Stopping…" : "Stop"}</ConfirmButton>
      </div>
      {status.connectError && live && phase !== "connected" ? <p role="alert" data-testid={tid("connect-error")} className="rounded-xl border border-[#b45309]/40 bg-[#b45309]/10 px-3 py-2 font-mono text-[13px] font-bold text-[#7a3b06]">{status.connectError}{status.restarts > 0 ? ` · retrying (${status.restarts})` : ""}. Not live yet.</p> : null}
      {phase === "stalled" && live ? <p role="alert" data-testid={tid("stalled")} className="rounded-xl border border-[#b42318]/40 bg-[#b42318]/10 px-3 py-2 font-mono text-[13px] font-bold text-[#8a1c13]">ffmpeg is running but hasn&apos;t reported sending video recently. Check the ingest dashboard; Stop and Start again if it&apos;s not live.</p> : null}
      {status.adopted && live ? <p data-testid={tid("adopted")} className="font-mono text-[13px] text-black/70">Found this stream already running (started before the server restarted). Stop works on it.</p> : null}
      {status.failure && !live ? <p role="alert" data-testid={tid("failure")} className="rounded-xl border border-[#b42318]/40 bg-[#b42318]/10 px-3 py-2 font-mono text-[13px] font-bold break-words text-[#8a1c13]">Failed: {status.failure.split("\n").filter(Boolean).slice(-3).join(" · ").slice(0, 400)}</p> : null}
      {message ? <p role="status" data-testid={tid("message")} className={`font-mono text-[13px] ${message.tone === "error" ? "font-bold text-[#b42318]" : "text-black/70"}`}>{message.text}</p> : null}
    </div>
  )
}

type RelayForwardView = { destId: string; name: string; host: string; state: "blocked" | "off" | "waiting" | "connecting" | "forwarding" | "retrying" | "stalled"; restarts: number; reconnects: number; error: string | null; adopted: boolean; health: HealthStats }
type RelayPathView = { name: RtmpChannelId; ready: boolean; publisher: string | null; tracks: string[]; readers: number; forwards: RelayForwardView[]; source: SourceHealth | HealthStats | null; outKbps: number; diagnosis: { level: Level; text: string } }
type ProgramView = { armed: boolean; ready: boolean; tracks: string[]; kbps: number | null; readers: number; since: string | null; fps?: number | null; video?: string | null; audio?: string | null; audioTrack?: { codec: string; channels: number | null; sampleRate: number | null } | null }
type RelayView = { backup?: { ready: boolean; kbps: number | null; dataAgeMs: number | null; pullFrom: string | null }; program?: ProgramView; totalOutKbps: number; installed: boolean; bin: string | null; version: string | null; enabled: boolean; running: boolean; apiUp: boolean; adopted: boolean; restarts: number; error: string | null; paths: Record<RtmpChannelId, RelayPathView> }

const FORWARD_LABEL: Record<RelayForwardView["state"], string> = { blocked: "Blocked", off: "Paused", waiting: "Waiting for source", connecting: "Connecting…", forwarding: "Forwarding", retrying: "Retrying", stalled: "Stalled" }
const FORWARD_TONE: Record<RelayForwardView["state"], string> = { blocked: "bg-[#d93200] text-white", off: "bg-black/5 text-black/70", waiting: "bg-black/10 text-black/70", connecting: "bg-[#b45309] text-white", forwarding: "bg-[#128a3e] text-white", retrying: "bg-[#b45309] text-white", stalled: "bg-[#d93200] text-white" }

/** MediaMTX relay: on/off, per-path publisher, per-destination forward toggles with status, and a preview of what the relay receives. */
/** External OBS program feed: OBS publishes to the relay's /program; /stream can show it full-frame. */
function ProgramSection({ relay, busy, act }: { relay: RelayView | null; busy: boolean; act: (payload: Record<string, unknown>, okText?: string) => Promise<void> }) {
  const program = relay?.program
  const captureSource = relay?.paths.capture?.source
  const captureProgramAudio = captureSource && "capture" in captureSource ? captureSource.capture?.programAudio ?? null : null
  const [obs, setObs] = useState<{ server: string; streamKey: string } | null>(null)
  const [preview, setPreview] = useState(false)
  useEffect(() => {
    if (!obs) return
    const id = window.setTimeout(() => setObs(null), 30_000)
    return () => window.clearTimeout(id)
  }, [obs])
  async function reveal() {
    const response = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reveal-program" }) }).catch(() => null)
    if (!response || handleUnauthorized(response) || !response.ok) return
    const body = (await response.json().catch(() => null)) as { server?: string; streamKey?: string } | null
    if (body?.server && body.streamKey) setObs({ server: body.server, streamKey: body.streamKey })
  }
  const state = !program?.armed ? "off" : program.ready ? "receiving" : "waiting"
  const video = program?.tracks.find((t) => /264|265|hevc|av1|vp9/i.test(t)) ?? null
  const audio = program?.tracks.find((t) => /aac|opus|mpeg-4 audio|mp3/i.test(t)) ?? null
  return (
    <div data-testid="program-section" className="space-y-2 rounded-xl border border-black/10 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-bold">/program · OBS feed</span>
        <span data-testid="program-state" data-state={state} className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${state === "receiving" ? "bg-[#128a3e] text-white" : state === "waiting" ? "bg-[#b45309] text-white" : "bg-black/5 text-black/70"}`}>
          {state === "receiving" ? "Receiving" : state === "waiting" ? "Armed · waiting for OBS" : "Off"}
        </span>
        {state === "receiving" ? <span data-testid="program-stats" className="font-mono text-[12px] text-black/70">{[program?.video ?? video ?? "no video", program?.audio ?? audio ?? "no audio", program?.fps ? `${program.fps} fps` : null, program?.kbps ? `${(program.kbps / 1000).toFixed(1)} Mbps` : null].filter(Boolean).join(" · ")}</span> : null}
      </div>
      {state === "receiving" ? (
        <p data-testid="program-audio-track" data-present={program?.audioTrack ? "1" : "0"} className="font-mono text-[12px]">
          {program?.audioTrack ? (
            <><span className="rounded-full bg-[#128a3e] px-2 py-0.5 text-[11px] font-bold text-white uppercase">Audio present</span> <span className="text-black/70">{[program.audioTrack.codec, program.audioTrack.channels ? (program.audioTrack.channels === 1 ? "mono" : program.audioTrack.channels === 2 ? "stereo" : `${program.audioTrack.channels} ch`) : null, program.audioTrack.sampleRate ? `${program.audioTrack.sampleRate / 1000} kHz` : null].filter(Boolean).join(" · ")}</span></>
          ) : (
            <><span className="rounded-full bg-[#d93200] px-2 py-0.5 text-[11px] font-bold text-white uppercase">No audio track</span> <span className="text-black/70">OBS sends picture only: check OBS › Settings › Audio / the mixer.</span></>
          )}
        </p>
      ) : null}
      {captureProgramAudio ? (
        <p data-testid="program-capture-audio" data-mixing={captureProgramAudio.mixing ? "1" : "0"} className="font-mono text-[12px] text-black/70">
          Browser capture: {captureProgramAudio.mixing ? `mixing program audio · peak ${captureProgramAudio.peakDb === null || captureProgramAudio.peakDb === undefined ? "silent" : `${captureProgramAudio.peakDb.toFixed(0)} dBFS`}` : captureProgramAudio.on ? "program on, audio not flowing yet" : "not mixing program audio (screen isn’t program)"}
        </p>
      ) : null}
      <p className="font-mono text-[12px] text-black/70">Arm, then point OBS (on this Mac) at the URL below. Transport › Show program (OBS) puts it full-frame on /stream; cards still go on top. Browser capture carries its sound; the Slate (ffmpeg text) can&apos;t show it.</p>
      <div className="flex flex-wrap gap-2">
        {program?.armed ? (
          <ConfirmButton data-testid="program-disarm" className={pillClass("danger", "sm")} disabled={busy} confirmLabel="Disarm? OBS gets disconnected · confirm" onConfirm={() => void act({ action: "disarm-program" }, "Disarmed.")}>Disarm</ConfirmButton>
        ) : (
          <Pill size="sm" data-testid="program-arm" disabled={busy || !relay?.installed} onClick={() => void act({ action: "arm-program" }, "Armed: waiting for OBS on /program.")}>Arm receive</Pill>
        )}
        <Pill size="sm" tone="outline" data-testid="program-reveal" disabled={!program?.armed} onClick={() => (obs ? setObs(null) : void reveal())}>{obs ? "Hide OBS URL" : "Reveal OBS URL"}</Pill>
        <Pill size="sm" tone="outline" data-testid="program-preview" aria-pressed={preview} disabled={!program?.ready} onClick={() => setPreview(!preview)}>{preview ? "Hide preview" : "Preview"}</Pill>
        <ConfirmButton data-testid="program-rotate" className={pillClass("outline", "sm")} disabled={busy || !program?.armed} confirmLabel="New key? OBS must be updated · confirm" onConfirm={() => { setObs(null); void act({ action: "rotate-program" }, "New OBS stream key. Reveal it and update OBS.") }}>New key</ConfirmButton>
      </div>
      {obs ? (
        <div data-testid="program-obs" className="space-y-1 rounded-lg bg-black/5 p-2 font-mono text-[12px]">
          <p className="text-black/70">OBS › Settings › Stream › Service: Custom. Hides in 30s.</p>
          <CredRow label="Server" value={obs.server} copyLabel="OBS server" testid="program-obs-server" />
          <CredRow label="Key" value={obs.streamKey} copyLabel="OBS stream key" testid="program-obs-key" />
        </div>
      ) : null}
      {preview && program?.ready ? (
        <div className="relative aspect-video overflow-hidden rounded-lg bg-black"><ProgramPlayer scope="relay" ready={program.ready} /></div>
      ) : null}
      {program?.armed ? <BackupSection relay={relay} busy={busy} act={act} /> : null}
    </div>
  )
}

/** One revealed secret: label · value (mono, wraps anywhere) · Copy, aligned on any width. */
function CredRow({ label, value, copyLabel, testid }: { label: string; value: string; copyLabel: string; testid: string }) {
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-2">
      <span className="pt-1 text-black/60">{label}</span>
      <code data-testid={testid} className="min-w-0 pt-1 font-mono break-all">{value}</code>
      <Pill size="sm" tone="outline" data-testid={`${testid}-copy`} onClick={() => void copyOrShow(copyLabel, value)}>Copy</Pill>
    </div>
  )
}

/** /program-backup: a second publisher (own key) or a URL MediaMTX pulls. Switch/failover is in Transport. */
function BackupSection({ relay, busy, act }: { relay: RelayView | null; busy: boolean; act: (payload: Record<string, unknown>, okText?: string) => Promise<void> }) {
  const backup = relay?.backup
  const [obs, setObs] = useState<{ server: string; streamKey: string } | null>(null)
  const [pull, setPull] = useState("")
  const [preview, setPreview] = useState(false)
  useEffect(() => {
    if (!obs) return
    const id = window.setTimeout(() => setObs(null), 30_000)
    return () => window.clearTimeout(id)
  }, [obs])
  async function reveal() {
    const response = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reveal-backup" }) }).catch(() => null)
    if (!response || handleUnauthorized(response) || !response.ok) return
    const body = (await response.json().catch(() => null)) as { server?: string; streamKey?: string } | null
    if (body?.server && body.streamKey) setObs({ server: body.server, streamKey: body.streamKey })
  }
  const st = sourceStatus(backup ? { ready: backup.ready, kbps: backup.kbps, dataAgeMs: backup.dataAgeMs } : undefined)
  return (
    <div data-testid="backup-section" className="space-y-2 border-t border-black/10 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-bold">/program-backup · backup</span>
        <span data-testid="backup-state" data-state={st.tone} className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${st.tone === "ok" ? "bg-[#128a3e] text-white" : st.tone === "warn" ? "bg-[#b45309] text-white" : "bg-black/5 text-black/70"}`}>{st.text}</span>
        {backup?.pullFrom ? <span className="font-mono text-[12px] text-black/70">pulling from {backup.pullFrom}</span> : null}
      </div>
      <p className="font-mono text-[12px] text-black/70">A second computer publishes here with its own key, or MediaMTX pulls a URL (RTMP/RTSP/SRT/HLS). Pick Main/Backup and auto-failover in Transport.</p>
      <div className="flex flex-wrap gap-2">
        <Pill size="sm" tone="outline" data-testid="backup-reveal" disabled={Boolean(backup?.pullFrom)} onClick={() => (obs ? setObs(null) : void reveal())}>{obs ? "Hide backup URL" : "Reveal backup URL"}</Pill>
        <Pill size="sm" tone="outline" data-testid="backup-preview" aria-pressed={preview} disabled={!backup?.ready} onClick={() => setPreview(!preview)}>{preview ? "Hide preview" : "Preview"}</Pill>
      </div>
      {obs ? (
        <div data-testid="backup-obs" className="space-y-1 rounded-lg bg-black/5 p-2 font-mono text-[12px]">
          <p className="text-black/70">Backup computer › OBS › Stream › Custom (same ingest server). Hides in 30s.</p>
          <CredRow label="Server" value={obs.server} copyLabel="Backup server" testid="backup-obs-server" />
          <CredRow label="Key" value={obs.streamKey} copyLabel="Backup stream key" testid="backup-obs-key" />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input data-testid="backup-pull-url" placeholder={backup?.pullFrom ? "pull URL set (hidden) · type a new one" : "Pull from URL (optional): rtmp://… or https://…/index.m3u8"} value={pull} onChange={(e) => setPull(e.target.value)} className="min-w-0 flex-1" />
        <Pill size="sm" data-testid="backup-pull-save" disabled={busy || !pull.trim()} onClick={() => { void act({ action: "backup-pull", url: pull.trim() }, "Backup pulls from the URL."); setPull("") }}>Pull</Pill>
        {backup?.pullFrom ? <Pill size="sm" tone="outline" data-testid="backup-pull-clear" disabled={busy} onClick={() => void act({ action: "backup-pull", url: "" }, "Backup takes a publisher again.")}>Stop pulling</Pill> : null}
      </div>
      {preview && backup?.ready ? (
        <div className="relative aspect-video overflow-hidden rounded-lg bg-black"><ProgramPlayer scope="relay-backup" src={programOperatorSrc("program-backup")} ready={backup.ready} /></div>
      ) : null}
    </div>
  )
}

function RelayCard({ dests }: { dests: Dest[] }) {
  const [relay, setRelay] = useState<RelayView | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null)
  const [preview, setPreview] = useState<RtmpChannelId | null>(null)
  const load = useCallback(async () => {
    const response = await fetch("/api/relay", { cache: "no-store" }).catch(() => null)
    if (!response || !response.ok) return
    const body = (await response.json().catch(() => null)) as RelayView | null
    if (body?.paths) setRelay(body)
  }, [])
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0)
    const id = window.setInterval(() => void load(), 2000)
    return () => { window.clearTimeout(first); window.clearInterval(id) }
  }, [load])
  async function act(payload: Record<string, unknown>, okText?: string) {
    setBusy(true)
    const response = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null)
    setBusy(false)
    if (!response) return setMessage({ tone: "error", text: "Could not reach the server." })
    if (handleUnauthorized(response)) return
    const body = (await response.json().catch(() => null)) as (RelayView & { error?: string }) | null
    if (body?.paths) setRelay(body)
    if (!response.ok) return setMessage({ tone: "error", text: body?.error ?? `Server returned ${response.status}.` })
    setMessage(okText ? { tone: "info", text: okText } : null)
  }
  const running = relay?.running === true
  return (
    <div data-testid="relay-card" className="min-w-0 break-words [overflow-wrap:anywhere] space-y-3 rounded-2xl border border-black/10 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[13px] font-bold tracking-[0.12em] uppercase">Relay (MediaMTX)</p>
        {running && relay?.totalOutKbps ? <span data-testid="relay-total-out" title="Sum of all forwards plus direct channels: roughly your upload use" className="font-mono text-[12px] text-black/70">↑ {(relay.totalOutKbps / 1000).toFixed(1)} Mbps out</span> : null}
        <span className="flex flex-wrap items-center gap-1">
          <span data-testid="relay-status" data-state={!relay ? "loading" : !relay.installed ? "missing" : running ? (relay.apiUp ? "running" : "starting") : "off"} title="The MediaMTX server. It runs while a channel publishes to it or forwards are on." className={`rounded-full px-2 py-1 font-mono text-[11px] font-bold tracking-[0.1em] uppercase ${running && relay?.apiUp ? "bg-[#128a3e] text-white" : running ? "bg-[#b45309] text-white" : "bg-black/5 text-black/70"}`}>
            {!relay ? "…" : !relay.installed ? "Not installed" : running ? (relay.apiUp ? (relay.adopted ? "Server on (found running)" : "Server on") : "Server starting…") : "Server off"}
          </span>
          <span data-testid="relay-forwards-status" data-state={relay?.enabled ? "on" : "off"} className={`rounded-full px-2 py-1 font-mono text-[11px] font-bold tracking-[0.1em] uppercase ${relay?.enabled ? "bg-[#128a3e] text-white" : "bg-black/5 text-black/70"}`}>
            Forwards {relay?.enabled ? "on" : "off"}
          </span>
        </span>
      </div>
      <p className="font-mono text-[12px] text-black/70">Optional. Pick “Relay” as a channel’s destination and start it: it publishes to the relay server (preview works) without going anywhere else. Tick destinations per path, then Start forwards to fan out (one ffmpeg -c copy each, restarted on failure). Stop forwards ends the fan-out only; channels keep publishing. The server stops by itself when nothing uses it.{relay?.version ? ` MediaMTX ${relay.version}.` : ""}</p>
      {relay && !relay.installed ? <p role="alert" className="font-mono text-[12px] font-bold text-[#b42318]">MediaMTX not found. On the Mac: brew install mediamtx, or run scripts/install-mediamtx.sh, or set MEDIAMTX_BIN.</p> : null}
      {relay?.error ? <p role="alert" className="font-mono text-[12px] font-bold text-[#b42318]">{relay.error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Pill size="sm" data-testid="relay-start" disabled={busy || relay?.enabled === true || !relay?.installed} onClick={() => void act({ action: "start" }, "Forwards started.")}>Start forwards</Pill>
        <ConfirmButton data-testid="relay-stop" className={pillClass("danger", "sm")} disabled={busy || !relay?.enabled} confirmLabel="Stop all forwards? Channels keep publishing · confirm" onConfirm={() => void act({ action: "stop" }, "Forwards stopped. Channels keep publishing to the relay.")}>Stop forwards</ConfirmButton>
      </div>
      <ProgramSection relay={relay} busy={busy} act={act} />
      {(["slate", "capture"] as const).map((name) => {
        const info = relay?.paths[name]
        const enabled = new Map((info?.forwards ?? []).map((item) => [item.destId, item]))
        return (
          <div key={name} data-testid={`relay-path-${name}`} className="space-y-2 rounded-xl border border-black/10 p-2">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[12px]">
              <span className="font-bold">/{name}</span>
              <span data-testid={`relay-source-${name}`} data-ready={info?.ready ? "yes" : "no"} className={info?.ready ? "text-[#128a3e]" : "text-black/60"}>{info?.ready ? `● receiving ${info.tracks.join(" + ")}` : `no publisher (set ${name === "slate" ? "Slate" : "Browser capture"} → Relay)`}</span>
            </div>
            {dests.length === 0 ? <p className="font-mono text-[12px] text-black/60">Add a destination below to forward to.</p> : null}
            <ul className="space-y-1">
              {dests.map((dest) => {
                const fwd = enabled.get(dest.id)
                const on = Boolean(fwd)
                return (
                  <li key={dest.id} className="space-y-1 font-mono text-[12px]">
                    {/* Always stacked: name on its own line (wraps), status + stats below, so a narrow column never truncates names. */}
                    <label className="flex min-w-0 items-start gap-2">
                      <input type="checkbox" className="mt-0.5 shrink-0" data-testid={`relay-fwd-${name}-${dest.name}`} checked={on} disabled={busy} onChange={(event) => void act({ action: "forward", path: name, destinationId: dest.id, on: event.target.checked })} />
                      <span data-testid={`relay-fwd-name-${name}-${dest.name}`} className="min-w-0 break-words [overflow-wrap:anywhere]"><span className="font-bold">{dest.name}</span> <span className="text-black/60">· {dest.host}</span></span>
                    </label>
                    {fwd ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6">
                    {fwd ? <span data-testid={`relay-fwd-state-${name}-${dest.name}`} data-state={fwd.state} className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${FORWARD_TONE[fwd.state]}`}>{FORWARD_LABEL[fwd.state]}</span> : null}
                    {fwd && fwd.reconnects > 0 ? <span data-testid={`relay-fwd-reconnects-${name}-${dest.name}`} title={`A working connection to ${dest.name} dropped and was re-made ${fwd.reconnects}×. Total relaunches incl. quick retries: ${fwd.restarts}.`} className="font-mono text-[11px] text-[#8a4b06]">{fwd.reconnects} {fwd.reconnects === 1 ? "reconnect" : "reconnects"}</span> : fwd && fwd.restarts > 0 && fwd.state !== "forwarding" ? <span title="Quick retries: the forward could not connect (or the source was not publishing) and was started again." className="font-mono text-[11px] text-black/60">{fwd.restarts} {fwd.restarts === 1 ? "retry" : "retries"}</span> : null}
                    {fwd && fwd.state === "forwarding" ? <HealthChip testid={`relay-fwd-health-${name}-${dest.name}`} health={fwd.health} /> : null}
                    {fwd?.error && fwd.state !== "waiting" ? <span className="basis-full break-words text-[11px] text-[#8a1c13]">{fwd.error}</span> : null}
                    </div> : null}
                  </li>
                )
              })}
            </ul>
            {info && (info.forwards.length > 0 || info.source) && info.ready ? <DiagnosisLine testid={`relay-diagnosis-${name}`} value={info.diagnosis} /> : null}
            <Pill size="sm" tone="outline" data-testid={`relay-preview-${name}`} aria-pressed={preview === name} disabled={!info?.ready} onClick={() => setPreview(preview === name ? null : name)}>{preview === name ? "Hide preview" : "Preview what the relay receives"}</Pill>
            {preview === name && info?.ready ? (
              <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
                <StreamPlayer src={`/api/relay/hls/${name}/index.m3u8`} />
              </div>
            ) : null}
          </div>
        )
      })}
      {message ? <p role="status" data-testid="relay-message" className={`font-mono text-[13px] ${message.tone === "error" ? "font-bold text-[#b42318]" : "text-black/70"}`}>{message.text}</p> : null}
    </div>
  )
}

const LEVEL_DOT: Record<Level, string> = { ok: "bg-[#128a3e]", warn: "bg-[#d97706]", bad: "bg-[#d93200]", idle: "bg-black/25" }
const LEVEL_TEXT: Record<Level, string> = { ok: "text-[#0f6b31]", warn: "text-[#8a4b06]", bad: "text-[#a32600]", idle: "text-black/60" }

/** "30.0 fps · 2510k · 1.00x" with a green/amber/red dot; warnings and counters on hover. */
function HealthChip({ health, testid }: { health: HealthStats; testid?: string }) {
  const parts = [health.fps !== null ? `${health.fps.toFixed(1)} fps` : null, health.kbps !== null ? `${health.kbps}k` : null, health.speed !== null ? `${health.speed.toFixed(2)}x` : null].filter(Boolean)
  const extra = [health.dup ? `dup ${health.dup}` : null, health.drop ? `drop ${health.drop}` : null, health.bytes ? `${(health.bytes / 1e6).toFixed(0)} MB sent` : null, health.ageMs !== null ? `updated ${Math.round(health.ageMs / 1000)}s ago` : null].filter(Boolean).join(" · ")
  return (
    <span data-testid={testid} data-level={health.level} title={[...health.warnings, extra].filter(Boolean).join("\n")} className={`inline-flex min-w-0 flex-wrap items-center gap-x-1 font-mono text-[11px] ${LEVEL_TEXT[health.level]}`}>
      <span className={`size-2 shrink-0 rounded-full ${LEVEL_DOT[health.level]}`} />
      {parts.length ? parts.join(" · ") : "measuring…"}
      {health.warnings.length ? <span className="font-bold"> · {health.warnings[0]}</span> : null}
    </span>
  )
}

function SourceHealthLine({ channel, health }: { channel: RtmpChannelId; health: SourceHealth | HealthStats }) {
  const cap = "capture" in health ? health.capture : null
  return (
    <div data-testid={`rtmp-health-${channel}`} data-level={health.level} className="space-y-0.5 rounded-lg bg-black/[0.03] px-2 py-1">
      <p className="font-mono text-[11px] text-black/60">Encoder {cap ? (cap.encoder === "h264_videotoolbox" ? "VideoToolbox" : "libx264") : "libx264"}</p>
      <HealthChip health={health} />
      {cap ? (
        <p className="font-mono text-[11px] text-black/60" title="Chrome only sends a frame when /stream repaints (≥1/s for the countdown); the writer repeats the last one to keep a constant frame rate. Backlog = frames skipped because the encoder fell behind.">
          Chrome {cap.screencastFps.toFixed(1)}/s → out {cap.writtenFps.toFixed(1)} fps · repeated {cap.repeatPct.toFixed(0)}% · backlog {cap.backpressurePct.toFixed(0)}% · lag {cap.maxLagMs}ms{typeof cap.heartbeatAgeMs === "number" ? (cap.heartbeatAgeMs < 6000 ? " · page alive" : ` · page stalled ${Math.round(cap.heartbeatAgeMs / 1000)}s`) : ""}
        </p>
      ) : null}
      {cap?.sync ? (
        <p data-testid={`rtmp-sync-${channel}`} className="font-mono text-[11px] text-black/60" title="Audio is delayed by the screencast lag so it matches the picture; program audio follows the /stream player's latency. Trim is the desk's A/V offset.">
          A/V sync: screencast lag {cap.sync.screencastLagMs ?? "–"}ms → audio +{cap.sync.bedDelayMs}ms{cap.sync.videoDelayMs ? ` · video +${cap.sync.videoDelayMs}ms` : ""}{cap.sync.trimMs ? ` · trim ${cap.sync.trimMs > 0 ? "+" : ""}${cap.sync.trimMs}ms` : ""}{cap.programAudio?.mixing ? ` · program delay ${cap.programAudio.delayMs}ms (player ${cap.programAudio.playerLatencyMs ?? "?"}ms)` : ""}{cap.sync.skippedMs ? ` · dropped ${cap.sync.skippedMs}ms (encoder behind)` : ""}{cap.sync.test ? " · SYNC TEST ON" : ""}
        </p>
      ) : null}
      {cap?.programAudio ? (
        <p data-testid={`rtmp-program-audio-${channel}`} className="font-mono text-[11px] text-black/60">
          Program audio: {cap.programAudio.mixing ? `mixing · peak ${typeof cap.programAudio.peakDb === "number" ? `${cap.programAudio.peakDb.toFixed(0)} dBFS` : "silent"}` : cap.programAudio.on ? "waiting for OBS audio" : "off (audio bed)"}
        </p>
      ) : null}
    </div>
  )
}

function DiagnosisLine({ value, testid }: { value: { level: Level; text: string }; testid: string }) {
  return (
    <p data-testid={testid} data-level={value.level} className={`flex items-start gap-1.5 font-mono text-[12px] ${LEVEL_TEXT[value.level]}`}>
      <span className={`mt-1 size-2 shrink-0 rounded-full ${LEVEL_DOT[value.level]}`} />
      <span>{value.text}</span>
    </p>
  )
}

type AudioModeView = "silent" | "tone" | "bed"
type AudioConfigView = { mode: AudioModeView; toneHz: number; toneDb: number; files: string[]; order: "inOrder" | "shuffle"; volumeDb: number; fadeInSec: number; avOffsetMs?: number; syncTest?: boolean }
type AudioFileView = { id: string; name: string; ext: string; bytes: number; durationSec: number; codec: string }
type AudioSettingsView = { rev: number; channels: Record<RtmpChannelId, AudioConfigView> }
const AUDIO_ACCEPT = ".mp3,.m4a,.wav,.aac,audio/mpeg,audio/mp4,audio/wav,audio/aac"

function fmtDuration(sec: number) {
  const s = Math.round(sec)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** Per-channel stream audio (silence / test tone / looped audio bed) with a shared library. Saved on the server (rev-synced), edited as a draft. */
function AudioCard() {
  const [saved, setSaved] = useState<AudioSettingsView | null>(null)
  const [files, setFiles] = useState<AudioFileView[]>([])
  const [draft, setDraft] = useState<AudioSettingsView["channels"] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const apply = useCallback((body: { settings?: AudioSettingsView; files?: AudioFileView[] } | null) => {
    if (body?.settings) setSaved(body.settings)
    if (body?.files) setFiles(body.files)
  }, [])
  const load = useCallback(async () => {
    const response = await fetch("/api/audio", { cache: "no-store" }).catch(() => null)
    if (response?.ok) apply(await response.json().catch(() => null))
  }, [apply])
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0)
    const id = window.setInterval(() => void load(), 2000)
    return () => { window.clearTimeout(first); window.clearInterval(id) }
  }, [load])
  const view = draft ?? saved?.channels ?? null
  const dirty = draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved.channels)
  function edit(ch: RtmpChannelId, patch: Partial<AudioConfigView>) {
    if (!view) return
    setDraft({ ...view, [ch]: { ...view[ch], ...patch } })
  }
  async function post(url: string, init: RequestInit) {
    setBusy(true)
    const response = await fetch(url, init).catch(() => null)
    setBusy(false)
    if (!response) { setMessage({ tone: "error", text: "Could not reach the server." }); return null }
    if (handleUnauthorized(response)) return null
    const body = (await response.json().catch(() => null)) as { error?: string; settings?: AudioSettingsView; files?: AudioFileView[] } | null
    apply(body)
    if (!response.ok) { setMessage({ tone: "error", text: body?.error ?? `Server returned ${response.status}.` }); return null }
    return body
  }
  async function save() {
    if (!draft || !saved) return
    const body = await post("/api/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", channels: draft, baseRev: saved.rev }) })
    if (body) { setDraft(null); setMessage({ tone: "info", text: "Audio saved. Live channels switch to it now (crossfade, no restart)." }) }
  }
  async function upload(file: File) {
    if (file.size > 50_000_000) return setMessage({ tone: "error", text: "Audio is over 50 MB." })
    const body = await post(`/api/audio/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file })
    if (body) setMessage({ tone: "info", text: `Uploaded ${file.name}. Add it to a channel’s bed below.` })
  }
  function togglePlay(id: string) {
    const el = audioRef.current
    if (!el) return
    if (playing === id) { el.pause(); setPlaying(null); return }
    el.src = `/api/audio/file/${id}`
    void el.play().then(() => setPlaying(id)).catch(() => setMessage({ tone: "error", text: "Browser could not play this file." }))
  }
  const byId = new Map(files.map((f) => [f.id, f]))
  return (
    <div data-testid="audio-card" className="min-w-0 break-words [overflow-wrap:anywhere] space-y-3 rounded-2xl border border-black/10 bg-white p-3">
      <audio ref={audioRef} onEnded={() => setPlaying(null)} hidden />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[13px] font-bold tracking-[0.12em] uppercase">Stream audio</p>
        {dirty ? <span data-testid="audio-unsaved" className="rounded-full bg-[#b45309] px-2 py-1 font-mono text-[11px] font-bold text-white uppercase">Unsaved</span> : null}
      </div>
      <p className="font-mono text-[12px] text-black/70">What /slate and /browser capture send as audio: silence, a test tone, or a looped audio bed (one file or a playlist). AAC 128k, 48 kHz stereo. Saved changes switch live within about a second with a short crossfade: no restart, no reconnect.</p>
      {view ? (["slate", "capture"] as const).map((ch) => {
        const cfg = view[ch]
        const tid = (s: string) => `audio-${ch}-${s}`
        return (
          <div key={ch} data-testid={tid("box")} className="space-y-2 rounded-xl border border-black/10 p-2 font-mono text-[12px]">
            <p data-testid={tid("title")} className="font-bold">{ch === "slate" ? "/slate" : "/browser capture"}</p>
            <div role="radiogroup" aria-label={`${ch === "slate" ? "/slate" : "/browser capture"} audio`} className="flex flex-col items-start gap-1">
              {(["silent", "tone", "bed"] as const).map((mode) => (
                <label key={mode} className="flex min-h-7 items-center gap-2">
                  <input type="radio" name={`audio-mode-${ch}`} data-testid={tid(`mode-${mode}`)} checked={cfg.mode === mode} onChange={() => edit(ch, { mode })} />
                  {mode === "silent" ? "Silent" : mode === "tone" ? "Tone" : "Audio bed / playlist"}
                </label>
              ))}
            </div>
            <div className="flex flex-col items-start gap-1 border-t border-black/10 pt-2">
              <label className="flex items-center gap-2" title={ch === "slate" ? "Slate: + delays the audio (its picture is ffmpeg's own, so it can't go earlier)." : "+ = audio later, − = audio earlier (the picture is held back instead). Applies live."}>
                A/V offset <input type="number" data-testid={tid("av-offset")} min={ch === "slate" ? 0 : -500} max={500} step={10} value={cfg.avOffsetMs ?? 0} onChange={(e) => edit(ch, { avOffsetMs: Number(e.target.value) })} className="h-7 w-20 border px-1" /> ms
                <span className="text-black/60">(+ audio later)</span>
              </label>
              {ch === "capture" ? (
                <label className="flex min-h-7 items-center gap-2">
                  <input type="checkbox" data-testid={tid("sync-test")} checked={cfg.syncTest === true} onChange={(e) => edit(ch, { syncTest: e.target.checked })} />
                  A/V sync test: white flash + beep every second (on air!)
                </label>
              ) : null}
            </div>
            {cfg.mode === "tone" ? (
              <div className="flex flex-wrap items-center gap-2">
                <label>Freq <input type="number" data-testid={tid("tone-hz")} min={20} max={20000} value={cfg.toneHz} onChange={(e) => edit(ch, { toneHz: Number(e.target.value) })} className="h-7 w-20 border px-1" /> Hz</label>
                <label>Level <input type="number" data-testid={tid("tone-db")} min={-60} max={0} value={cfg.toneDb} onChange={(e) => edit(ch, { toneDb: Number(e.target.value) })} className="h-7 w-16 border px-1" /> dBFS</label>
              </div>
            ) : null}
            {cfg.mode === "bed" ? (
              <div className="space-y-2">
                {cfg.files.length === 0 ? <p className="text-[#8a4b06]">No files chosen: streams silence. Add one from the library.</p> : null}
                <ol className="space-y-1">
                  {cfg.files.map((id, index) => {
                    const f = byId.get(id)
                    return (
                      <li key={`${id}-${index}`} className="flex flex-wrap items-center gap-2">
                        <span className="text-black/50">{index + 1}.</span>
                        <span className={`min-w-0 break-words [overflow-wrap:anywhere] ${f ? "" : "text-[#b42318]"}`}>{f ? f.name : "missing file (skipped)"}</span>
                        <button type="button" className="underline" onClick={() => edit(ch, { files: cfg.files.filter((_, i) => i !== index) })}>remove</button>
                      </li>
                    )
                  })}
                </ol>
                <div className="flex flex-wrap items-center gap-2">
                  <select data-testid={tid("add")} value="" onChange={(e) => e.target.value && edit(ch, { files: [...cfg.files, e.target.value] })} className="h-7 border px-1">
                    <option value="">+ add file…</option>
                    {files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                  {cfg.files.length > 1 ? (
                    <select data-testid={tid("order")} value={cfg.order} onChange={(e) => edit(ch, { order: e.target.value === "shuffle" ? "shuffle" : "inOrder" })} className="h-7 border px-1">
                      <option value="inOrder">Play in order</option>
                      <option value="shuffle">Shuffle (each pass)</option>
                    </select>
                  ) : null}
                  <label>Volume <input type="number" data-testid={tid("volume")} min={-40} max={12} value={cfg.volumeDb} onChange={(e) => edit(ch, { volumeDb: Number(e.target.value) })} className="h-7 w-16 border px-1" /> dB</label>
                  <label>Fade in <input type="number" data-testid={tid("fade")} min={0} max={30} value={cfg.fadeInSec} onChange={(e) => edit(ch, { fadeInSec: Number(e.target.value) })} className="h-7 w-14 border px-1" /> s</label>
                </div>
                <p className="text-black/60">Loops forever (the list repeats).</p>
              </div>
            ) : null}
          </div>
        )
      }) : <p className="font-mono text-[12px] text-black/60">Loading…</p>}
      <div className="flex flex-wrap gap-2">
        <Pill size="sm" data-testid="audio-save" disabled={!dirty || busy} onClick={() => void save()}>Save audio</Pill>
        <Pill size="sm" tone="outline" data-testid="audio-discard" disabled={!dirty || busy} onClick={() => setDraft(null)}>Discard</Pill>
      </div>
      <div className="space-y-1 rounded-xl border border-black/10 p-2 font-mono text-[12px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-bold">Library</span>
          <label className="cursor-pointer underline">Upload mp3 / m4a / wav / aac (≤ 50 MB)
            <input type="file" data-testid="audio-upload" accept={AUDIO_ACCEPT} hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f) }} />
          </label>
        </div>
        {files.length === 0 ? <p className="text-black/60">No audio uploaded yet.</p> : null}
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.id} data-testid={`audio-file-${f.name}`} className="flex flex-wrap items-center gap-2">
              <button type="button" data-testid={`audio-play-${f.name}`} aria-label={playing === f.id ? `Pause ${f.name}` : `Play ${f.name}`} onClick={() => togglePlay(f.id)} className="h-6 w-6 rounded-full bg-black text-[10px] text-white">{playing === f.id ? "❚❚" : "▶"}</button>
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{f.name}</span>
              <span className="text-black/60">{fmtDuration(f.durationSec)} · {f.codec} · {(f.bytes / 1e6).toFixed(1)} MB</span>
              <ConfirmButton className="underline text-[#b42318]" disabled={busy} confirmLabel="Delete? · confirm" onConfirm={() => void post("/api/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id: f.id }) })}>delete</ConfirmButton>
            </li>
          ))}
        </ul>
      </div>
      {message ? <p role="status" data-testid="audio-message" className={`font-mono text-[12px] ${message.tone === "error" ? "font-bold text-[#b42318]" : "text-black/70"}`}>{message.text}</p> : null}
    </div>
  )
}
