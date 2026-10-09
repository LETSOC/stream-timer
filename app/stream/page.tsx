"use client"

import { Suspense, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { CountdownStage } from "@/components/countdown-stage"
import { EndStreamPage } from "@/app/end/page"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import { CLOCK_SCALE_RANGE, CLOCK_TEXT_RANGE, clampSize } from "@/lib/countdown-size"
import { wallTimeInZone } from "@/lib/countdown"
import { useNow } from "@/lib/use-now"
import { asEventConfig, resolveEvent } from "@/lib/event-storage"

const OVERRIDE_KEYS = ["name", "date", "time", "end", "tz", "venue", "rsvp", "badge", "rsvpLabel", "scan", "join", "link", "linkText", "x", "fb", "li", "ig", "yt"]

export default function StreamPage() {
  return (
    <Suspense fallback={<StreamFallback />}>
      <StreamView />
    </Suspense>
  )
}

function StreamView() {
  const params = useSearchParams()
  const hasOverrides = OVERRIDE_KEYS.some((key) => params.get(key))
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
  const [serverEvent, setServerEvent] = useState<EventConfig>(DEFAULT_EVENT)
  const [testUntil, setTestUntil] = useState<number | null>(null)
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const [stage, setStage] = useState({ checker: 6, showMeta: true, showLink: true, transparent: false, lineSpacing: 1.14, blockGap: 1.2, clockScale: 1, clockText: 1, logoUrl: "", speakers: [] as { image: string; name: string; description: string }[], gallerySeconds: 4, galleryPause: 6, galleryOffset: -86, galleryScale: 80, endTitle: "Thank you for joining", endSubtitle: "Hyphen Festival 2026", endDate: "Wed, 04 Nov, 2026", endBody: "The stream has ended. Thank you to all speakers, partners and attendees. Recordings will be available shortly.", endQrUrl: "https://linktr.ee/onlinehyphen", endButton: "Watch replay — coming soon", endAt: "16:15", forceEnd: false })

  useEffect(() => {
    let cancelled = false
    const load = () => {
      void fetch("/api/event", { cache: "no-store" })
        .then((response) => response.json())
        .then((body: { event?: unknown; testUntil?: unknown; pausedAt?: unknown; stage?: { checker?: unknown; showMeta?: unknown; showLink?: unknown; transparent?: unknown; lineSpacing?: unknown; blockGap?: unknown; clockScale?: unknown; clockText?: unknown; logoUrl?: unknown } }) => {
          const next = asEventConfig(body.event)
          if (cancelled) return
          if (!hasOverrides && next) setServerEvent(next)
          setTestUntil(typeof body.testUntil === "number" ? body.testUntil : null)
          setPausedAt(typeof body.pausedAt === "number" ? body.pausedAt : null)
          if (body.stage && typeof body.stage === "object") {
            setStage({
              checker: Number(body.stage.checker) || 6,
              showMeta: body.stage.showMeta !== false,
              showLink: body.stage.showLink !== false,
              transparent: body.stage.transparent === true,
              lineSpacing: Number(body.stage.lineSpacing) || 1.14,
              blockGap: Number(body.stage.blockGap) || 1.2,
              clockScale: clampSize(body.stage.clockScale, CLOCK_SCALE_RANGE),
              clockText: clampSize(body.stage.clockText, CLOCK_TEXT_RANGE),
              logoUrl: typeof body.stage.logoUrl === "string" ? body.stage.logoUrl : "",
              speakers: Array.isArray(body.stage.speakers) ? body.stage.speakers as { image: string; name: string; description: string }[] : [],
              gallerySeconds: Number(body.stage.gallerySeconds) || 4,
              galleryPause: Number(body.stage.galleryPause) || 6,
              galleryOffset: Number.isFinite(Number(body.stage.galleryOffset)) ? Number(body.stage.galleryOffset) : -86,
              galleryScale: Number(body.stage.galleryScale) || 80,
              endTitle: typeof body.stage.endTitle === "string" ? body.stage.endTitle : "Thank you for joining",
              endSubtitle: typeof body.stage.endSubtitle === "string" ? body.stage.endSubtitle : "Hyphen Festival 2026",
              endDate: typeof body.stage.endDate === "string" ? body.stage.endDate : "Wed, 04 Nov, 2026",
              endBody: typeof body.stage.endBody === "string" ? body.stage.endBody : "The stream has ended. Thank you to all speakers, partners and attendees. Recordings will be available shortly.",
              endQrUrl: typeof body.stage.endQrUrl === "string" ? body.stage.endQrUrl : "https://linktr.ee/onlinehyphen",
              endButton: typeof body.stage.endButton === "string" ? body.stage.endButton : "Watch replay — coming soon",
              endAt: typeof body.stage.endAt === "string" ? body.stage.endAt : "16:15",
              forceEnd: body.stage.forceEnd === true,
            })
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
  }, [hasOverrides])

  const now = useNow()
  const event = hasOverrides ? queryEvent : serverEvent
  const targetMs = wallTimeInZone(event.date, event.time, event.timeZone).getTime()
  const testClock = pausedAt
    ? new Date(pausedAt)
    : testUntil && now
      ? new Date(now.getTime() + targetMs - testUntil)
      : undefined

  const checker = params.get("grid") ? Number(params.get("grid")) : stage.checker
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
  const ended = stage.forceEnd || Boolean(clock && wallTimeInZone(event.date, stage.endAt || event.endTime, event.timeZone).getTime() <= clock.getTime())

  return (
    <main className={`flex min-h-dvh items-center justify-center ${transparent ? "bg-transparent" : "bg-black"}`}>
      {ended ? (
        <EndStreamPage card={{
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

function StreamFallback() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-black">
      <CountdownStage
        event={DEFAULT_EVENT}
        className="h-[min(100dvh,56.25vw)] w-[min(100vw,177.78dvh)]"
      />
    </main>
  )
}
