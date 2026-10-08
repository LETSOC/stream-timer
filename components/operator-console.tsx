"use client"

import Link from "next/link"
import { useMemo, useState, type ReactNode } from "react"
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
  remainingUntil,
  wallTimeInZone,
} from "@/lib/countdown"
import { useNow } from "@/lib/use-now"
import { TIME_ZONES } from "@/lib/event"
import { useStoredEvent } from "@/lib/event-storage"
import {
  buildLocalTestCommand,
  buildStreamShellCommand,
} from "@/lib/ffmpeg-command"

export function OperatorConsole() {
  const [event, updateEvent] = useStoredEvent()
  const { name, date, time, endTime, timeZone, venue, rsvpUrl } = event
  const [rtmpUrl, setRtmpUrl] = useState("")
  const [copied, setCopied] = useState<"stream" | "file" | null>(null)
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
    })
    return `/stream?${params.toString()}`
  }, [name, date, time, endTime, timeZone, venue, rsvpUrl])

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

  async function copy(kind: "stream" | "file", value: string) {
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    window.setTimeout(() => setCopied(null), 1600)
  }

  return (
    <div className="min-h-full bg-[#0b0b0b] text-zinc-100">
      <header className="border-b border-white/10 px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs tracking-[0.28em] text-[#d4af77] uppercase">
              Live countdown
            </p>
            <h1 className="font-serif text-2xl tracking-tight sm:text-3xl">
              Hyphen stream player
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-[#d4af77]/40 text-[#d4af77]">
              1280×720 output
            </Badge>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href={streamHref} />}
            >
              Open stream view
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)] sm:px-6">
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm tracking-[0.2em] text-zinc-400 uppercase">
              Program preview
            </h2>
            <p className="text-xs text-zinc-500">
              Use this frame as an OBS browser source.
            </p>
          </div>
          <div className="overflow-hidden rounded-xl ring-1 ring-white/10">
            <CountdownStage event={event} />
          </div>
          {!valid ? (
            <p className="text-sm text-red-300">Enter a valid date, time, and zone.</p>
          ) : !remaining ? (
            <p className="text-sm text-zinc-500">Reading the clock…</p>
          ) : remaining.done ? (
            <p className="text-sm text-zinc-400">
              Start time is in the past — the output shows the live end card.
            </p>
          ) : (
            <p className="text-sm text-zinc-400">
              Starts {target.toISOString().replace(".000Z", "Z")} UTC
              {targetUnix === 1_762_245_000
                ? " — that unix stamp is 4 November 2025, not 2026."
                : null}
            </p>
          )}
          <EncodedPreview
            eventName={name}
            dateLine={dateLine}
            targetUnix={targetUnix}
            valid={valid}
          />
        </section>

        <section className="space-y-4">
          <Card className="bg-[#161616] text-zinc-100 ring-white/10">
            <CardHeader>
              <CardTitle>Event</CardTitle>
              <CardDescription className="text-zinc-400">
                Official start is 4 November 2026 at 09:30 London (GMT). The
                countdown uses this computer&apos;s clock — there is no
                separate current-time setting.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="Title" htmlFor="name">
                <Input
                  id="name"
                  value={name}
                  onChange={(event) => updateEvent({ name: event.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date" htmlFor="date">
                  <Input
                    id="date"
                    type="date"
                    value={date}
                    onChange={(event) => updateEvent({ date: event.target.value })}
                  />
                </Field>
                <Field label="Starts" htmlFor="time">
                  <Input
                    id="time"
                    type="time"
                    value={time}
                    onChange={(event) => updateEvent({ time: event.target.value })}
                  />
                </Field>
              </div>
              <Field label="Ends" htmlFor="endTime">
                <Input
                  id="endTime"
                  type="time"
                  value={endTime}
                  onChange={(event) => updateEvent({ endTime: event.target.value })}
                />
              </Field>
              <Field label="Venue" htmlFor="venue">
                <Input
                  id="venue"
                  value={venue}
                  onChange={(event) => updateEvent({ venue: event.target.value })}
                />
              </Field>
              <Field label="RSVP URL" htmlFor="rsvp">
                <Input
                  id="rsvp"
                  type="url"
                  value={rsvpUrl}
                  onChange={(event) => updateEvent({ rsvpUrl: event.target.value })}
                />
              </Field>
              <Field label="Time zone" htmlFor="tz">
                <select
                  id="tz"
                  className="h-8 w-full rounded-lg border border-input bg-[#161616] px-2.5 text-sm text-zinc-100"
                  value={timeZone}
                  onChange={(event) => updateEvent({ timeZone: event.target.value })}
                >
                  {TIME_ZONES.map((zoneOption) => (
                    <option key={zoneOption.id} value={zoneOption.id}>
                      {zoneOption.label}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-xs text-zinc-500">
                This computer now:{" "}
                {now ? formatClock(now, timeZone) : "reading clock…"}
              </p>
              <p className="text-xs text-zinc-500">
                Hits zero at: {valid ? formatClock(target, timeZone) : "—"}
              </p>
              <p className="text-xs text-zinc-500">
                Unix timestamp: {valid ? targetUnix : "—"}
              </p>
              <p className="text-xs text-zinc-500">
                Title, date, times, venue, and zone are saved in this browser.
                The QR on the frame encodes the official Hyphen RSVP page.
                After a change, open stream view again and point OBS at that
                URL.
              </p>
            </CardContent>
          </Card>

          <Card className="bg-[#161616] text-zinc-100 ring-white/10">
            <CardHeader>
              <CardTitle>FFmpeg to Castr</CardTitle>
              <CardDescription className="text-zinc-400">
                Paste the ingest URL locally. It is not stored on a server.
                Rotate the Castr password if it was shared in a log or chat.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="RTMP URL" htmlFor="rtmp">
                <Input
                  id="rtmp"
                  type="password"
                  autoComplete="off"
                  placeholder="rtmp://uk.castr.io/static/…?password=…"
                  value={rtmpUrl}
                  onChange={(event) => setRtmpUrl(event.target.value)}
                />
              </Field>
              <CommandBlock
                value={streamCommand}
                copied={copied === "stream"}
                onCopy={() => copy("stream", streamCommand)}
              />
            </CardContent>
          </Card>

          <Card className="bg-[#161616] text-zinc-100 ring-white/10">
            <CardHeader>
              <CardTitle>Local FFmpeg test</CardTitle>
              <CardDescription className="text-zinc-400">
                Writes a 6-second MP4 so you can confirm drawtext parses
                before going live.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CommandBlock
                value={fileCommand}
                copied={copied === "file"}
                onCopy={() => copy("file", fileCommand)}
              />
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
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
      <Label htmlFor={htmlFor}>{label}</Label>
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
      <pre className="overflow-x-auto rounded-lg bg-black/50 p-3 text-xs leading-6 text-zinc-300 whitespace-pre-wrap">
        {value}
      </pre>
      <Button variant="secondary" onClick={onCopy} className="w-full">
        {copied ? "Copied" : "Copy command"}
      </Button>
    </div>
  )
}
