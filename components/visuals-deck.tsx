"use client"

import { StatusToast, TOAST_MS } from "@/components/status-toast"
import Link from "next/link"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { useDeckSocket, type DeckLink } from "@/lib/use-deck-socket"
import { deckScreen, type Screen, type TransportAction } from "@/lib/transport"
import { LOGO_IDS, type LogoId } from "@/lib/visuals-assets"
import { CORNER_LABEL, CORNERS, formatClock, sanitizeTickerItems, STRAP_HOLD_RANGE, STRAP_MOTION_LABEL, STRAP_MOTIONS, STRAP_STYLE_LABEL, STRAP_STYLES, type Corner, type StrapStyle } from "@/lib/visuals"
import { deckLights, parseDuration, stepStrap, talkReadout, TALK_PRESETS_MIN } from "@/lib/visuals-deck"
import { ConfirmButton } from "@/components/confirm-button"

const LINK_LABEL: Record<DeckLink, string> = { connecting: "Connecting…", live: "Live sync", polling: "Polling", offline: "Offline" }
const LINK_TONE: Record<DeckLink, string> = { connecting: "bg-white/40", live: "bg-[#12b76a]", polling: "bg-[#f79009]", offline: "bg-[#f04438]" }

/**
 * Phone deck for the Visuals layer (/stream + /overlay/*). One row per component with an on-air light;
 * every tap applies at once over the deck WebSocket. Strap presets and layout are edited in the
 * builder (/visuals/builder) or the desk › Visuals. Risky taps (layer OFF, Clear all) need two taps.
 */
const SCENE_BUTTONS: [Screen, string][] = [["program", "LIVE"], ["hold09", "HOLD 09"], ["hold08", "HOLD 08"], ["hold07", "HOLD 07"], ["hold06", "HOLD 06"], ["hold05", "HOLD 05"], ["welcome", "WELCOME"], ["standby", "STANDBY"], ["break", "BREAK"], ["hold", "HOLD"], ["showreel", "SHOWREEL"], ["end", "END"]]
const SCENE_NOW: Record<Screen, string> = { program: "LIVE", countdown: "COUNTDOWN", hold05: "HOLD 05", hold06: "HOLD 06", hold07: "HOLD 07", hold08: "HOLD 08", hold09: "HOLD 09", welcome: "WELCOME", standby: "STANDBY", break: "BREAK", hold: "HOLD", showreel: "SHOWREEL", end: "END" }
const LOGO_SHORT = ["1 □", "2 ○", "3 □", "4 ○", "5 W"]
const BTN = "min-h-12 rounded-[14px] px-2 text-[15px] font-black touch-manipulation disabled:opacity-35"
const GO = `${BTN} bg-[#12b76a] text-black`
const STOP = `${BTN} bg-[#f04438] text-white`
const PLAIN = `${BTN} border border-white/25 bg-white/[0.06] text-white`
const SEL = `${BTN} bg-white text-[#0b0b0f]`

