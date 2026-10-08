"use client"

import type { ReactNode } from "react"
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
  checker?: number
  showMeta?: boolean
  showLink?: boolean
  transparent?: boolean
  lineSpacing?: number
  blockGap?: number
  clockScale?: number
  clockText?: number
  logoUrl?: string
  clock?: Date | null
}

export function CountdownStage({ event, className, checker = 6, showMeta = true, showLink = true, transparent = false, lineSpacing = 1.14, blockGap = 1.2, clockScale = 1, clockText = 1, logoUrl = "", clock }: CountdownStageProps) {
  const { name, date, time, endTime, timeZone, venue, rsvpUrl, badge, rsvpLabel, scanLabel, joinLabel, eventLink, eventLinkLabel, xUrl, facebookUrl, linkedinUrl, instagramUrl, youtubeUrl } = event
  const target = wallTimeInZone(date, time, timeZone)
  const valid = Number.isFinite(target.getTime())
  const wall = useNow()
  const now = clock === undefined ? wall : clock
  const remaining = now && valid ? remainingUntil(target, now) : null
  const dateLabel = valid ? formatBannerDate(target, timeZone) : date
  const timeLabel = formatTimeRange(time, endTime)
  const divisions = clampChecker(checker)
  const second = now ? Math.floor(now.getTime() / 1000) : 0
  const live = Boolean(remaining?.done)

  return (
    <div
      className={cn("countdown-stage relative isolate overflow-hidden text-white", className)}
      style={{ aspectRatio: "16 / 9" }}
    >
      <div
        className="pointer-events-none absolute inset-0 bg-cover bg-center"
        style={
          transparent
            ? { background: "transparent" }
            : { backgroundColor: "#070a16", backgroundImage: "url('/brand/hero-bg.png')" }
        }
      />
      <RollingQr divisions={divisions} second={second} label={live ? "Watch live" : joinLabel} />

      <div className="relative h-full px-[5.4%] pt-[4.6%] pb-[3.2%]">
        <div className="flex min-w-0 max-w-[58%] flex-col justify-start">
          <div className="mb-[1.6cqi] flex items-center gap-[1.1cqi]">
            <span className={`rounded-full px-[1.05cqi] py-[0.42cqi] font-[Arial,Helvetica,sans-serif] text-[0.78cqi] font-bold tracking-[0.14em] text-black uppercase ${live ? "animate-pulse bg-[#ff3c00] text-white" : "bg-white"}`}>
              {live ? "LIVE" : badge}
            </span>
            {showMeta ? (
              <div className="flex gap-[1.4cqi] font-[Arial,Helvetica,sans-serif] text-[0.9cqi] tracking-[0.12em] text-white/40 uppercase">
                <span>{date}</span>
                <span>{timeZone}</span>
              </div>
            ) : null}
          </div>
          <h1 className="stage-h1 m-0 max-w-full text-white" style={{ lineHeight: lineSpacing }}>
            {name.trim() || "Untitled event"}
          </h1>

          <ul className="mt-[1.4cqi] m-0 flex list-none flex-col gap-[0.45cqi] p-0">
            <MetaRow icon={<CalendarIcon />}>{now ? dateLabel : date}</MetaRow>
            <MetaRow icon={<ClockIcon />}>{timeLabel}</MetaRow>
            <MetaRow icon={<PinIcon />}>{venue}</MetaRow>
          </ul>

          <div className="flex items-center gap-[1.4cqi]" style={{ marginTop: `${blockGap}cqi` }}>
            <a
              className="stage-rsvp inline-flex items-center justify-center text-white no-underline"
              style={{ backgroundColor: "#ff3c00", opacity: 1 }}
              href={rsvpUrl}
              target="_blank"
              rel="noreferrer"
            >
              {rsvpLabel}
            </a>
            <QrSlot label={scanLabel} />
          </div>

          <div className="mt-[1.6cqi]">
            <ClockDisplay remaining={remaining} valid={valid} ready={Boolean(now)} scale={clockScale} textScale={clockText} />
          </div>
          <SocialRow
            links={[
              { label: "X", href: xUrl, icon: <XIcon /> },
              { label: "Facebook", href: facebookUrl, icon: <FacebookIcon /> },
              { label: "LinkedIn", href: linkedinUrl, icon: <LinkedInIcon /> },
              { label: "Instagram", href: instagramUrl, icon: <InstagramIcon /> },
              { label: "YouTube", href: youtubeUrl, icon: <YouTubeIcon /> },
            ]}
          />
        </div>
      </div>
      <div className="pointer-events-none absolute top-1/2 right-[6%] flex w-[34%] -translate-y-1/2 flex-col items-center">
        <img
          src={logoUrl.trim() || "/brand/hyphen-emerald.png"}
          alt="hyphen. Cultures, communities, connections. Presented with Emerald."
          className="h-auto w-full select-none"
          draggable={false}
        />
        {showLink ? (
          <a
            href={eventLink}
            target="_blank"
            rel="noreferrer"
            className="pointer-events-auto mt-[1.2cqi] max-w-full text-center font-[Arial,Helvetica,sans-serif] text-[0.85cqi] leading-tight tracking-[0.02em] break-all text-white/80 no-underline"
          >
            {eventLinkLabel}
          </a>
        ) : null}
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
  scale = 1,
  textScale = 1,
}: {
  remaining: Remaining | null
  valid: boolean
  ready: boolean
  scale?: number
  textScale?: number
}) {
  if (!ready) {
    return <UnitRow days="--" hours="--" minutes="--" seconds="--" muted scale={scale} textScale={textScale} />
  }
  if (!valid || !remaining) {
    return <p className="stage-h4 m-0 text-red-300">The start time could not be parsed.</p>
  }
  if (remaining.done) {
    return (
      <div className="flex max-w-[46cqi] items-center gap-[1cqi]">
        <span className="inline-flex items-center gap-[0.45cqi] rounded-[0.4cqi] border border-[#ff3c00] px-[0.8cqi] py-[0.45cqi] font-[Arial,Helvetica,sans-serif] text-[1.15cqi] font-bold tracking-[0.12em] text-[#ff3c00] uppercase">
          <span className="size-[0.55cqi] rounded-full bg-[#ff3c00]" />
          Live
        </span>
        <p className="m-0 font-[Arial,Helvetica,sans-serif] text-[1.7cqi] leading-tight font-bold text-white">
          Doors are open — the festival has started
        </p>
      </div>
    )
  }
  return (
    <UnitRow
      days={String(remaining.days)}
      hours={pad2(remaining.hours)}
      minutes={pad2(remaining.minutes)}
      seconds={pad2(remaining.seconds)}
      scale={scale}
      textScale={textScale}
    />
  )
}

