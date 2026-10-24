"use client"

import Link from "next/link"

const LINKS = [
  { id: "desk", href: "/", label: "Desk" },
  { id: "deck", href: "/deck", label: "Deck" },
  { id: "visuals", href: "/visuals", label: "Visuals" },
  { id: "builder", href: "/visuals/builder", label: "Builder" },
] as const

export type AppPage = (typeof LINKS)[number]["id"]

/** Shared Desk · Deck · Visuals · Builder hops. Light on the desk, dark elsewhere with muted inactive links. */
export function AppNav({ page, tone = "dark", deckDot }: { page: AppPage; tone?: "light" | "dark"; /** desk: sync dot on the Deck hop */ deckDot?: string }) {
  const dark = tone === "dark"
  return (
    <nav aria-label="App" data-testid="app-nav" className={`flex gap-0.5 rounded-full p-0.5 ${dark ? "bg-white/10" : "bg-black/5"}`}>
      {LINKS.map((l) => {
        const on = l.id === page
        return (
          <Link key={l.id} href={l.href} data-testid={`app-nav-${l.id}`} aria-current={on ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[11px] font-bold tracking-wide uppercase no-underline ${on ? (dark ? "bg-[#D9FF43] text-[#0a0a0a]" : "bg-[#141414] text-white") : (dark ? "text-white/40 hover:text-white/70" : "text-black/55 hover:text-black")}`}>
            {l.id === "deck" && deckDot ? <span aria-hidden className={`size-1.5 rounded-full ${deckDot}`} /> : null}
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}
