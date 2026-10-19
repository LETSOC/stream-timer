"use client"

import { StatusToast, TOAST_MS } from "@/components/status-toast"
import Link from "next/link"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { useDeckSocket, type DeckLink } from "@/lib/use-deck-socket"
import type { TransportAction } from "@/lib/transport"
import { CORNER_LABEL, CORNERS, PLATFORM_LABEL, STRAP_HOLD_RANGE, STRAP_MOTION_LABEL, STRAP_MOTIONS, STRAP_STYLE_LABEL, STRAP_STYLES, strapVisible, type Corner, type StrapStyle } from "@/lib/visuals"

const LINK_LABEL: Record<DeckLink, string> = { connecting: "Connecting…", live: "Live sync", polling: "Polling", offline: "Offline" }
const LINK_TONE: Record<DeckLink, string> = { connecting: "bg-white/40", live: "bg-[#12b76a]", polling: "bg-[#f79009]", offline: "bg-[#f04438]" }

/**
 * Phone deck for the Visuals overlays (/overlay/strap, /overlay/socials). Every tap applies at once
 * over the deck WebSocket (same transport as the Stream Deck); presets are edited on the desk.
 */
export function VisualsDeck() {
  const { link, state, run } = useDeckSocket()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [hold, setHold] = useState<number | null>(null)
  const [preview, setPreview] = useState<"strap" | "socials">("strap")
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [toast])
  const v = state?.visuals
  // Same clock the overlay uses (OBS machine = this server on the Mac).
  const serverNow = now
  const onAir = Boolean(v && v.straps.some((p) => p.id === v.strapId) && strapVisible(v.strapMode, v.strapAt, v.strapHoldSec, serverNow))
  const holdSec = hold ?? v?.strapHoldSec ?? 5

  async function act(action: TransportAction, ok = "Done") {
    if (!state || busy) return
    setBusy(true)
    const result = await run(action, undefined)
    setBusy(false)
    if (result.ok) {
      setToast({ tone: "ok", text: ok })
      if (navigator.vibrate) navigator.vibrate(20)
    } else if (result.status !== 401) setToast({ tone: "error", text: result.error ?? `Failed (${result.status})` })
  }

  const chip = (on: boolean, label: ReactNode, onClick: () => void, testId?: string) => (
    <button type="button" data-testid={testId} aria-pressed={on} disabled={!state || busy} onClick={onClick}
      className={`min-h-11 rounded-[14px] px-3 text-[14px] font-bold touch-manipulation disabled:opacity-40 ${on ? "bg-white text-[#0b0b0f]" : "border border-white/25 bg-white/5 text-white"}`}>
      {label}
    </button>
  )

  return (
    <main className="min-h-dvh bg-[#0b0b0f] px-[max(12px,env(safe-area-inset-left))] pt-[max(10px,env(safe-area-inset-top))] pb-[max(88px,calc(env(safe-area-inset-bottom)+72px))] text-white">
      <header className="mb-3 flex items-center gap-2">
        <h1 className="mr-auto text-lg font-black tracking-tight uppercase">Visuals</h1>
        <span data-testid="visuals-link-state" className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 font-mono text-[12px]">
          <span aria-hidden className={`size-2 rounded-full ${LINK_TONE[link]}`} />
          {LINK_LABEL[link]}
        </span>
        <Link href="/deck" className="rounded-full border border-white/30 px-3 py-1 font-mono text-[12px] text-white no-underline">Deck</Link>
        <Link href="/" className="rounded-full border border-white/30 px-3 py-1 font-mono text-[12px] text-white no-underline">Desk</Link>
      </header>

      <div className="mb-2 flex gap-2 font-mono text-[12px]">
        {(["strap", "socials"] as const).map((p) => (
          <button key={p} type="button" onClick={() => setPreview(p)} className={`rounded-full px-3 py-1 ${preview === p ? "bg-white text-black" : "border border-white/25"}`}>{p === "strap" ? "Strap preview" : "Socials preview"}</button>
        ))}
      </div>
      <div className="relative mx-auto mb-4 aspect-video w-full max-w-[calc(30dvh*16/9)] overflow-hidden rounded-xl border border-white/10">
        <OverlayPreview key={preview} path={`/overlay/${preview}?checker=1`} />
      </div>

      <section className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-mono text-[12px] tracking-[0.14em] text-white/60 uppercase">Name strap</h2>
          <span data-testid="strap-onair" className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-bold ${onAir ? "bg-[#f04438]" : "bg-white/10"}`}>{onAir ? "ON AIR" : v?.strapMode === "loop" ? "LOOP (off)" : "OFF"}</span>
        </div>
        {v && v.straps.length ? (
          <div className="grid gap-2" data-testid="strap-presets">
            {v.straps.map((p) => {
              const picked = v.strapId === p.id
              return (
                <button key={p.id} type="button" data-testid={`strap-preset-${p.id}`} aria-pressed={picked} disabled={busy} onClick={() => void act({ type: "strap", id: p.id }, `Picked ${p.name || p.title}`)}
                  className={`flex min-h-14 flex-col items-start rounded-[14px] px-4 py-2 text-left touch-manipulation ${picked ? "bg-[#0000b6] ring-2 ring-[#d4ff32]" : "border border-white/20 bg-white/5"}`}>
                  <span className="font-bold">{p.name || "—"}</span>
                  <span className="text-[13px] text-white/70">{[p.title, p.handle && `${PLATFORM_LABEL[p.platform]} ${p.handle}`, STRAP_STYLE_LABEL[p.style]].filter(Boolean).join(" · ")}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <p className="font-mono text-[13px] text-white/60">No strap presets yet. Add them on the desk › Visuals and press Save.</p>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <button type="button" data-testid="strap-in" disabled={!state || busy || !v?.strapId} onClick={() => void act({ type: "strap", mode: "in", holdSec }, "Strap IN")} className="min-h-14 rounded-[14px] bg-[#12b76a] text-[16px] font-black disabled:opacity-40">IN</button>
          <button type="button" data-testid="strap-out" disabled={!state || busy} onClick={() => void act({ type: "strap", mode: "out" }, "Strap OUT")} className="min-h-14 rounded-[14px] bg-[#b42318] text-[16px] font-black disabled:opacity-40">OUT</button>
          <button type="button" data-testid="strap-loop" aria-pressed={v?.strapMode === "loop"} disabled={!state || busy || !v?.strapId} onClick={() => void act({ type: "strap", mode: "loop", holdSec }, "Strap LOOP")} className={`min-h-14 rounded-[14px] text-[16px] font-black disabled:opacity-40 ${v?.strapMode === "loop" ? "bg-[#f79009] text-black" : "border border-white/25 bg-white/5"}`}>LOOP</button>
        </div>
        <label className="mt-4 block font-mono text-[12px] text-white/70">
          Hold {holdSec}s
          <input type="range" data-testid="strap-hold" className="mt-1 w-full accent-[#d4ff32]" min={STRAP_HOLD_RANGE.min} max={STRAP_HOLD_RANGE.max} step={0.5} value={holdSec}
            onChange={(e) => setHold(Number(e.target.value))}
            onPointerUp={() => hold !== null && void act({ type: "strap", holdSec: hold }, `Hold ${hold}s`).then(() => setHold(null))}
            onKeyUp={() => hold !== null && void act({ type: "strap", holdSec: hold }, `Hold ${hold}s`).then(() => setHold(null))} />
        </label>
        <p className="mt-3 mb-1 font-mono text-[12px] text-white/60">Style</p>
        <div className="grid grid-cols-3 gap-2">
          {chip(v?.strapStyle === "", "Preset's", () => void act({ type: "strap", style: "" }))}
          {STRAP_STYLES.map((s: StrapStyle) => chip(v?.strapStyle === s, STRAP_STYLE_LABEL[s], () => void act({ type: "strap", style: s }), `strap-style-${s}`))}
        </div>
        <p className="mt-3 mb-1 font-mono text-[12px] text-white/60">Motion</p>
        <div className="grid grid-cols-3 gap-2">
          {STRAP_MOTIONS.map((m) => chip(v?.strapMotion === m, STRAP_MOTION_LABEL[m], () => void act({ type: "strap", motion: m }), `strap-motion-${m}`))}
        </div>
        <p className="mt-3 mb-1 font-mono text-[12px] text-white/60">Strap position</p>
        <div className="grid grid-cols-2 gap-2">
          {CORNERS.map((c: Corner) => chip(v?.strapCorner === c, CORNER_LABEL[c], () => void act({ type: "strap", corner: c }), `strap-corner-${c}`))}
        </div>
      </section>

      <section className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-mono text-[12px] tracking-[0.14em] text-white/60 uppercase">Social circles</h2>
          <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-bold ${v?.socialsOverlay ? "bg-[#f04438]" : "bg-white/10"}`}>{v?.socialsOverlay ? "SHOWING" : "HIDDEN"}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" data-testid="socials-show" disabled={!state || busy} onClick={() => void act({ type: "socials", show: true }, "Socials shown")} className="min-h-14 rounded-[14px] bg-[#12b76a] text-[16px] font-black disabled:opacity-40">Show</button>
          <button type="button" data-testid="socials-hide" disabled={!state || busy} onClick={() => void act({ type: "socials", show: false }, "Socials hidden")} className="min-h-14 rounded-[14px] bg-[#b42318] text-[16px] font-black disabled:opacity-40">Hide</button>
        </div>
        <p className="mt-3 mb-1 font-mono text-[12px] text-white/60">Position</p>
        <div className="grid grid-cols-2 gap-2">
          {CORNERS.map((c: Corner) => chip(v?.socialsCorner === c, CORNER_LABEL[c], () => void act({ type: "socials", corner: c }), `socials-corner-${c}`))}
        </div>
        <p className="mt-2 font-mono text-[11px] text-white/50">Top right sits below the QR code.</p>
      </section>

      {toast ? (
        <StatusToast tone={toast.tone} text={toast.text} testid="visuals-toast" />
      ) : null}
    </main>
  )
}

/** The 1920x1080 overlay page scaled into the box. */
export function OverlayPreview({ path }: { path: string }) {
  const box = useRef<HTMLDivElement | null>(null)
  const [scale, setScale] = useState(0.2)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const fit = () => setScale(el.clientWidth / 1920)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={box} className="absolute inset-0">
      <iframe title="Overlay preview" src={path} className="pointer-events-none absolute top-0 left-0 h-[1080px] w-[1920px] origin-top-left border-0" style={{ transform: `scale(${scale})` }} />
    </div>
  )
}
