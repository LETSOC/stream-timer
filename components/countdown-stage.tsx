"use client"

import { useEffect, useState, type ReactNode } from "react"
import {
  formatBannerDate,
  formatTimeRange,
  pad2,
  remainingUntil,
  splitEventTitle,
  wallTimeInZone,
  type Remaining,
} from "@/lib/countdown"
import type { EventConfig } from "@/lib/event"
import { useNow } from "@/lib/use-now"
import { cn } from "@/lib/utils"

type CountdownStageProps = {
  event: EventConfig
  className?: string
}

export function CountdownStage({ event, className }: CountdownStageProps) {
  const { name, date, time, endTime, timeZone, venue, rsvpUrl } = event
  const target = wallTimeInZone(date, time, timeZone)
  const valid = Number.isFinite(target.getTime())
  const now = useNow()
  const remaining = now && valid ? remainingUntil(target, now) : null
  const { lead, year } = splitEventTitle(name)
  const dateLabel = valid ? formatBannerDate(target, timeZone) : date
  const timeLabel = formatTimeRange(time, endTime)

  return (
    <div
      className={cn("countdown-stage relative isolate overflow-hidden text-white", className)}
      style={{ aspectRatio: "16 / 9" }}
    >
      <div
        className="pointer-events-none absolute inset-0 bg-[#070a16] bg-cover bg-center"
        style={{ backgroundImage: "url('/brand/hero-bg.png')" }}
      />
      <RollingQr />

      <div className="relative grid h-full grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] items-center px-[5.4%] py-[8%]">
        <div className="flex min-w-0 flex-col justify-center pr-[3%]">
          <div className="mb-[1.6cqi] flex items-center gap-[1.1cqi]">
            <span className="rounded-full bg-white px-[1.05cqi] py-[0.42cqi] font-[Arial,Helvetica,sans-serif] text-[0.78cqi] font-bold tracking-[0.14em] text-black uppercase">
              Live Countdown
            </span>
            <div className="flex gap-[1.4cqi] font-[Arial,Helvetica,sans-serif] text-[0.9cqi] tracking-[0.12em] text-white/40 uppercase">
              <span>{date}</span>
              <span>{timeZone}</span>
            </div>
          </div>
          <h1 className="stage-h1 m-0 max-w-[92%] text-white">
            <span className="block">{lead || "Untitled event"}</span>
            {year ? <span className="block">{year}</span> : null}
          </h1>

          <ul className="mt-[2.1cqi] m-0 flex list-none flex-col gap-[0.7cqi] p-0">
            <MetaRow icon={<CalendarIcon />}>{now ? dateLabel : date}</MetaRow>
            <MetaRow icon={<ClockIcon />}>{timeLabel}</MetaRow>
            <MetaRow icon={<PinIcon />}>{venue}</MetaRow>
          </ul>

          <div className="mt-[1.9cqi] flex items-center gap-[1.4cqi]">
            <a
              className="stage-rsvp inline-flex items-center justify-center bg-[#7a3e38]/90 text-white no-underline"
              href={rsvpUrl}
              target="_blank"
              rel="noreferrer"
            >
              RSVP - Open
            </a>
            <QrSlot />
          </div>

          <div className="mt-[2.1cqi]">
            <ClockDisplay remaining={remaining} valid={valid} ready={Boolean(now)} />
          </div>
        </div>

        <div className="flex h-full items-center justify-center">
          <img
            src="/brand/hyphen-emerald.png"
            alt="hyphen. Cultures, communities, connections. Presented with Emerald."
            className="h-auto w-[86%] max-w-[42cqi] select-none"
            draggable={false}
          />
        </div>
      </div>
    </div>
  )
}

function MetaRow({
  icon,
  children,
}: {
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <li className="stage-h4 flex items-start gap-[1cqi] text-white/95">
      <span className="mt-[0.12cqi] inline-flex size-[2.1cqi] shrink-0 items-center justify-center text-white">
        {icon}
      </span>
      <span className="min-w-0 leading-[1.33333333]">{children}</span>
    </li>
  )
}

function ClockDisplay({
  remaining,
  valid,
  ready,
}: {
  remaining: Remaining | null
  valid: boolean
  ready: boolean
}) {
  if (!ready) {
    return <UnitRow days="--" hours="--" minutes="--" seconds="--" muted />
  }
  if (!valid || !remaining) {
    return <p className="stage-h4 m-0 text-red-300">The start time could not be parsed.</p>
  }
  if (remaining.done) {
    return <p className="stage-h1 m-0 text-[#ff4a1a]">The festival has started</p>
  }
  return (
    <UnitRow
      days={String(remaining.days)}
      hours={pad2(remaining.hours)}
      minutes={pad2(remaining.minutes)}
      seconds={pad2(remaining.seconds)}
    />
  )
}

function UnitRow({
  days,
  hours,
  minutes,
  seconds,
  muted = false,
}: {
  days: string
  hours: string
  minutes: string
  seconds: string
  muted?: boolean
}) {
  const units = [
    { value: days, label: "Days" },
    { value: hours, label: "Hours" },
    { value: minutes, label: "Minutes" },
    { value: seconds, label: "Seconds" },
  ]
  return (
    <div className={cn("inline-flex gap-[0.55cqi]", muted && "opacity-40")}>
      {units.map((unit) => (
        <div
          key={unit.label}
          className="min-w-[6.6cqi] rounded-[0.45cqi] border border-white px-[1.15cqi] py-[0.7cqi] text-center"
        >
          <div className="font-[Arial,Helvetica,sans-serif] text-[1.85cqi] leading-none font-bold tabular-nums">
            {unit.value}
          </div>
          <div className="mt-[0.4cqi] font-[Arial,Helvetica,sans-serif] text-[0.72cqi] tracking-[0.14em] text-white/80 uppercase">
            {unit.label}
          </div>
        </div>
      ))}
    </div>
  )
}

function QrSlot() {
  return (
    <div
      className="relative size-[5.6cqi] shrink-0 overflow-hidden rounded-[0.35cqi] bg-white"
      aria-label="RSVP QR code"
    >
      <img
        src="/brand/rsvp-qr.png"
        alt=""
        className="size-full object-cover"
        draggable={false}
      />
    </div>
  )
}

function RollingQr() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div
      className="pointer-events-none absolute top-[4.6%] right-[4.4%] z-20"
      aria-hidden
    >
      <div className="size-[8.4cqi] rounded-[1.05cqi] bg-white p-[0.62cqi] shadow-[0_0.6cqi_1.6cqi_rgba(0,0,0,0.28)]">
        <div className="grid h-full w-full grid-cols-6 gap-[0.16cqi] rounded-[0.62cqi] bg-black p-[0.62cqi]">
          {Array.from({ length: 36 }, (_, index) => {
            const anchor = index * 7 % 3 === 0
            const lit = ((index * 17 + tick * 13) % 11) > 4
            return (
              <span
                key={index}
                className="rounded-[0.08cqi] bg-white transition-opacity duration-700"
                style={{ opacity: anchor ? 1 : lit ? 0.92 : 0.22 }}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M8 3.5v3M16 3.5v3M3.5 10h17" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5l3.2 1.8" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-full" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 21s6.5-6.1 6.5-11A6.5 6.5 0 0 0 5.5 10c0 4.9 6.5 11 6.5 11z" />
      <circle cx="12" cy="10" r="2.2" />
    </svg>
  )
}
