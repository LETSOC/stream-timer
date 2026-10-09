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
  socials: { label: string; href: string; color: string; mark: string }[]
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
    <div className="relative flex aspect-video w-[min(100vw,177.78dvh)] flex-col items-center justify-center overflow-hidden bg-[#070710] px-[8%] text-center text-white">
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
          <a key={item.label} href={item.href} aria-label={item.label} className="inline-flex size-[2.6cqi] items-center justify-center rounded-full text-[0.7cqi] font-bold text-white" style={{ background: item.color }}>{item.mark}</a>
        ))}
      </div>
    </div>
  )
}

function socials(event: EventConfig) {
  return [
    { label: "X", href: event.xUrl, color: "#111", mark: "X" },
    { label: "Facebook", href: event.facebookUrl, color: "#3b5998", mark: "f" },
    { label: "LinkedIn", href: event.linkedinUrl, color: "#0a66c2", mark: "in" },
    { label: "Instagram", href: event.instagramUrl, color: "#e1306c", mark: "ig" },
    { label: "YouTube", href: event.youtubeUrl, color: "#ff0033", mark: "▶" },
  ]
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback
}
