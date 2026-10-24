"use client"

import { VerticalDeckTile } from "@/components/vertical-output"
import { armFeed, failoverText, ProgramSourceSwitch, useFailoverEvents } from "@/components/program-source-switch"
import { markDropout, markToast } from "@/components/dropout-mark"
import { FeedStatus } from "@/components/feed-status"
import type { FailoverSettings } from "@/lib/program-source"
import { LanIngestInfo } from "@/components/lan-ingest-info"
import Link from "next/link"
import { ConfirmButton } from "@/components/confirm-button"
import { AppNav } from "@/components/app-nav"
import { useResumeGeneration } from "@/lib/use-resume"
import { useAutoHide } from "@/components/auto-hide"
import { StatusToast, TOAST_MS, TOAST_UNDO_MS } from "@/components/status-toast"
import { LocalAccessPill } from "@/components/local-access-pill"
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { StreamPlayer } from "@/components/stream-player"
import { remainingUntil } from "@/lib/countdown"
import { ProgramPlayer, programOperatorSrc } from "@/components/program-feed"
import { CARD_OVERLAYS } from "@/lib/stage"
import { deckScreen, effectiveNow, endCardAt, END_STEPS, endsLabel, formatOffset, eventTarget, EXTENDS, extendTarget, isRisky, JUMPS, lockedInLive, type DeckState, type Screen, type TransportAction } from "@/lib/transport"
import { useDeckSocket, type DeckLink } from "@/lib/use-deck-socket"
import type { EventConfig } from "@/lib/event"

const SCREEN_LABEL: Record<Screen, string> = { countdown: "Countdown", break: "Break card", hold: "Hold card", welcome: "Welcome card", hold05: "HOLD 05", hold06: "HOLD 06", hold07: "HOLD 07", hold08: "HOLD 08", hold09: "HOLD 09", standby: "Standby card", showreel: "Showreel", program: "Program (OBS)", end: "End card" }
const LINK_LABEL: Record<DeckLink, string> = { connecting: "Connecting…", live: "Live sync", polling: "Polling (no WebSocket)", offline: "Offline" }
const LINK_TONE: Record<DeckLink, string> = { connecting: "bg-white/40", live: "bg-[#12b76a]", polling: "bg-[#f79009]", offline: "bg-[#f04438]" }

type Preview = "off" | "stream" | "slate" | "capture" | "vertical"

