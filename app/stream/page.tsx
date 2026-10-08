"use client"

import { Suspense, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { CountdownStage } from "@/components/countdown-stage"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
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

  useEffect(() => {
    if (hasOverrides) return
    let cancelled = false
    const load = () => {
      void fetch("/api/event", { cache: "no-store" })
        .then((response) => response.json())
        .then((body: { event?: unknown }) => {
          const next = asEventConfig(body.event)
          if (!cancelled && next) setServerEvent(next)
        })
        .catch(() => undefined)
    }
    load()
    const id = window.setInterval(load, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [hasOverrides])

  const event = hasOverrides ? queryEvent : serverEvent

  const checker = Number(params.get("grid") ?? "6")
  const showMeta = params.get("meta") !== "0"
  const showLink = params.get("showlink") !== "0"
  const transparent = params.get("bg") === "clear"

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