function Row({ title, on, label, children, testId }: { title: string; on: boolean; label?: string; children: ReactNode; testId: string }) {
  return (
    <section data-testid={testId} className="mb-3 rounded-[18px] border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span aria-hidden className={`size-3 rounded-full ${on ? "bg-[#f04438] shadow-[0_0_10px_#f04438]" : "bg-white/20"}`} />
        <h2 className="mr-auto text-[15px] font-black tracking-tight uppercase">{title}</h2>
        <span data-testid={`${testId}-light`} data-on={on ? "1" : "0"} className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-bold ${on ? "bg-[#f04438] text-white" : "bg-white/10 text-white/70"}`}>{label ?? (on ? "ON AIR" : "OFF")}</span>
      </div>
      {children}
    </section>
  )
}

export function VisualsDeck() {
  const { link, state, run } = useDeckSocket()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [hold, setHold] = useState<number | null>(null)
  const [custom, setCustom] = useState("")
  const [tickerDraft, setTickerDraft] = useState<string | null>(null)
  const [qaDraft, setQaDraft] = useState<string | null>(null)
  const [sponsorDraft, setSponsorDraft] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
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
  const lights = v ? deckLights(v, now) : null
  const talk = v ? talkReadout(v, now) : { ms: null, state: "stopped" as const }
  const holdSec = hold ?? v?.strapHoldSec ?? 5
  const scr: Screen | null = state ? deckScreen(state, now) : null
  const off = !state || busy

  // Minimal toasts: errors always; "ok" only where the screen doesn't already show the change.
  async function act(action: TransportAction, ok?: string) {
    if (!state || busy) return false
    setBusy(true)
    const result = await run(action, undefined)
    setBusy(false)
    if (result.ok) {
      if (ok) setToast({ tone: "ok", text: ok })
      if (navigator.vibrate) navigator.vibrate(15)
      return true
    }
    if (result.status !== 401) setToast({ tone: "error", text: result.error ?? `Failed (${result.status})` })
    return false
  }
  const visual = (a: Omit<Extract<TransportAction, { type: "visual" }>, "type">, ok?: string) => act({ type: "visual", ...a } as TransportAction, ok)
  const pick = (dir: 1 | -1) => {
    const id = v ? stepStrap(v.straps.map((p) => p.id), v.strapId, dir) : null
    if (id) void act({ type: "strap", id })
  }
  const showHide = (on: boolean, target: "talk" | "ticker" | "qa" | "sponsor", id: string) => (
    <div className="grid grid-cols-2 gap-2">
      <button type="button" data-testid={`${id}-show`} disabled={off} aria-pressed={on} onClick={() => void visual({ target, show: true })} className={on ? SEL : GO}>Show</button>
      <button type="button" data-testid={`${id}-hide`} disabled={off} onClick={() => void visual({ target, show: false })} className={STOP}>Hide</button>
    </div>
  )
  const textEdit = (id: string, value: string, draft: string | null, setDraft: (s: string | null) => void, target: "qa" | "sponsor") => (
    <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (draft !== null) void visual({ target, text: draft }, "Text saved").then((ok) => ok && setDraft(null)) }}>
      <input data-testid={`${id}-text`} value={draft ?? value} maxLength={120} onChange={(e) => setDraft(e.target.value)} className="h-12 min-w-0 flex-1 rounded-[12px] border border-white/20 bg-black px-3 text-[15px] text-white" />
      <button type="submit" data-testid={`${id}-save`} disabled={off || draft === null || draft.trim() === ""} className={`${PLAIN} px-4`}>Save</button>
    </form>
  )

  return (
    <main className="min-h-dvh bg-[#0b0b0f] px-[max(12px,env(safe-area-inset-left))] pt-[max(10px,env(safe-area-inset-top))] pb-[max(88px,calc(env(safe-area-inset-bottom)+72px))] text-white">
      <header className="mb-3 flex items-center gap-2">
        <h1 className="mr-auto text-lg font-black tracking-tight uppercase">Visuals</h1>
        <span data-testid="visuals-link-state" className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 font-mono text-[12px]">
          <span aria-hidden className={`size-2 rounded-full ${LINK_TONE[link]}`} />
          {LINK_LABEL[link]}
        </span>
        <Link href="/visuals/builder" data-testid="visuals-builder-link" className="rounded-full border border-[#D9FF43]/60 px-3 py-1 font-mono text-[12px] text-[#D9FF43] no-underline">Builder</Link>
        <Link href="/deck" className="rounded-full border border-white/30 px-3 py-1 font-mono text-[12px] text-white no-underline">Deck</Link>
        <Link href="/" className="rounded-full border border-white/30 px-3 py-1 font-mono text-[12px] text-white no-underline">Desk</Link>
      </header>

      <Row title="/stream layer" on={lights?.layer ?? false} label={lights?.layer ? "ON" : "OFF · OBS only"} testId="vd-layer">
        <div className="grid grid-cols-2 gap-2">
          {lights?.layer ? (
            <ConfirmButton data-testid="vd-layer-off" disabled={off} confirmLabel="Tap again: layer OFF" className={STOP} onConfirm={() => void visual({ target: "stream", show: false }, "Layer off /stream")}>Layer OFF</ConfirmButton>
          ) : (
            <button type="button" data-testid="vd-layer-on" disabled={off} onClick={() => void visual({ target: "stream", show: true }, "Layer on /stream")} className={GO}>Layer ON</button>
          )}
          <ConfirmButton data-testid="vd-clear" disabled={off} confirmLabel="Tap again: clear all" className={PLAIN} onConfirm={() => void visual({ target: "clear" }, "All overlays cleared")}>Clear all</ConfirmButton>
        </div>
        <button type="button" onClick={() => setPreview(!preview)} className="mt-2 font-mono text-[12px] text-white/60 underline">{preview ? "Hide preview" : "Show preview"}</button>
        {preview ? (
          <div className="relative mx-auto mt-2 aspect-video w-full overflow-hidden rounded-xl border border-white/10">
            <OverlayPreview path="/overlay/visuals?checker=1" />
          </div>
        ) : null}
      </Row>

      <Row title="Scenes" on={scr !== null && scr !== "program" && scr !== "countdown"} label={scr ? SCENE_NOW[scr] : "—"} testId="vd-scenes">
        <div className="grid grid-cols-3 gap-1.5">
          {SCENE_BUTTONS.map(([target, label]) => {
            const active = scr === target
            const cls = `${active ? SEL : target === "program" ? GO : PLAIN} min-h-11 px-1 text-[13px]`
            // Every scene/card switch (LIVE too) takes two taps, on phone and desktop, program live or not.
            return <ConfirmButton key={target} data-testid={`vd-scene-${target}`} aria-pressed={active} disabled={off} confirmLabel="Tap again" className={cls} onConfirm={() => void act({ type: "screen", screen: target })}>{label}</ConfirmButton>
          })}
        </div>
        <p className="mt-2 font-mono text-[11px] text-white/50">LIVE = program feed. Cards cover the picture; edit them in the builder › Scenes.</p>
      </Row>

      <Row title="Name strap" on={lights?.strap ?? false} label={lights?.strap ? "ON AIR" : v?.strapMode === "loop" ? "LOOP" : "OFF"} testId="vd-strap">
        {v && v.straps.length ? (
          <div className="mb-2 flex items-center gap-2">
            <button type="button" data-testid="vd-strap-prev" disabled={off} onClick={() => pick(-1)} className={`${PLAIN} w-12`} aria-label="Previous speaker">‹</button>
            <select data-testid="vd-strap-pick" disabled={off} value={v.strapId} onChange={(e) => void act({ type: "strap", id: e.target.value })} className="h-12 min-w-0 flex-1 rounded-[12px] border border-white/20 bg-black px-2 text-[15px] font-bold text-white">
              {v.straps.some((p) => p.id === v.strapId) ? null : <option value="">Pick a speaker…</option>}
              {v.straps.map((p) => <option key={p.id} value={p.id}>{p.name || p.title}{p.title && p.name ? ` · ${p.title}` : ""}</option>)}
            </select>
            <button type="button" data-testid="vd-strap-next" disabled={off} onClick={() => pick(1)} className={`${PLAIN} w-12`} aria-label="Next speaker">›</button>
          </div>
        ) : (
          <p className="mb-2 font-mono text-[13px] text-white/60">No speakers yet: add them on the desk › Visuals (Save).</p>
        )}
        <div className="grid grid-cols-3 gap-2">
          <button type="button" data-testid="strap-in" disabled={off || !v?.strapId} onClick={() => void act({ type: "strap", mode: "in", holdSec })} className={GO}>IN</button>
          <button type="button" data-testid="strap-out" disabled={off} onClick={() => void act({ type: "strap", mode: "out" })} className={STOP}>OUT</button>
          <button type="button" data-testid="strap-loop" aria-pressed={v?.strapMode === "loop"} disabled={off || !v?.strapId} onClick={() => void act({ type: "strap", mode: "loop", holdSec })} className={v?.strapMode === "loop" ? `${BTN} bg-[#f79009] text-black` : PLAIN}>LOOP</button>
        </div>
        <label className="mt-3 block font-mono text-[12px] text-white/70">
          Hold {holdSec}s
          <input type="range" data-testid="strap-hold" className="mt-1 w-full accent-[#d4ff32]" min={STRAP_HOLD_RANGE.min} max={STRAP_HOLD_RANGE.max} step={0.5} value={holdSec}
            onChange={(e) => setHold(Number(e.target.value))}
            onPointerUp={() => hold !== null && void act({ type: "strap", holdSec: hold }).then(() => setHold(null))}
            onKeyUp={() => hold !== null && void act({ type: "strap", holdSec: hold }).then(() => setHold(null))} />
        </label>
        <details className="mt-2">
          <summary className="cursor-pointer font-mono text-[12px] text-white/60">Style · motion · position</summary>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <button type="button" disabled={off} aria-pressed={v?.strapStyle === ""} onClick={() => void act({ type: "strap", style: "" })} className={v?.strapStyle === "" ? SEL : PLAIN}>Preset&apos;s</button>
            {STRAP_STYLES.map((st: StrapStyle) => <button key={st} type="button" data-testid={`strap-style-${st}`} disabled={off} aria-pressed={v?.strapStyle === st} onClick={() => void act({ type: "strap", style: st })} className={v?.strapStyle === st ? SEL : PLAIN}>{STRAP_STYLE_LABEL[st]}</button>)}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {STRAP_MOTIONS.map((m) => <button key={m} type="button" disabled={off} aria-pressed={v?.strapMotion === m} onClick={() => void act({ type: "strap", motion: m })} className={v?.strapMotion === m ? SEL : PLAIN}>{STRAP_MOTION_LABEL[m]}</button>)}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {CORNERS.map((c: Corner) => <button key={c} type="button" disabled={off} aria-pressed={v?.strapCorner === c} onClick={() => void act({ type: "strap", corner: c })} className={v?.strapCorner === c ? SEL : PLAIN}>{CORNER_LABEL[c]}</button>)}
          </div>
          <p className="mt-2 font-mono text-[11px] text-white/50">Speakers are edited on the desk › Visuals (builder: /visuals/builder, coming next).</p>
        </details>
      </Row>

      <Row title="Talk timer" on={lights?.talk ?? false} label={lights?.talk ? "SHOWING" : "HIDDEN"} testId="vd-talk">
        <div className="mb-2 flex items-baseline justify-between">
          <span data-testid="vd-talk-readout" data-state={talk.state} className={`font-mono text-[34px] font-bold tabular-nums ${talk.state === "over" ? "text-[#f04438]" : talk.state === "paused" ? "text-[#f79009]" : ""}`}>{formatClock(talk.ms)}</span>
          <span className="font-mono text-[12px] text-white/60">{v?.talkMode === "festival" ? "pill shows: to event end" : talk.state}</span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {TALK_PRESETS_MIN.map((m) => <button key={m} type="button" data-testid={`vd-talk-${m}`} disabled={off} onClick={() => void visual({ target: "talk", op: "start", sec: m * 60 })} className={`${PLAIN} px-0`}>{m}′</button>)}
        </div>
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); const sec = parseDuration(custom); if (sec === null) return setToast({ tone: "error", text: "Minutes, or mm:ss" }); void visual({ target: "talk", op: "start", sec }).then((ok) => ok && setCustom("")) }}>
          <input data-testid="vd-talk-custom" inputMode="numeric" placeholder="Custom: 25 or 25:30" value={custom} onChange={(e) => setCustom(e.target.value)} className="h-12 min-w-0 flex-1 rounded-[12px] border border-white/20 bg-black px-3 text-[15px] text-white" />
          <button type="submit" data-testid="vd-talk-start" disabled={off || !custom.trim()} className={`${GO} px-4`}>Start</button>
        </form>
        <div className="mt-2 grid grid-cols-4 gap-2">
          <button type="button" data-testid="vd-talk-minus" disabled={off || talk.state === "stopped"} onClick={() => void visual({ target: "talk", op: "add", sec: -60 })} className={PLAIN}>−1′</button>
          <button type="button" data-testid="vd-talk-plus" disabled={off || talk.state === "stopped"} onClick={() => void visual({ target: "talk", op: "add", sec: 60 })} className={PLAIN}>+1′</button>
          {talk.state === "paused" ? (
            <button type="button" data-testid="vd-talk-resume" disabled={off} onClick={() => void visual({ target: "talk", op: "resume" })} className={GO}>Resume</button>
          ) : (
            <button type="button" data-testid="vd-talk-pause" disabled={off || talk.state === "stopped" || talk.state === "over"} onClick={() => void visual({ target: "talk", op: "pause" })} className={PLAIN}>Pause</button>
          )}
          <button type="button" data-testid="vd-talk-stop" disabled={off || talk.state === "stopped"} onClick={() => void visual({ target: "talk", op: "stop" })} className={STOP}>Stop</button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(["session", "festival"] as const).map((m) => <button key={m} type="button" data-testid={`vd-talk-mode-${m}`} disabled={off} aria-pressed={v?.talkMode === m} onClick={() => void visual({ target: "talk", mode: m })} className={v?.talkMode === m ? SEL : PLAIN}>{m === "session" ? "Talk" : "Festival"}</button>)}
        </div>
        <div className="mt-2">{showHide(lights?.talk ?? false, "talk", "vd-talk")}</div>
      </Row>

      <Row title="Ticker" on={lights?.ticker ?? false} label={lights?.ticker ? "SHOWING" : v?.tickerVisible ? "NO ITEMS" : "HIDDEN"} testId="vd-ticker">
        {showHide(v?.tickerVisible ?? false, "ticker", "vd-ticker")}
        <div className="mt-2 grid grid-cols-2 gap-2">
          {(["planner", "social"] as const).map((t) => <button key={t} type="button" data-testid={`vd-ticker-${t}`} disabled={off} aria-pressed={v?.tickerType === t} onClick={() => { setTickerDraft(null); void visual({ target: "ticker", tickerType: t }) }} className={v?.tickerType === t ? SEL : PLAIN}>{t === "planner" ? `Planner (${v?.tickerPlannerItems?.length ?? 0})` : `Social (${v?.tickerSocialItems?.length ?? 0})`}</button>)}
        </div>
        <textarea data-testid="vd-ticker-items" data-list={v?.tickerType ?? "planner"} rows={4} placeholder={`${v?.tickerType === "social" ? "Social" : "Planner"} items, one per line`} value={tickerDraft ?? ((v?.tickerType === "social" ? v?.tickerSocialItems : v?.tickerPlannerItems) ?? v?.tickerItems ?? []).join("\n")} onChange={(e) => setTickerDraft(e.target.value)} className="mt-2 w-full rounded-[12px] border border-white/20 bg-black p-3 text-[15px] text-white" />
        <button type="button" data-testid="vd-ticker-save" disabled={off || tickerDraft === null} onClick={() => tickerDraft !== null && void visual({ target: "ticker", items: sanitizeTickerItems(tickerDraft), list: v?.tickerType ?? "planner" }, "Ticker saved").then((ok) => ok && setTickerDraft(null))} className={`${PLAIN} mt-2 w-full`}>Save {v?.tickerType === "social" ? "Social" : "Planner"} items</button>
      </Row>

      <Row title="Q&A" on={lights?.qa ?? false} label={lights?.qa ? "SHOWING" : "HIDDEN"} testId="vd-qa">
        {showHide(lights?.qa ?? false, "qa", "vd-qa")}
        {textEdit("vd-qa", v?.qaText ?? "", qaDraft, setQaDraft, "qa")}
      </Row>

      <Row title="Sponsored" on={lights?.sponsor ?? false} label={lights?.sponsor ? "SHOWING" : "HIDDEN"} testId="vd-sponsor">
        {showHide(lights?.sponsor ?? false, "sponsor", "vd-sponsor")}
        {textEdit("vd-sponsor", v?.sponsorText ?? "", sponsorDraft, setSponsorDraft, "sponsor")}
      </Row>

      <Row title="Social circles" on={lights?.socials ?? false} label={lights?.socials ? "SHOWING" : "HIDDEN"} testId="vd-socials">
        <div className="grid grid-cols-2 gap-2">
          <button type="button" data-testid="socials-show" disabled={off} aria-pressed={lights?.socials} onClick={() => void act({ type: "socials", show: true })} className={lights?.socials ? SEL : GO}>Show</button>
          <button type="button" data-testid="socials-hide" disabled={off} onClick={() => void act({ type: "socials", show: false })} className={STOP}>Hide</button>
        </div>
        <p className="mt-2 font-mono text-[11px] text-white/50">On the program screen and OBS; the countdown has its own circles.</p>
      </Row>

      <Row title="Logos" on={(v?.logosOn ?? []).length > 0} label={(v?.logosOn ?? []).length ? `${(v?.logosOn ?? []).length} ON` : "OFF"} testId="vd-logos">
        <div className="grid grid-cols-5 gap-1.5">
          {LOGO_IDS.map((id: LogoId, i) => {
            const shown = (v?.logosOn ?? []).includes(id)
            return <button key={id} type="button" data-testid={`vd-logo-${id}`} aria-pressed={shown} disabled={off} onClick={() => void visual({ target: "logo", logo: id, show: !shown })} className={`${shown ? SEL : PLAIN} px-0`}>{LOGO_SHORT[i]}</button>
          })}
        </div>
        <p className="mt-2 font-mono text-[11px] text-white/50">Tap to show / hide. 1 □ 2 ○ large · 3 □ 4 ○ small · 5 wordmark.</p>
      </Row>

      <Row title="QR" on={Boolean(v?.qrOn || v?.qrLogoOn)} label={v?.qrOn || v?.qrLogoOn ? "SHOWING" : "HIDDEN"} testId="vd-qr">
        <div className="grid grid-cols-2 gap-2">
          <button type="button" data-testid="vd-qr-toggle" aria-pressed={v?.qrOn === true} disabled={off} onClick={() => void visual({ target: "qr", show: !v?.qrOn })} className={v?.qrOn ? SEL : PLAIN}>{v?.qrOn ? "QR ✓" : "QR"}</button>
          <button type="button" data-testid="vd-qr-logo-toggle" aria-pressed={v?.qrLogoOn === true} disabled={off} onClick={() => void visual({ target: "qrLogo", show: !v?.qrLogoOn })} className={v?.qrLogoOn ? SEL : PLAIN}>{v?.qrLogoOn ? "Logo QR ✓" : "Logo QR"}</button>
        </div>
      </Row>

      {toast ? <StatusToast tone={toast.tone} text={toast.text} testid="visuals-toast" /> : null}
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