function endCardLabel(state: DeckState, now: number): { when: string; remaining: string; testClock: boolean } {
  const stale = state.testStale
  const testClock = Boolean(!stale && (state.testUntil !== null || state.pausedAt !== null))
  const at = effectiveNow({ event: { date: state.date, time: state.time, timeZone: state.timeZone } as EventConfig, testUntil: stale ? null : state.testUntil, pausedAt: stale ? null : state.pausedAt }, now)
  const endMs = endCardAt(state.date, state.time, state.endTime, state.timeZone, state.endOffsetMin)
  const when = Number.isFinite(endMs) ? new Intl.DateTimeFormat("en-GB", { timeZone: state.timeZone || "UTC", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(endMs).replace(",", "") : state.endTime
  const end = new Date(endMs)
  if (!Number.isFinite(end.getTime())) return { when, remaining: "—", testClock }
  const r = remainingUntil(end, new Date(at))
  if (r.done) return { when, remaining: state.forceEnd || !state.holdCountdown ? "due / showing" : "past (held)", testClock }
  return { when, remaining: `${r.days ? `${r.days}d ` : ""}${pad(r.hours)}:${pad(r.minutes)}:${pad(r.seconds)}`, testClock }
}

function pad(n: number) {
  return String(n).padStart(2, "0")
}

function clockText(state: DeckState, now: number): string {
  const event = { date: state.date, time: state.time, timeZone: state.timeZone } as EventConfig
  const target = eventTarget(event)
  if (!Number.isFinite(target.getTime())) return "—"
  const stale = state.testStale
  const at = effectiveNow({ event, testUntil: stale ? null : state.testUntil, pausedAt: stale ? null : state.pausedAt }, now)
  const r = remainingUntil(target, new Date(at))
  if (r.done) return "LIVE"
  return `${r.days ? `${r.days}d ` : ""}${pad(r.hours)}:${pad(r.minutes)}:${pad(r.seconds)}`
}

export function StreamDeck() {
  const { link, state, run } = useDeckSocket()
  const [now, setNow] = useState(() => Date.now())
  const [offset, setOffset] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [toast, setToast] = useState<{ tone: "error" | "ok"; text: string; undo?: TransportAction } | null>(null)
  const [preview, setPreview] = useStoredPref<Preview>("deck-preview-mode", "off", ["off", "stream", "slate", "capture", "vertical"])
  const [collapsed, setCollapsed] = useStoredPref<"0" | "1">("deck-preview-collapsed", "0", ["0", "1"])
  const [big, setBig] = useState(false)
  const chrome = useAutoHide()
  const [relayReady, setRelayReady] = useState<{ slate: boolean; capture: boolean; vertical: boolean }>({ slate: false, capture: false, vertical: false })

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])
  // Server clock offset, so a phone with a drifting clock still shows the server's countdown.
  useEffect(() => {
    if (state) setOffset(state.serverNow - Date.now())
  }, [state])
  useEffect(() => {
    if (!armed) return
    const id = window.setTimeout(() => setArmed(null), 3000)
    return () => window.clearTimeout(id)
  }, [armed])
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), toast.undo ? TOAST_UNDO_MS : TOAST_MS)
    return () => window.clearTimeout(id)
  }, [toast])
  useEffect(() => {
    if (preview === "off" || preview === "stream") return
    let cancelled = false
    const load = async () => {
      const body = (await (await fetch("/api/relay", { cache: "no-store" }).catch(() => null))?.json().catch(() => null)) as { paths?: Record<string, { ready?: boolean }> } | null
      if (!cancelled && body?.paths) setRelayReady({ slate: body.paths.slate?.ready === true, capture: body.paths.capture?.ready === true, vertical: body.paths.vertical?.ready === true })
    }
    void load()
    const id = window.setInterval(() => void load(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [preview])

  useFailoverEvents(state?.programSources?.last, (e) => {
    const alarm = e.auto && e.from !== e.to // a re-arm/note is informational, a switch is an alarm
    setToast({ tone: alarm ? "error" : "ok", text: failoverText(e) })
    if (alarm && navigator.vibrate) navigator.vibrate([60, 60, 60])
  })
  async function saveFailover(patch: Partial<FailoverSettings>) {
    const response = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "failover", failover: patch }) }).catch(() => null)
    if (!response?.ok) setToast({ tone: "error", text: "Could not save the failover setting." })
  }

  const serverNow = now + offset
  const live = state?.deskLive ?? false
  const screen = state ? deckScreen(state, serverNow) : null
  const testActive = Boolean(state && !state.testStale && (state.testUntil !== null || state.pausedAt !== null))

  async function act(key: string, action: TransportAction, confirmed = false) {
    if (!state || busy) return
    if (!confirmed && isRisky(action) && armed !== key) {
      setArmed(key)
      return
    }
    setArmed(null)
    setBusy(key)
    const before = { endTime: state.endTime, endOffsetMin: state.endOffsetMin }
    const result = await run(action, state.rev)
    setBusy(null)
    if (result.ok && action.type === "extendEnd") {
      setToast({ tone: "ok", text: `${action.minutes < 0 ? "Shortened" : "Extended"} to ${extendTarget(before.endTime, action.minutes).to}`, undo: { type: "setEnd", ...before } })
      if (navigator.vibrate) navigator.vibrate(30)
    } else if (result.ok && action.type === "setEnd") {
      setToast({ tone: "ok", text: `End back to ${endsLabel(state.date, state.time, action.endTime, state.timeZone, action.endOffsetMin).replace("Ends ", "")}` })
    } else if (result.ok && action.type === "endOffset") {
      const offset = "clear" in action ? 0 : before.endOffsetMin + action.minutes
      setToast({ tone: "ok", text: endsLabel(state.date, state.time, state.endTime, state.timeZone, offset), undo: { type: "setEnd", ...before } })
      if (navigator.vibrate) navigator.vibrate(30)
    } else if (result.ok) {
      setToast({ tone: "ok", text: "Done" })
      if (navigator.vibrate) navigator.vibrate(30)
    } else if (result.status !== 401) {
      setToast({ tone: "error", text: result.error ?? `Failed (${result.status})` })
    }
  }

  const button = (key: string, action: TransportAction, label: ReactNode, tone: "live" | "danger" | "solid" | "outline" | "on" = "solid", extra = "") => {
    const disabled = !state || (live && lockedInLive(action)) || (busy !== null && busy !== key)
    const isArmed = armed === key
    const tones = {
      live: "bg-[#d93200] text-white active:bg-[#bf2c00]",
      danger: "border-2 border-[#f97066] bg-transparent text-[#fda29b] active:bg-[#b42318] active:text-white",
      solid: "bg-white/10 text-white active:bg-white/20",
      outline: "border border-white/30 bg-transparent text-white active:bg-white/10",
      on: "bg-[#D9FF43] text-black",
    }
    return (
      <button
        key={key}
        type="button"
        data-testid={`deck-${key}`}
        data-armed={isArmed ? "1" : undefined}
        disabled={disabled}
        onClick={() => void act(key, action)}
        className={`min-h-16 touch-manipulation rounded-2xl px-3 py-3 text-[17px] font-bold leading-tight select-none disabled:opacity-35 ${tones[tone]} ${isArmed ? "ring-4 ring-[#fdb022] ring-offset-2 ring-offset-[#0b0b0f]" : ""} ${extra}`}
      >
        {isArmed ? "Tap again to confirm" : busy === key ? "…" : label}
      </button>
    )
  }

  return (
    <main className="min-h-dvh bg-[#0b0b0f] px-[max(12px,env(safe-area-inset-left))] pb-[max(88px,calc(env(safe-area-inset-bottom)+72px))] text-white">
      {/* Pinned: header + preview stay on screen while the buttons scroll underneath. */}
      <div data-testid="deck-sticky" className="sticky top-0 z-20 -mx-3 mb-3 border-b border-white/10 bg-[#0b0b0f] px-4 pt-[max(10px,env(safe-area-inset-top))] pb-2 shadow-[0_8px_16px_rgba(0,0,0,0.6)] sm:px-6">
      <header className="mb-2 flex flex-wrap items-center gap-3">
        <div className="w-[240px] shrink-0">
          <p className="font-mono text-[12px] tracking-[0.16em] text-white/40 uppercase">Hyphen Festival 2026</p>
          <h1 className="text-xl font-black tracking-tight uppercase">Stream Deck</h1>
        </div>
        <AppNav page="deck" />
        <span data-testid="deck-link-state" data-state={link} className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 font-mono text-[12px] text-white/70">
          <span aria-hidden className={`size-2 rounded-full ${LINK_TONE[link]} ${link === "connecting" ? "animate-pulse" : ""}`} />
          {LINK_LABEL[link]}
        </span>
      </header>
        <PreviewBar preview={preview} setPreview={setPreview} collapsed={collapsed === "1"} toggle={() => setCollapsed(collapsed === "1" ? "0" : "1")} />
        {collapsed === "1" || preview === "off" ? null : (
          <div
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                setBig(!big)
              }
            }}
            data-testid="deck-preview-box"
            {...chrome.bind}
            data-big={big ? "1" : "0"}
            aria-label={big ? "Make preview smaller" : "Make preview bigger"}
            onClick={() => setBig(!big)}
            className={`relative mx-auto mt-2 block touch-manipulation overflow-hidden rounded-xl bg-black transition-[width] duration-200 ${preview === "vertical" ? `aspect-[9/16] ${big ? "w-[70%] max-w-[calc(62dvh*9/16)]" : "w-[34%] max-w-[calc(30dvh*9/16)]"}` : `aspect-video ${big ? "w-full max-w-[calc(62dvh*16/9)]" : "w-[78%] max-w-[calc(30dvh*16/9)]"}`}`}
          >
            <FeedStatus view={state?.programSources} className="absolute top-1.5 left-1.5 z-20" />
            {preview === "stream" && screen === "program" ? <ProgramPlayer scope="deck" src={programOperatorSrc(state?.programSource === "backup" ? "program-backup" : "program")} ready={state?.programReady === true} rearmHoldMs={state?.rearmHoldMs ?? 0} /> : preview === "stream" ? <StreamFrame /> : relayReady[preview] ? (
              <span data-testid="deck-preview-hls"><StreamPlayer key={preview} inline src={`/api/relay/hls/${preview}/index.m3u8`} />
              </span>
            ) : (
              <span data-testid="deck-preview-placeholder" className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center font-mono text-[12px] text-white/60">
                <span className="text-[13px] font-bold text-white/80">{preview === "vertical" ? "Vertical not publishing" : `No signal on ${preview === "slate" ? "Slate" : "Capture"} out`}</span>
                {preview === "vertical" ? "Start Vertical 9:16 (Outputs below)." : `Start the ${preview === "slate" ? "Slate" : "Browser capture"} channel with the relay on.`}
              </span>
            )}
          </div>
        )}
      </div>

      <LocalAccessPill dark className="mb-3" />
      <section aria-label="Current state" data-testid="deck-state" data-screen={screen ?? ""} data-rev={state?.rev ?? ""} className="mb-3 rounded-2xl bg-white/5 p-4">
        <p className="truncate font-mono text-[12px] tracking-[0.12em] text-white/60 uppercase">{state?.name ?? "Loading…"}</p>
        <div className="mt-1 flex items-end justify-between gap-2">
          <p data-testid="deck-screen" className="text-[26px] leading-none font-black">{screen ? SCREEN_LABEL[screen] : "—"}</p>
          <span data-testid="deck-mode" className={`rounded-full px-2.5 py-1 font-mono text-[12px] font-bold uppercase ${live ? "bg-[#d93200]" : "bg-white/15"}`}>{live ? "Live · locked" : "Rehearsal"}</span>
        </div>
        <p data-testid="deck-clock" className="mt-2 font-mono text-[40px] leading-none font-bold tabular-nums">{state ? clockText(state, serverNow) : "—"}</p>
        <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[12px]">
          {state?.pausedAt !== null && state?.pausedAt !== undefined && !state.testStale ? <span data-testid="deck-paused" className="rounded bg-[#fdb022] px-1.5 py-0.5 font-bold text-black">PAUSED</span> : null}
          {testActive ? <span data-testid="deck-test" className="rounded bg-[#7a5af8] px-1.5 py-0.5 font-bold">TEST CLOCK</span> : null}
          {state?.testStale ? <span className="rounded bg-white/15 px-1.5 py-0.5">Test clock expired</span> : null}
          {!testActive && state ? <span className="rounded bg-white/15 px-1.5 py-0.5">Real clock · {state.date} {state.time}</span> : null}
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2">
        {button("goLive", { type: "goLive" }, "Go live now", "live", "col-span-2 min-h-20 text-[20px]")}
        {state?.pausedAt !== null && state?.pausedAt !== undefined ? button("resume", { type: "resume" }, "▶ Resume", "on") : button("pause", { type: "pause" }, "❚❚ Pause")}
        {button("reset", { type: "reset" }, "Reset clock", "danger")}
        {button("restore", { type: "restore" }, "Restore festival", "danger", "col-span-2")}
      </div>

      <h2 className="mt-4 mb-2 font-mono text-[12px] tracking-[0.12em] text-white/60 uppercase">Jump · time left</h2>
      <div className="grid grid-cols-4 gap-2">
        {JUMPS.map((jump) => button(`jump-${jump.label}`, { type: "jump", seconds: jump.seconds }, jump.label, "outline"))}
      </div>

      <h2 className="mt-4 mb-2 font-mono text-[12px] tracking-[0.12em] text-white/60 uppercase">End time · {state ? `planned ${state.endTime}${state.endOffsetMin ? ` · adjusted ${formatOffset(state.endOffsetMin)}` : ""}` : "—"}</h2>
      {state ? (() => {
        const end = endCardLabel(state, serverNow)
        return (
          <div data-testid="deck-end-time" className="mb-2 rounded-2xl bg-white/5 px-4 py-3">
            <p className="font-mono text-[13px] text-white/70">Shows <span data-testid="deck-end-when" className="font-bold text-white">{end.when}</span>{state.endOffsetMin ? ` · ${formatOffset(state.endOffsetMin)}` : " · as planned"}{end.testClock ? " · on test clock" : ""}</p>
            <p data-testid="deck-end-remaining" className="mt-1 font-mono text-[18px] font-bold text-white tabular-nums">{end.remaining}</p>
          </div>
        )
      })() : null}
      <p className="mb-1 font-mono text-[12px] text-white/60">Adjust the end card (from planned) · two taps</p>
      <div className="mb-2 flex items-center gap-1.5">
        {END_STEPS.map((m) => button(`end-offset-${m < 0 ? `minus${-m}` : m}`, { type: "endOffset", minutes: m }, m < 0 ? `−${-m}m` : `+${m}m`, "outline", "min-h-11! py-1! rounded-full! flex-1 text-[14px]! tabular-nums"))}
        {state?.endOffsetMin ? button("end-offset-clear", { type: "endOffset", clear: true }, "Clear", "outline", "min-h-11! py-1! rounded-full! flex-1 text-[14px]!") : null}
      </div>
      <p className="mb-1 font-mono text-[12px] text-white/60">Planned end (Event › End time)</p>
      <div className="flex items-center gap-1.5">
        {EXTENDS.map((m) => button(`extend-${m < 0 ? `minus${-m}` : m}`, { type: "extendEnd", minutes: m }, m < 0 ? `−${-m}` : `+${m}`, "outline", "min-h-11! py-1! rounded-full! flex-1 text-[16px]! tabular-nums"))}
        <span className="shrink-0 font-mono text-[12px] text-white/60">min</span>
      </div>
      <p className="mt-2 font-mono text-[12px] text-white/60">−5/−1/+1/+5 move the end card from the planned end on the event date (−2 = 2 min early); an adjusted end cuts over Program when due, tap Program to stay on OBS past it. Clear = back to planned. The lower ±min row moves the planned Event › End time itself.</p>

      <h2 className="mt-4 mb-2 font-mono text-[12px] tracking-[0.12em] text-white/60 uppercase">Screen</h2>
      <div className="grid grid-cols-2 gap-2">
        {(["countdown", ...CARD_OVERLAYS] as const).map((name) => button(`screen-${name}`, { type: "screen", screen: name }, screen === name ? `● ${SCREEN_LABEL[name]}` : SCREEN_LABEL[name], screen === name ? "on" : "solid"))}
        {button("screen-program", { type: "screen", screen: "program" }, state?.program ? (screen === "program" ? "● Program (OBS)" : screen === "end" ? "Program · end card over it (tap to stay on)" : "● Program (under card)") : "Show program (OBS)", state?.program ? "on" : "solid", "col-span-2")}
        {state?.program && state.programReady === false ? <p data-testid="deck-program-waiting" className="col-span-2 font-mono text-[12px] text-[#fdb022]">OBS isn&apos;t sending to /program: /stream shows &ldquo;Waiting for OBS&rdquo;.</p> : null}
        {state?.programSources ? (
          <div className="col-span-2 mt-1">
            <h2 className="mb-2 font-mono text-[12px] tracking-[0.12em] text-white/60 uppercase">Program source</h2>
            <ProgramSourceSwitch dark view={state.programSources} active={state.programSource} disabled={busy !== null} onSwitch={(source) => void act(`source-${source}`, { type: "programSource", source })} onFailover={(patch) => void saveFailover(patch)} onArm={(op, feed) => { void armFeed(op, feed).then((r) => setToast({ tone: r.ok ? "ok" : "error", text: r.text })) }} onMark={(type, note) => { void markDropout(typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? "phone" : "deck", type, note).then((r) => setToast(r.ok ? { tone: "ok", text: markToast(r) } : { tone: "error", text: r.error })) }} />
          </div>
        ) : null}
        {state?.programSources ? <LanIngestInfo /> : null}
        <ConfirmButton data-testid="deck-screen-end" holdMs={3000} disabled={!state || (live && lockedInLive({ type: "screen", screen: "end" }))} onConfirm={() => void act("screen-end", { type: "screen", screen: "end" }, true)} className={`col-span-2 min-h-16 touch-manipulation rounded-2xl px-3 py-3 text-[17px] font-bold ${screen === "end" ? "bg-[#D9FF43] text-black" : "border-2 border-[#f97066] bg-transparent text-[#fda29b]"}`}>Show end card now</ConfirmButton>
      </div>

      <h2 className="mt-4 mb-2 font-mono text-[12px] tracking-[0.12em] text-white/60 uppercase">Outputs</h2>
      <div className="grid grid-cols-2 gap-2"><VerticalDeckTile /></div>

      <h2 className="mt-4 mb-2 font-mono text-[12px] tracking-[0.12em] text-white/60 uppercase">Desk mode</h2>
      <div role="radiogroup" aria-label="Desk mode" className="grid grid-cols-2 gap-2">
        {button("mode-rehearsal", { type: "mode", live: false }, "Rehearsal", live ? "outline" : "on")}
        {button("mode-live", { type: "mode", live: true }, "Live", live ? "live" : "outline")}
      </div>
      {live ? <p className="mt-2 font-mono text-[12px] text-white/60">Live: test clocks, pause, reset and restore are locked.</p> : null}

      {toast ? (
        <StatusToast tone={toast.tone} text={toast.text} testid="deck-toast" undoTestid="deck-toast-undo" onUndo={toast.undo ? () => { const undo = toast.undo!; setToast(null); void act("undo-end", undo) } : undefined} />
      ) : null}
    </main>
  )
}

