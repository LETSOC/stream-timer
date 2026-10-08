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
  pad2,
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
  const { name, date, time, endTime, timeZone, venue, rsvpUrl, badge, rsvpLabel, scanLabel, joinLabel, eventLink, xUrl, facebookUrl, linkedinUrl, instagramUrl, youtubeUrl } = event
  const [rtmpUrl, setRtmpUrl] = useState("")
  const [copied, setCopied] = useState<"stream" | "file" | "link" | null>(null)
  const [checker, setChecker] = useState(6)
  const [showMeta, setShowMeta] = useState(true)
  const [transparent, setTransparent] = useState(false)
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
  }, [name, date, time, endTime, timeZone, venue, rsvpUrl, badge, rsvpLabel, scanLabel, joinLabel, eventLink, xUrl, facebookUrl, linkedinUrl, instagramUrl, youtubeUrl, checker, showMeta, transparent])

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

  async function copy(kind: "stream" | "file" | "link", value: string) {
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
              <span className="rounded bg-[#D9FF43] px-1.5 py-0.5 text-[10px]">Armed</span>
            </span>
            <Button nativeButton={false} render={<Link href={streamHref} target="_blank" rel="noreferrer" />} className="rounded-full bg-black text-white">
              Open /stream in new window
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1600px] items-start gap-6 px-4 py-6 lg:grid-cols-[380px_1fr] sm:px-6">
        <section className="space-y-4 lg:sticky lg:top-24">
          <div className="rounded-[20px] bg-black p-5 text-white">
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
                { value: remaining ? String(remaining.days) : "--", label: "Days" },
                { value: remaining ? pad2(remaining.hours) : "--", label: "Hours" },
                { value: remaining ? pad2(remaining.minutes) : "--", label: "Mins" },
                { value: remaining ? pad2(remaining.seconds) : "--", label: "Secs" },
              ].map((unit) => (
                <div key={unit.label} className="rounded-[14px] border border-white/10 bg-white/10 px-2 py-3 text-center">
                  <div className="font-mono text-[28px] leading-none font-black tabular-nums">{unit.value}</div>
                  <div className="mt-1 font-mono text-[10px] tracking-[0.12em] text-white/50 uppercase">{unit.label}</div>
                </div>
              ))}
            </div>
          </div>

          <Panel title="Event details" pill="Editable">
            <Field label="Session title" htmlFor="name">
              <Input id="name" value={name} onChange={(event) => updateEvent({ name: event.target.value })} />
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
              <Input id="venue" value={venue} onChange={(event) => updateEvent({ venue: event.target.value })} />
            </Field>
            <Field label="QR URL" htmlFor="rsvp">
              <Input id="rsvp" type="url" value={rsvpUrl} onChange={(event) => updateEvent({ rsvpUrl: event.target.value })} />
            </Field>
            <Field label="RSVP button text" htmlFor="rsvpLabel">
              <Input id="rsvpLabel" value={rsvpLabel} onChange={(event) => updateEvent({ rsvpLabel: event.target.value })} />
            </Field>
          </Panel>

          <Panel title="On-stage labels">
            <Field label="Badge" htmlFor="badge">
              <Input id="badge" value={badge} onChange={(event) => updateEvent({ badge: event.target.value })} />
            </Field>
            <label className="flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-black/70 uppercase">
              <input
                type="checkbox"
                className="size-4 accent-black"
                checked={showMeta}
                onChange={(event) => setShowMeta(event.target.checked)}
              />
              Show date and timezone
            </label>
            <label className="flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-black/70 uppercase">
              <input
                type="checkbox"
                className="size-4 accent-black"
                checked={transparent}
                onChange={(event) => setTransparent(event.target.checked)}
              />
              Transparent background
            </label>
            <Field label="Scan label" htmlFor="scan">
              <Input id="scan" value={scanLabel} onChange={(event) => updateEvent({ scanLabel: event.target.value })} />
            </Field>
            <Field label="Join Live label" htmlFor="join">
              <Input id="join" value={joinLabel} onChange={(event) => updateEvent({ joinLabel: event.target.value })} />
            </Field>
            <Field label="Event link" htmlFor="link">
              <Input id="link" type="url" value={eventLink} onChange={(event) => updateEvent({ eventLink: event.target.value })} />
            </Field>
            <Field label="Checker division" htmlFor="checker">
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" className="rounded-full" onClick={() => setChecker((value) => Math.max(4, value - 1))}>−</Button>
                <span id="checker" className="min-w-16 text-center font-mono text-sm tabular-nums">{checker}×{checker}</span>
                <Button type="button" variant="outline" className="rounded-full" onClick={() => setChecker((value) => Math.min(12, value + 1))}>+</Button>
              </div>
            </Field>
            <Field label="X URL" htmlFor="x"><Input id="x" type="url" value={xUrl} onChange={(event) => updateEvent({ xUrl: event.target.value })} /></Field>
            <Field label="Facebook URL" htmlFor="fb"><Input id="fb" type="url" value={facebookUrl} onChange={(event) => updateEvent({ facebookUrl: event.target.value })} /></Field>
            <Field label="LinkedIn URL" htmlFor="li"><Input id="li" type="url" value={linkedinUrl} onChange={(event) => updateEvent({ linkedinUrl: event.target.value })} /></Field>
            <Field label="Instagram URL" htmlFor="ig"><Input id="ig" type="url" value={instagramUrl} onChange={(event) => updateEvent({ instagramUrl: event.target.value })} /></Field>
            <Field label="YouTube URL" htmlFor="yt"><Input id="yt" type="url" value={youtubeUrl} onChange={(event) => updateEvent({ youtubeUrl: event.target.value })} /></Field>
          </Panel>

          <Panel title="FFmpeg">
            <Field label="RTMP URL" htmlFor="rtmp">
              <Input id="rtmp" type="password" autoComplete="off" placeholder="rtmp://uk.castr.io/static/…?password=…" value={rtmpUrl} onChange={(event) => setRtmpUrl(event.target.value)} />
            </Field>
            <CommandBlock value={streamCommand} copied={copied === "stream"} onCopy={() => copy("stream", streamCommand)} />
            <CommandBlock value={fileCommand} copied={copied === "file"} onCopy={() => copy("file", fileCommand)} />
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
            className="overflow-hidden rounded-[24px] border border-black/10 shadow-[0_20px_60px_rgba(0,0,0,0.18)]"
            style={
              transparent
                ? { backgroundImage: "linear-gradient(45deg,#d9d9d4 25%,transparent 25%),linear-gradient(-45deg,#d9d9d4 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d9d9d4 75%),linear-gradient(-45deg,transparent 75%,#d9d9d4 75%)", backgroundSize: "24px 24px", backgroundPosition: "0 0,0 12px,12px -12px,-12px 0" }
                : { background: "#000" }
            }
          >
            <CountdownStage event={event} checker={checker} showMeta={showMeta} transparent={transparent} />
          </div>
          <div className="grid items-center gap-3 rounded-2xl border border-black/10 bg-white px-4 py-3 md:grid-cols-[1fr_auto]">
            <p className="font-mono text-[11px] leading-5 break-all">
              <span className="text-black/50">Stream params preview: </span>
              {streamHref}
            </p>
            <Button
              type="button"
              className="rounded-full bg-black text-white"
              onClick={() => copy("link", `${window.location.origin}${streamHref}`)}
            >
              {copied === "link" ? "Copied" : "Copy link"}
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
