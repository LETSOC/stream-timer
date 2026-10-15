"use client"

import { StreamAudioOverlay } from "@/components/stream-audio-overlay"
import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { CountdownStage } from "@/components/countdown-stage"
import { EndStreamPage } from "@/app/end/page"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import { CLOCK_SCALE_RANGE, CLOCK_TEXT_RANGE, clampSize } from "@/lib/countdown-size"
import { wallTimeInZone } from "@/lib/countdown"
import { useNow } from "@/lib/use-now"
import { clampChecker, effectiveEndTime, parseStage, stageScreen, type StageOptions } from "@/lib/stage"
import { OverlayCard } from "@/components/overlay-card"
import { ProgramFeed } from "@/components/program-feed"
import { handoverDone, SWITCH_BUFFER_MS, type ProgramDisplay } from "@/lib/program-display"
import { endInstant } from "@/lib/transport"
import { asEventConfig, resolveEvent } from "@/lib/event-storage"

const OVERRIDE_KEYS = ["name", "date", "time", "end", "tz", "venue", "rsvp", "badge", "rsvpLabel", "scan", "join", "link", "linkText", "x", "fb", "li", "ig", "yt"]

/**
 * The server was rebuilt since this tab loaded: reload so OBS runs the new code
 * (old code silently drops anything it doesn't know, like a new card). At most once a minute.
 */
function reloadIfRebuilt(serverBuild: unknown): boolean {
  const mine = process.env.APP_BUILD
  if (typeof serverBuild !== "string" || !mine || serverBuild === mine) return false
  try {
    const last = Number(sessionStorage.getItem("stream-reload-at") ?? 0)
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem("stream-reload-at", String(Date.now()))
  } catch { /* storage blocked: still reload */ }
  window.location.reload()
  return true
}

export type StreamInitial = { event: EventConfig; testUntil: number | null; pausedAt: number | null; stage: Partial<Record<keyof StageOptions, unknown>> }

type Stage = StageOptions

/** Server passes the saved public state (only when the view key checks out) so the first paint is already correct. */
/**
 * Capture watchdog hooks (scripts/capture-stream.mjs): window.__hb ticks every second even on a
 * static LIVE/end/hold screen (where Chrome may send no repaints), and <html data-stream-ready>
 * marks that the client view has mounted. Harmless for OBS.
 */
function useCaptureHeartbeat() {
  useEffect(() => {
    const w = window as unknown as { __hb?: number }
    w.__hb = 0
    document.documentElement.dataset.streamReady = "1"
    const id = window.setInterval(() => { w.__hb = (w.__hb ?? 0) + 1 }, 1000)
    return () => window.clearInterval(id)
  }, [])
}

export function StreamClient({ initial }: { initial: StreamInitial | null }) {
  useCaptureHeartbeat()
  return (
    <Suspense fallback={<StreamFallback initial={initial} />}>
      <StreamView initial={initial} />
    </Suspense>
  )
}