const PREVIEW_LABEL: Record<Preview, string> = { off: "Off", stream: "/stream", slate: "Slate", capture: "Capture", vertical: "9:16" }

function PreviewBar({ preview, setPreview, collapsed, toggle }: { preview: Preview; setPreview: (value: Preview) => void; collapsed: boolean; toggle: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <div role="radiogroup" aria-label="Preview" className="grid flex-1 grid-cols-5 gap-1 rounded-xl bg-white/5 p-0.5">
        {(["off", "stream", "slate", "capture", "vertical"] as const).map((name) => (
          <button key={name} type="button" role="radio" aria-checked={preview === name} data-testid={`deck-preview-${name}`} onClick={() => setPreview(name)} className={`min-h-9 rounded-lg font-mono text-[12px] ${preview === name ? "bg-white text-black" : "text-white/80"}`}>
            {PREVIEW_LABEL[name]}
          </button>
        ))}
      </div>
      <button type="button" data-testid="deck-preview-collapse" aria-expanded={!collapsed} disabled={preview === "off"} onClick={toggle} className="min-h-9 min-w-11 rounded-lg bg-white/10 font-mono text-[12px] disabled:opacity-35">
        {collapsed ? "Show" : "Hide"}
      </button>
    </div>
  )
}

/** A per-device setting in localStorage, read without a hydration mismatch (server renders the fallback). */
function useStoredPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const value = useSyncExternalStore(
    (notify) => {
      prefListeners.add(notify)
      window.addEventListener("storage", notify)
      return () => {
        prefListeners.delete(notify)
        window.removeEventListener("storage", notify)
      }
    },
    () => {
      const stored = window.localStorage.getItem(key) as T | null
      return stored && allowed.includes(stored) ? stored : fallback
    },
    () => fallback,
  )
  const set = (next: T) => {
    window.localStorage.setItem(key, next)
    for (const notify of prefListeners) notify()
  }
  return [value, set]
}
const prefListeners = new Set<() => void>()

/** /stream at 1280×720 scaled to the phone width. Same-origin: the operator session is enough, no view key in the URL. */
function StreamFrame() {
  const box = useRef<HTMLSpanElement>(null)
  const [scale, setScale] = useState(0.3)
  const resume = useResumeGeneration() // iOS: a backgrounded iframe's players don't come back; remount it
  useEffect(() => {
    const node = box.current
    if (!node) return
    const observer = new ResizeObserver(() => setScale(node.clientWidth / 1280))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return (
    <span ref={box} className="absolute inset-0 block overflow-hidden">
      <iframe key={resume} data-testid="deck-preview-frame" data-gen={resume} title="/stream preview" src="/stream?mute=1" className="pointer-events-none absolute top-0 left-0 origin-top-left border-0" style={{ width: 1280, height: 720, transform: `scale(${scale})` }} />
    </span>
  )
}
