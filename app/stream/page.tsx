"use client"

import { Suspense, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { CountdownStage } from "@/components/countdown-stage"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
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
  const [stage, setStage] = useState({ checker: 6, showMeta: true, showLink: true, transparent: false, lineSpacing: 1.14, blockGap: 1.2, clockScale: 1, clockText: 1, logoUrl: "" })

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
              clockScale: Number(body.stage.clockScale) || 1,
              clockText: Number(body.stage.clockText) || 1,
              logoUrl: typeof body.stage.logoUrl === "string" ? body.stage.logoUrl : "",
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

  return (
    <main className={`flex min-h-dvh items-center justify-center ${transparent ? "bg-transparent" : "bg-black"}`}>
      <CountdownStage
        event={event}
        checker={checker}
        showMeta={showMeta}
        showLink={showLink}
        transparent={transparent}
        lineSpacing={stage.lineSpacing}
        blockGap={stage.blockGap}
        clockScale={stage.clockScale}
        clockText={stage.clockText}
        logoUrl={stage.logoUrl}
        clock={testClock}
        className="h-[min(100dvh,56.25vw)] w-[min(100vw,177.78dvh)]"
      />
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