function UnitRow({
  days,
  hours,
  minutes,
  seconds,
  muted = false,
  scale = 1,
  textScale = 1,
}: {
  days: string
  hours: string
  minutes: string
  seconds: string
  muted?: boolean
  scale?: number
  textScale?: number
}) {
  const units = [
    { value: days, label: "Days" },
    { value: hours, label: "Hours" },
    { value: minutes, label: "Minutes" },
    { value: seconds, label: "Seconds" },
  ]
  const box = 8.6 * scale * Math.max(1, textScale)
  return (
    <div className={cn("inline-flex", muted && "opacity-40")} style={{ gap: `${0.55 * scale}cqi` }}>
      {units.map((unit) => (
        <div
          key={unit.label}
          className="rounded-[0.5cqi] border border-white text-center"
          style={{ width: `${box}cqi`, padding: `${0.9 * scale}cqi ${0.45 * scale}cqi` }}
        >
          <div className="font-[Arial,Helvetica,sans-serif] leading-none font-bold tabular-nums" style={{ fontSize: `${2.7 * scale * textScale}cqi` }}>
            {unit.value}
          </div>
          <div className="font-[Arial,Helvetica,sans-serif] tracking-[0.14em] text-white/80 uppercase" style={{ marginTop: `${0.4 * scale}cqi`, fontSize: `${0.72 * scale * textScale}cqi` }}>
            {unit.label}
          </div>
        </div>
      ))}
    </div>
  )
}

function QrSlot({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-[0.35cqi]">
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
      <span className="font-[Arial,Helvetica,sans-serif] text-[0.72cqi] font-bold tracking-[0.12em] text-white uppercase">
        {label}
      </span>
    </div>
  )
}

function clampChecker(value: number) {
  if (!Number.isFinite(value)) return 6
  return Math.min(12, Math.max(4, Math.round(value)))
}

