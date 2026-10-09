"use client"

import { useEffect, useState } from "react"
import { DEFAULT_EVENT, asEventConfig, type EventConfig } from "@/lib/event"

type EndCard = {
  title: string
  subtitle: string
  date: string
  body: string
  qrUrl: string
  button: string
  socials: { label: string; href: string; icon: React.ReactNode }[]
}

const DEFAULT_CARD: EndCard = {
  title: "Thank you for joining",
  subtitle: "Hyphen Festival 2026",
  date: "Wed, 04 Nov, 2026",
  body: "The stream has ended. Thank you to all speakers, partners and attendees. Recordings will be available shortly.",
  qrUrl: "https://linktr.ee/onlinehyphen",
  button: "Watch replay — coming soon",
  socials: [],
}

export default function EndPage() {
  const [card, setCard] = useState<EndCard>(DEFAULT_CARD)
  useEffect(() => {
    void fetch("/api/event", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { event?: unknown; stage?: Record<string, unknown> }) => {
        const event = asEventConfig(body.event) ?? DEFAULT_EVENT
        const stage = body.stage ?? {}
        setCard({
          title: text(stage.endTitle, DEFAULT_CARD.title),
          subtitle: text(stage.endSubtitle, DEFAULT_CARD.subtitle),
          date: text(stage.endDate, DEFAULT_CARD.date),
          body: text(stage.endBody, DEFAULT_CARD.body),
          qrUrl: text(stage.endQrUrl, DEFAULT_CARD.qrUrl),
          button: text(stage.endButton, DEFAULT_CARD.button),
          socials: socials(event),
        })
      })
      .catch(() => undefined)
  }, [])

  return (
    <main className="flex min-h-dvh items-center justify-center bg-black">
      <EndStreamPage card={card} />
    </main>
  )
}

export function EndStreamPage({ card }: { card: EndCard }) {
  return (
    <div className="relative flex aspect-video w-[min(100vw,177.78dvh)] flex-col items-center justify-center overflow-hidden bg-[#070a16] bg-cover bg-center px-[8%] text-center text-white" style={{ backgroundImage: "url('/brand/hero-bg.png')" }}>
      <div className="pointer-events-none absolute inset-0 opacity-20" style={{ backgroundImage: "repeating-linear-gradient(125deg, transparent 0 2px, rgba(255,255,255,0.08) 2px 4px)" }} />
      <div className="relative mb-[2cqi] rounded-full border border-white/20 px-[1.4cqi] py-[0.4cqi] font-[Arial,Helvetica,sans-serif] text-[0.8cqi] tracking-[0.18em] uppercase">End of stream</div>
      <h1 className="relative m-0 font-[Arial,Helvetica,sans-serif] text-[5cqi] leading-none font-bold">{card.title}</h1>
      <p className="relative mt-[1.2cqi] font-[Arial,Helvetica,sans-serif] text-[1.3cqi] text-white/80">{card.subtitle} • {card.date}</p>
      <p className="relative mt-[2cqi] max-w-[46cqi] font-[Arial,Helvetica,sans-serif] text-[1.05cqi] leading-relaxed text-white/60">{card.body}</p>
      <img src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(card.qrUrl)}`} alt="" className="relative mt-[2cqi] size-[8cqi] bg-white p-[0.4cqi]" />
      <p className="relative mt-[0.5cqi] font-[Arial,Helvetica,sans-serif] text-[0.75cqi] tracking-[0.14em] uppercase">Scan to stay connected</p>
      <a href={card.qrUrl} className="relative mt-[1.6cqi] rounded-full bg-[#ff3c00] px-[2cqi] py-[0.8cqi] font-[Arial,Helvetica,sans-serif] text-[1cqi] font-bold tracking-[0.08em] text-white uppercase no-underline">{card.button}</a>
      <div className="relative mt-[1.6cqi] flex gap-[0.7cqi]">
        {card.socials.map((item) => (
          <a key={item.label} href={item.href} target="_blank" rel="noreferrer" aria-label={item.label} className="inline-flex size-[2.99cqi] items-center justify-center overflow-hidden rounded-full border-[0.14cqi] border-white text-white no-underline">
            {item.icon}
          </a>
        ))}
      </div>
    </div>
  )
}

function socials(event: EventConfig) {
  return [
    { label: "X", href: event.xUrl, icon: <XMark /> },
    { label: "Facebook", href: event.facebookUrl, icon: <FacebookMark /> },
    { label: "LinkedIn", href: event.linkedinUrl, icon: <LinkedInMark /> },
    { label: "Instagram", href: event.instagramUrl, icon: <InstagramMark /> },
    { label: "YouTube", href: event.youtubeUrl, icon: <YouTubeMark /> },
  ]
}

function XMark() {
  return <span className="flex size-full items-center justify-center rounded-full bg-black"><svg viewBox="0 0 24 24" className="size-[1.25cqi]" fill="white"><path d="M14.7 10.3 21.4 3h-1.6l-5.8 6.4L9.2 3H3.4l7 10-7 7.6h1.6l6.1-6.8 4.9 6.8h5.8l-7.1-9.3Zm-2.2 2.4-.7-1L5.6 4.2h2.4l4.5 6.2.7 1 5.9 8.1h-2.4l-4.8-6.8Z" /></svg></span>
}
function FacebookMark() {
  return <span className="flex size-full items-center justify-center rounded-full bg-[#3b5998]"><svg viewBox="0 0 24 24" className="size-[1.35cqi]" fill="white"><path d="M14.5 8.5V6.8c0-.7.5-1 1.2-1H17V3h-2.1C12.4 3 11 4.5 11 6.6v1.9H9v2.7h2V21h3.5v-9.8h2.3l.4-2.7h-2.7Z" /></svg></span>
}
function LinkedInMark() {
  return <span className="flex size-full items-center justify-center rounded-full bg-[#0a66c2]"><svg viewBox="0 0 24 24" className="size-[1.3cqi]" fill="white"><path d="M6.7 9.2H4V20h2.7V9.2ZM5.3 4C4.4 4 3.7 4.7 3.7 5.6s.7 1.6 1.6 1.6 1.6-.7 1.6-1.6S6.2 4 5.3 4ZM20 20h-2.7v-5.6c0-1.6-.6-2.6-1.9-2.6-1 0-1.5.7-1.8 1.3-.1.2-.1.6-.1.9V20H11V9.2h2.6v1.5c.4-.7 1.3-1.8 3.2-1.8 2.3 0 4.2 1.5 4.2 4.8V20Z" /></svg></span>
}
function InstagramMark() {
  return <span className="flex size-full items-center justify-center rounded-full" style={{ background: "linear-gradient(135deg,#f7d046,#e13b6b 55%,#7b3ff2)" }}><svg viewBox="0 0 24 24" className="size-[1.3cqi]" fill="none" stroke="white" strokeWidth="1.8"><rect x="5" y="5" width="14" height="14" rx="4" /><circle cx="12" cy="12" r="3.2" /><circle cx="16.4" cy="7.6" r="0.7" fill="white" stroke="none" /></svg></span>
}
function YouTubeMark() {
  return <span className="flex size-full items-center justify-center rounded-full bg-[#ff0033]"><svg viewBox="0 0 24 24" className="size-[1.25cqi]" fill="white"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31.5 31.5 0 0 0 0 12a31.5 31.5 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31.5 31.5 0 0 0 24 12a31.5 31.5 0 0 0-.5-5.8zM9.8 15.5v-7l6.2 3.5-6.2 3.5z" /></svg></span>
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback
}