function StreamView({ initial }: { initial: StreamInitial | null }) {
  const params = useSearchParams()
  const hasOverrides = OVERRIDE_KEYS.some((key) => params.get(key))
  const viewKey = params.get("k") ?? ""
  const [blocked, setBlocked] = useState(false)
  const queryEvent = useMemo(
    () =>
      resolveEvent({
        name: params.get("name") ?? undefined,
        date: params.get("date") ?? undefined,
        time: params.get("time") ?? undefined,
        endTime: params.get("end") ?? undefined,
        timeZone: params.get("tz") ?? undefined,
        venue: params.get("venue") ?? undefined,
        rsvpUrl: params.get("rsvp") ?? undefined,
        badge: params.get("badge") ?? undefined,
        rsvpLabel: params.get("rsvpLabel") ?? undefined,
        scanLabel: params.get("scan") ?? undefined,
        joinLabel: params.get("join") ?? undefined,
        eventLink: params.get("link") ?? undefined,
        eventLinkLabel: params.get("linkText") ?? undefined,
        xUrl: params.get("x") ?? undefined,
        facebookUrl: params.get("fb") ?? undefined,
        linkedinUrl: params.get("li") ?? undefined,
        instagramUrl: params.get("ig") ?? undefined,
        youtubeUrl: params.get("yt") ?? undefined,
      }),
    [params],
  )
  const [serverEvent, setServerEvent] = useState<EventConfig>(initial?.event ?? DEFAULT_EVENT)
  const [testUntil, setTestUntil] = useState<number | null>(initial?.testUntil ?? null)
  const [pausedAt, setPausedAt] = useState<number | null>(initial?.pausedAt ?? null)
  const [stage, setStage] = useState<Stage>(() => parseStage(initial?.stage ?? {}))
  const [programReady, setProgramReady] = useState(false)
  const [switchBufferMs, setSwitchBufferMs] = useState(SWITCH_BUFFER_MS)
  const [sourceReady, setSourceReady] = useState<{ main: boolean; backup: boolean }>({ main: false, backup: false })

  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetch(viewKey ? `/api/public/state?k=${encodeURIComponent(viewKey)}` : "/api/public/state", { cache: "no-store" })
        .then((response) => {
          if (response.status === 401) {
            if (!cancelled) setBlocked(true)
            throw new Error("view key required")
          }
          if (!cancelled) setBlocked(false)
          return response.json()
        })
        .then((body: { switchBufferMs?: unknown; programReady?: unknown; mainReady?: unknown; backupReady?: unknown; build?: unknown; event?: unknown; testUntil?: unknown; pausedAt?: unknown; stage?: Partial<Record<keyof StageOptions, unknown>> }) => {
          const next = asEventConfig(body.event)
          if (cancelled) return
          if (reloadIfRebuilt(body.build)) return
          if (!hasOverrides && next) setServerEvent(next)
          setTestUntil(typeof body.testUntil === "number" ? body.testUntil : null)
          setPausedAt(typeof body.pausedAt === "number" ? body.pausedAt : null)
          setProgramReady(body.programReady === true)
          if (typeof body.switchBufferMs === "number") setSwitchBufferMs(body.switchBufferMs)
          setSourceReady((cur) => (cur.main === (body.mainReady === true) && cur.backup === (body.backupReady === true) ? cur : { main: body.mainReady === true, backup: body.backupReady === true }))
          if (body.stage && typeof body.stage === "object") {
            setStage(parseStage(body.stage))
          }
        })
        .catch(() => undefined)
    }
    load()
    const id = window.setInterval(load, 1000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [hasOverrides, viewKey])

  const now = useNow()
  const event = hasOverrides ? queryEvent : serverEvent
  const targetMs = wallTimeInZone(event.date, event.time, event.timeZone).getTime()
  const testClock = pausedAt
    ? new Date(pausedAt)
    : testUntil && now
      ? new Date(now.getTime() + targetMs - testUntil)
      : undefined

  const checker = params.get("grid") ? clampChecker(params.get("grid"), stage.checker) : stage.checker
  const showMeta = params.get("meta") ? params.get("meta") !== "0" : stage.showMeta
  const showLink = params.get("showlink") ? params.get("showlink") !== "0" : stage.showLink
  const transparent = params.get("bg") ? params.get("bg") === "clear" : stage.transparent
  const clockScale = clampSize(params.get("clock"), CLOCK_SCALE_RANGE, stage.clockScale)
  const clockText = clampSize(params.get("text"), CLOCK_TEXT_RANGE, stage.clockText)

  useEffect(() => {
    if (!transparent) return
    const html = document.documentElement
    const body = document.body
    const previous = [html.style.background, body.style.background]
    html.style.background = "transparent"
    body.style.background = "transparent"
    return () => {
      html.style.background = previous[0]
      body.style.background = previous[1]
    }
  }, [transparent])

  const clock = testClock ?? now
  const pastEnd = Boolean(clock && endInstant(event.date, event.time, effectiveEndTime(stage, event.endTime), event.timeZone).getTime() <= clock.getTime())
  const screen = stageScreen(stage, pastEnd)
  // Main/Backup hand-over: the input on air stays up until the incoming one has a frame (then crossfades
  // on top), or 4s at most (then the incoming one's own standby rules apply). Both are prewarmed.
  const wanted = stage.programSource
  const [air, setAir] = useState<{ source: "main" | "backup"; pendingSince: number | null }>({ source: wanted, pendingSince: null })
  const [displays, setDisplays] = useState<Record<"main" | "backup", ProgramDisplay>>({ main: "under", backup: "under" })
  // When each input's picture last started playing continuously (null = not playing): the switch buffer.
  const [videoSince, setVideoSince] = useState<Record<"main" | "backup", number | null>>({ main: null, backup: null })
  const nowMs = now?.getTime() ?? 0
  if (air.source !== wanted && air.pendingSince === null) setAir({ source: air.source, pendingSince: nowMs })
  else if (air.source === wanted && air.pendingSince !== null) setAir({ source: wanted, pendingSince: null })
  else if (air.source !== wanted && air.pendingSince !== null && handoverDone({ screenIsProgram: screen === "program", pendingSince: air.pendingSince, now: nowMs, incomingVideoSince: videoSince[wanted], airDisplay: displays[air.source], bufferMs: switchBufferMs })) setAir({ source: wanted, pendingSince: null })
  const handing = air.source !== wanted
  const onDisplayOf = useCallback((source: "main" | "backup", d: ProgramDisplay) => {
    setDisplays((cur) => (cur[source] === d ? cur : { ...cur, [source]: d }))
    setVideoSince((cur) => { const v = d === "video" ? (cur[source] ?? Date.now()) : null; return cur[source] === v ? cur : { ...cur, [source]: v } })
  }, [])
  const onMain = useCallback((d: ProgramDisplay) => onDisplayOf("main", d), [onDisplayOf])
  const onBackup = useCallback((d: ProgramDisplay) => onDisplayOf("backup", d), [onDisplayOf])
  // Switching to program keeps the previous screen up until the feed has a frame (then crossfades).
  const programDisplay: ProgramDisplay = handing && displays[air.source] === "under" ? displays[wanted] : displays[air.source]
  const [seen, setSeen] = useState<{ screen: typeof screen; lastOther: Exclude<typeof screen, "program"> }>({ screen, lastOther: screen === "program" ? "countdown" : screen })
  if (seen.screen !== screen) setSeen({ screen, lastOther: seen.screen !== "program" ? seen.screen : seen.lastOther })
  const shownScreen = screen === "program" && programDisplay === "under" ? (seen.screen !== "program" ? seen.screen : seen.lastOther) : screen
  const ended = shownScreen === "end"
  // Browser capture reads this to switch its audio to the OBS program feed (only once its picture is up).
  useEffect(() => {
    document.documentElement.dataset.screen = shownScreen
  }, [shownScreen])

  if (blocked) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-black p-8 text-center font-mono text-sm text-white/75">
        View key required. Copy the OBS URL from the countdown desk.
      </main>
    )
  }

  return (
    <main className={`flex min-h-dvh items-center justify-center ${transparent ? "bg-transparent" : "bg-black"}`}>
      {/* Prewarmed whenever OBS is sending, so "Show program" is instant. */}
      {(["main", "backup"] as const).map((source) => {
        const isAir = source === air.source
        const live = isAir || (handing && source === wanted)
        if (!(sourceReady[source] || (stage.program && live))) return null
        return <ProgramFeed key={source} source={source} path={source === "backup" ? "program-backup" : "program"} onAir={isAir} incoming={handing && source === wanted} ready={sourceReady[source] || (isAir && programReady)} active={screen === "program" && live} muted={params.get("mute") === "1" || !isAir} holdFrame={!isAir ? 0 : handing ? 60_000 : sourceReady[source === "main" ? "backup" : "main"] ? 4000 : 0} onDisplay={source === "main" ? onMain : onBackup} />
      })}
      <StreamAudioOverlay />
      {shownScreen === "program" ? null : shownScreen === "break" || shownScreen === "hold" || shownScreen === "welcome" ? (
        <OverlayCard
          kind={shownScreen}
          title={shownScreen === "break" ? stage.breakTitle : shownScreen === "welcome" ? stage.welcomeTitle : stage.holdTitle}
          message={shownScreen === "break" ? stage.breakMessage : shownScreen === "welcome" ? stage.welcomeMessage : stage.holdMessage}
          image={shownScreen === "break" ? stage.breakImage : shownScreen === "welcome" ? stage.welcomeImage : stage.holdImage}
          fit={shownScreen === "break" ? stage.breakFit : shownScreen === "welcome" ? stage.welcomeFit : stage.holdFit}
          since={stage.overlayAt}
          clock={now}
          className="relative z-10 h-[min(100dvh,56.25vw)] w-[min(100vw,177.78dvh)]"
        />
      ) : ended ? (
        <EndStreamPage className="h-[min(100dvh,56.25vw)] w-[min(100vw,177.78dvh)]" card={{
          title: stage.endTitle,
          subtitle: stage.endSubtitle,
          date: stage.endDate,
          body: stage.endBody,
          qrUrl: stage.endQrUrl,
          button: stage.endButton,
          socials: [
            { label: "X", href: event.xUrl, icon: null },
            { label: "Facebook", href: event.facebookUrl, icon: null },
            { label: "LinkedIn", href: event.linkedinUrl, icon: null },
            { label: "Instagram", href: event.instagramUrl, icon: null },
            { label: "YouTube", href: event.youtubeUrl, icon: null },
          ],
        }} />
      ) : (
      <CountdownStage
        event={event}
        checker={checker}
        showMeta={showMeta}
        showLink={showLink}
        transparent={transparent}
        lineSpacing={stage.lineSpacing}
        blockGap={stage.blockGap}
        clockScale={clockScale}
        clockText={clockText}
        logoUrl={stage.logoUrl}
        speakers={stage.speakers}
        gallerySeconds={stage.gallerySeconds}
        galleryPause={stage.galleryPause}
        galleryOffset={stage.galleryOffset}
        galleryScale={stage.galleryScale}
        clock={testClock}
        className="h-[min(100dvh,56.25vw)] w-[min(100vw,177.78dvh)]"
      />
      )}
    </main>
  )
}

function StreamFallback({ initial }: { initial: StreamInitial | null }) {
  const stage = parseStage(initial?.stage ?? {})
  return (
    <main className={`flex min-h-dvh items-center justify-center ${stage.transparent ? "bg-transparent" : "bg-black"}`}>
      <CountdownStage
        event={initial?.event ?? DEFAULT_EVENT}
        checker={stage.checker}
        showMeta={stage.showMeta}
        showLink={stage.showLink}
        transparent={stage.transparent}
        lineSpacing={stage.lineSpacing}
        blockGap={stage.blockGap}
        clockScale={stage.clockScale}
        clockText={stage.clockText}
        logoUrl={stage.logoUrl}
        className="h-[min(100dvh,56.25vw)] w-[min(100vw,177.78dvh)]"
      />
    </main>
  )
}
