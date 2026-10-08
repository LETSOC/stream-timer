"use client"

import { Suspense, useMemo } from "react"
import { useSearchParams } from "next/navigation"
import { CountdownStage } from "@/components/countdown-stage"
import { DEFAULT_EVENT } from "@/lib/event"
import { resolveEvent } from "@/lib/event-storage"

export default function StreamPage() {
  return (
    <Suspense fallback={<StreamFallback />}>
      <StreamView />
    </Suspense>
  )
}

function StreamView() {
  const params = useSearchParams()
  const event = useMemo(
    () =>
      resolveEvent({
        name: params.get("name") ?? undefined,
        date: params.get("date") ?? undefined,
        time: params.get("time") ?? undefined,
        endTime: params.get("end") ?? undefined,
        timeZone: params.get("tz") ?? undefined,
        venue: params.get("venue") ?? undefined,
        rsvpUrl: params.get("rsvp") ?? undefined,
      }),
    [params],
  )

  return (
    <main className="flex min-h-dvh items-center justify-center bg-black">
      <CountdownStage
        event={event}
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