function RollingQr({ divisions, second, label }: { divisions: number; second: number; label: string }) {
  const cells = divisions * divisions

  return (
    <div className="pointer-events-none absolute top-[4.6%] right-[4.4%] z-20 flex flex-col items-center">
      <div
        className="size-[8.4cqi] rounded-[1.05cqi] bg-white p-[0.62cqi] shadow-[0_0.6cqi_1.6cqi_rgba(0,0,0,0.28)]"
        aria-hidden
      >
        <div
          className="grid h-full w-full gap-[0.12cqi] rounded-[0.62cqi] bg-black p-[0.5cqi]"
          style={{ gridTemplateColumns: `repeat(${divisions}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: cells }, (_, index) => {
            const lit = seeded(second, index) > 0.42
            return (
              <span
                key={index}
                className="rounded-[0.06cqi] bg-white transition-opacity duration-500"
                style={{ opacity: lit ? 0.96 : 0.16 }}
              />
            )
          })}
        </div>
      </div>
      <span className="mt-[0.55cqi] font-[Arial,Helvetica,sans-serif] text-[0.85cqi] font-bold tracking-[0.14em] text-white uppercase">
        {label}
      </span>
    </div>
  )
}

function seeded(second: number, index: number) {
  let n = Math.imul(second + 1, 374761393) ^ Math.imul(index + 1, 668265263)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

function SocialRow({
  links,
}: {
  links: { label: string; href: string; icon: ReactNode }[]
}) {
  return (
    <div className="mt-[1.5cqi] flex items-center gap-[0.7cqi]">
      {links.map((link) => (
        <a
          key={link.label}
          href={link.href}
          target="_blank"
          rel="noreferrer"
          aria-label={link.label}
          className="inline-flex size-[3.15cqi] items-center justify-center overflow-hidden rounded-full border-[0.14cqi] border-white text-white no-underline"
        >
          {link.icon}
        </a>
      ))}
    </div>
  )
}

function XIcon() {
  return (
    <span className="flex size-full items-center justify-center rounded-full bg-black">
      <svg viewBox="0 0 24 24" className="size-[1.25cqi]" fill="white" aria-hidden>
        <path d="M14.7 10.3 21.4 3h-1.6l-5.8 6.4L9.2 3H3.4l7 10-7 7.6h1.6l6.1-6.8 4.9 6.8h5.8l-7.1-9.3Zm-2.2 2.4-.7-1L5.6 4.2h2.4l4.5 6.2.7 1 5.9 8.1h-2.4l-4.8-6.8Z" />
      </svg>
    </span>
  )
}

function FacebookIcon() {
  return (
    <span className="flex size-full items-center justify-center rounded-full bg-[#3b5998]">
      <svg viewBox="0 0 24 24" className="size-[1.35cqi]" fill="white" aria-hidden>
        <path d="M14.5 8.5V6.8c0-.7.5-1 1.2-1H17V3h-2.1C12.4 3 11 4.5 11 6.6v1.9H9v2.7h2V21h3.5v-9.8h2.3l.4-2.7h-2.7Z" />
      </svg>
    </span>
  )
}

function LinkedInIcon() {
  return (
    <span className="flex size-full items-center justify-center rounded-full bg-[#0a66c2]">
      <svg viewBox="0 0 24 24" className="size-[1.3cqi]" fill="white" aria-hidden>
        <path d="M6.7 9.2H4V20h2.7V9.2ZM5.3 4C4.4 4 3.7 4.7 3.7 5.6s.7 1.6 1.6 1.6 1.6-.7 1.6-1.6S6.2 4 5.3 4ZM20 20h-2.7v-5.6c0-1.6-.6-2.6-1.9-2.6-1 0-1.5.7-1.8 1.3-.1.2-.1.6-.1.9V20H11V9.2h2.6v1.5c.4-.7 1.3-1.8 3.2-1.8 2.3 0 4.2 1.5 4.2 4.8V20Z" />
      </svg>
    </span>
  )
}

function InstagramIcon() {
  return (
    <span
      className="flex size-full items-center justify-center rounded-full"
      style={{ background: "linear-gradient(135deg,#f7d046,#e13b6b 55%,#7b3ff2)" }}
    >
      <svg viewBox="0 0 24 24" className="size-[1.3cqi]" fill="none" stroke="white" strokeWidth="1.8" aria-hidden>
        <rect x="5" y="5" width="14" height="14" rx="4" />
        <circle cx="12" cy="12" r="3.2" />
        <circle cx="16.4" cy="7.6" r="0.7" fill="white" stroke="none" />
      </svg>
    </span>
  )
}

function YouTubeIcon() {
  return (
    <span className="flex size-full items-center justify-center rounded-full bg-[#ff0033]">
      <svg viewBox="0 0 24 24" className="size-[1.25cqi]" fill="white" aria-hidden>
        <path d="M9.2 7.6v8.8l7.4-4.4-7.4-4.4Z" />
      </svg>
    </span>
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
