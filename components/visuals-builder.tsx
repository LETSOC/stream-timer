"use client"

/**
 * Desktop Visuals builder (/visuals/builder, operator only): Library · Preview · Inspector.
 * Save-path fields (speaker presets, colours, layout) are a draft until Save (PUT /api/event).
 * Live fields (texts, ticker, prefixes, strap motion/style, program corners) apply at once over the
 * deck socket and are marked "applies live". The preview is the real VisualsLayer at 1920x1080, scaled.
 */
import Link from "next/link"
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { CountdownStage } from "@/components/countdown-stage"
import { VisualsLayer } from "@/components/visuals-layer"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import { effectiveEndTime, parseStage, socialLook } from "@/lib/stage"
import { endInstant, type TransportAction } from "@/lib/transport"
import { useDeckSocket, type DeckLink } from "@/lib/use-deck-socket"
import { CORNER_LABEL, CORNERS, PLATFORM_LABEL, PLATFORMS, STRAP_MAX, STRAP_MOTION_LABEL, STRAP_MOTIONS, STRAP_STYLE_LABEL, STRAP_STYLES, TICKER_TYPES, sanitizeTickerItems, type Corner, type Platform, type StrapMotion, type StrapPreset, type StrapStyle, type TickerType } from "@/lib/visuals"
import { EDGE_PX, GAP_X_RANGE, GAP_Y_RANGE, LAYOUT_PART_LABEL, SIZE_RANGE, type LayoutPart, type LayoutScreen } from "@/lib/visuals-layout"
import { addStrap, deleteStrap, draftDirty, draftFrom, duplicateStrap, previewStage, saveBody, setPlace, type BuilderDraft, type LoadedEvent } from "@/lib/visuals-builder"

type Sel = { kind: "part"; part: LayoutPart | "ticker" } | { kind: "strap"; id: string }
const LINK_LABEL: Record<DeckLink, string> = { connecting: "Connecting…", live: "Live sync", polling: "Polling", offline: "Offline" }
const COMPONENTS: (LayoutPart | "ticker")[] = ["strap", "talk", "qa", "sponsor", "socials", "ticker"]
const COMPONENT_LABEL: Record<LayoutPart | "ticker", string> = { ...LAYOUT_PART_LABEL, ticker: "Ticker bar" }

const panel = "rounded-[14px] border border-[#2a2a2a] bg-[#141414]"
const field = "h-9 w-full rounded-[10px] border border-[#2a2a2a] bg-[#0a0a0a] px-3 text-[13px] text-white outline-none focus:border-[#D9FF43]"
const chip = (on: boolean) => `rounded-full px-3 py-1 font-mono text-[11px] font-bold tracking-wide uppercase ${on ? "bg-[#D9FF43] text-[#0a0a0a]" : "border border-[#2a2a2a] text-white/75 hover:border-white/40"}`
const btn = "rounded-full border border-[#2a2a2a] px-3 py-1 font-mono text-[11px] text-white hover:border-white/50 disabled:opacity-35"
const mono = "font-mono text-[10px] tracking-[0.14em] text-white/45 uppercase"

function Label({ children, live }: { children: ReactNode; live?: boolean }) {
  return (
    <span className={`${mono} flex items-center gap-2`}>
      {children}
      {live ? <span data-testid="applies-live" className="rounded-full bg-[#FF3B3B]/15 px-1.5 py-px text-[9px] text-[#FF6A00]">applies live</span> : null}
    </span>
  )
}

function Slider({ label, value, range, onChange, testId, unit = "px" }: { label: string; value: number; range: { min: number; max: number }; onChange: (n: number) => void; testId: string; unit?: string }) {
  return (
    <label className="grid gap-1">
      <span className="flex justify-between"><Label>{label}</Label><span className="font-mono text-[11px] text-white/70">{value}{unit}</span></span>
      <div className="flex items-center gap-2">
        <input type="range" min={range.min} max={range.max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-[#D9FF43]" />
        <input type="number" data-testid={testId} min={range.min} max={range.max} value={value} onChange={(e) => onChange(Number(e.target.value))} className={`${field} w-20`} />
      </div>
    </label>
  )
}

/** Text that applies live on Apply (deck action), with a local draft until then. */
function LiveText({ label, value, onApply, testId, multiline }: { label: string; value: string; onApply: (v: string) => void; testId: string; multiline?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <form className="grid gap-1" onSubmit={(e) => { e.preventDefault(); if (draft !== null) { onApply(draft); setDraft(null) } }}>
      <Label live>{label}</Label>
      <div className="flex gap-2">
        {multiline
          ? <textarea data-testid={testId} rows={4} value={draft ?? value} onChange={(e) => setDraft(e.target.value)} className={`${field} h-auto py-2`} />
          : <input data-testid={testId} maxLength={120} value={draft ?? value} onChange={(e) => setDraft(e.target.value)} className={field} />}
        <button type="submit" data-testid={`${testId}-apply`} disabled={draft === null || draft.trim() === ""} className={`${btn} self-start py-2`}>Apply</button>
      </div>
    </form>
  )
}

export function VisualsBuilder() {
  const { link, state, run } = useDeckSocket()
  const [loaded, setLoaded] = useState<LoadedEvent | null>(null)
  const [draft, setDraft] = useState<BuilderDraft | null>(null)
  const [sel, setSel] = useState<Sel>({ kind: "part", part: "strap" })
  const [screen, setScreen] = useState<LayoutScreen>("countdown")
  const [guides, setGuides] = useState(true)
  const [showAll, setShowAll] = useState(true)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [])
  async function load(): Promise<LoadedEvent | null> {
    const res = await fetch("/api/event", { cache: "no-store" })
    if (!res.ok) { setNote({ tone: "error", text: res.status === 401 ? "Signed out: log in to the desk." : `Could not load (${res.status}).` }); return null }
    const body = (await res.json()) as LoadedEvent
    return { event: body.event, stage: body.stage, rev: body.rev, testUntil: body.testUntil ?? null, pausedAt: body.pausedAt ?? null }
  }
  useEffect(() => {
    void load().then((l) => { if (l) { setLoaded(l); setDraft(draftFrom(parseStage(l.stage))) } })
  }, [])

  const savedStage = useMemo(() => (loaded ? parseStage(loaded.stage) : null), [loaded])
  const live = state?.visuals
  const liveFields = useMemo(() => (live ? Object.fromEntries(Object.entries(live).filter(([k]) => k !== "straps" && k !== "tickerCount")) : undefined), [live])
  const event = (loaded?.event ?? DEFAULT_EVENT) as EventConfig
  const stage = useMemo(() => (loaded && draft ? previewStage(loaded.stage, liveFields, draft, { showAll, strapId: sel.kind === "strap" ? sel.id : undefined, now }) : null), [loaded, draft, liveFields, showAll, sel, now])
  const dirty = Boolean(savedStage && draft && draftDirty(savedStage, draft))

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  async function act(action: TransportAction) {
    const r = await run(action, undefined)
    if (!r.ok && r.status !== 401) setNote({ tone: "error", text: r.error ?? `Failed (${r.status})` })
  }
  const visual = (a: Omit<Extract<TransportAction, { type: "visual" }>, "type">) => act({ type: "visual", ...a } as TransportAction)

  async function save() {
    if (!draft) return
    setSaving(true)
    setNote(null)
    try {
      // Fresh load right before saving: deck taps bump rev, and the test clock must go back unchanged.
      const fresh = await load()
      if (!fresh) return
      const res = await fetch("/api/event", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(saveBody(fresh, draft)) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setNote({ tone: "error", text: body.error ?? `Save failed (${res.status})` }); return }
      const next = await load()
      if (next) { setLoaded(next); setDraft(draftFrom(parseStage(next.stage))) }
      setNote({ tone: "ok", text: "Saved" })
    } finally {
      setSaving(false)
    }
  }

  const eventEndMs = useMemo(() => {
    if (!stage) return null
    const end = endInstant(event.date, event.time, effectiveEndTime(stage, event.endTime), event.timeZone).getTime()
    return Number.isFinite(end) ? end : null
  }, [stage, event])

  if (!draft || !stage || !savedStage) {
    return <main className="grid min-h-dvh place-items-center bg-[#0a0a0a] font-mono text-sm text-white/60">{note?.text ?? "Loading builder…"}</main>
  }
  const straps = draft.straps
  const setStraps = (next: StrapPreset[]) => setDraft({ ...draft, straps: next })
  const patchStrap = (id: string, p: Partial<StrapPreset>) => setStraps(straps.map((s) => (s.id === id ? { ...s, ...p } : s)))
  const on: Record<LayoutPart | "ticker", boolean> = {
    strap: live?.strapMode === "in" || live?.strapMode === "loop",
    talk: live?.talkVisible === true,
    qa: live?.qaVisible === true,
    sponsor: live?.sponsorVisible === true,
    socials: live?.socialsOverlay === true,
    ticker: live?.tickerVisible === true,
  }

  return (
    <main data-testid="visuals-builder" className="flex h-dvh flex-col bg-[#0a0a0a] text-white" style={{ fontFamily: "var(--font-instrument-sans), 'Instrument Sans', Arial, sans-serif" }}>
      <header className="flex items-center gap-3 border-b border-[#2a2a2a] px-5 py-3">
        <span className="size-2.5 rounded-full bg-[#D9FF43]" />
        <h1 className="text-[15px] font-semibold tracking-tight">Visuals builder</h1>
        <span className="font-mono text-[11px] text-white/45">{LINK_LABEL[link]}</span>
        <div className="ml-6 flex gap-1" role="group" aria-label="Screen">
          {(["countdown", "program"] as const).map((s) => <button key={s} type="button" data-testid={`vb-screen-${s}`} aria-pressed={screen === s} onClick={() => setScreen(s)} className={chip(screen === s)}>{s === "countdown" ? "Countdown" : "Program"}</button>)}
        </div>
        <button type="button" data-testid="vb-guides" aria-pressed={guides} onClick={() => setGuides(!guides)} className={chip(guides)}>Safe-area guides</button>
        <button type="button" data-testid="vb-showall" aria-pressed={showAll} onClick={() => setShowAll(!showAll)} className={chip(showAll)}>Show all (preview)</button>
        <div className="ml-auto flex items-center gap-2">
          {note ? <span data-testid="vb-note" className={`font-mono text-[11px] ${note.tone === "ok" ? "text-[#D9FF43]" : "text-[#FF3B3B]"}`}>{note.text}</span> : null}
          {dirty ? <span className="font-mono text-[11px] text-[#FF6A00]">Unsaved changes</span> : null}
          <button type="button" data-testid="vb-revert" disabled={!dirty || saving} onClick={() => setDraft(draftFrom(savedStage))} className={btn}>Revert</button>
          <button type="button" data-testid="vb-save" disabled={!dirty || saving} onClick={() => void save()} className="rounded-full bg-[#D9FF43] px-4 py-1.5 font-mono text-[12px] font-bold text-[#0a0a0a] disabled:opacity-35">{saving ? "Saving…" : "Save"}</button>
          <Link href="/visuals" data-testid="vb-deck-link" className={`${btn} no-underline`}>Deck</Link>
          <Link href="/" className={`${btn} no-underline`}>Desk</Link>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_340px] gap-4 p-4">
        {/* Library */}
        <aside data-testid="vb-library" className={`${panel} flex min-h-0 flex-col overflow-auto p-3`}>
          <p className={`${mono} mb-2`}>Components</p>
          <ul className="m-0 mb-4 grid list-none gap-1 p-0">
            {COMPONENTS.map((c) => (
              <li key={c}>
                <button type="button" data-testid={`vb-lib-${c}`} onClick={() => setSel({ kind: "part", part: c })} className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[13px] ${sel.kind === "part" && sel.part === c ? "bg-white/10 ring-1 ring-[#D9FF43]" : "hover:bg-white/5"}`}>
                  <span className={`size-2 rounded-full ${on[c] ? "bg-[#FF3B3B] shadow-[0_0_8px_#FF3B3B]" : "bg-white/20"}`} />
                  <span className="flex-1">{COMPONENT_LABEL[c]}</span>
                  {on[c] ? <span className="font-mono text-[9px] text-[#FF3B3B]">ON AIR</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="mb-2 flex items-center">
            <p className={`${mono} mr-auto`}>Speakers ({straps.length}/{STRAP_MAX})</p>
            <button type="button" data-testid="vb-strap-add" disabled={straps.length >= STRAP_MAX} className={btn} onClick={() => { const next = addStrap(straps); setStraps(next); setSel({ kind: "strap", id: next[next.length - 1].id }) }}>+ Add</button>
          </div>
          <ul className="m-0 grid list-none gap-1 p-0">
            {straps.map((s) => (
              <li key={s.id}>
                <button type="button" data-testid={`vb-strap-${s.id}`} onClick={() => setSel({ kind: "strap", id: s.id })} className={`w-full rounded-[10px] px-2.5 py-2 text-left ${sel.kind === "strap" && sel.id === s.id ? "bg-white/10 ring-1 ring-[#D9FF43]" : "hover:bg-white/5"}`}>
                  <span className="block truncate text-[13px] font-semibold">{s.name || "(no name)"}{live?.strapId === s.id ? <span className="ml-2 font-mono text-[9px] text-[#D9FF43]">CUED</span> : null}</span>
                  <span className="block truncate font-mono text-[10px] text-white/50">{s.title || "—"} · {STRAP_STYLE_LABEL[s.style].split(" ")[0]}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* Preview */}
        <section className="flex min-h-0 flex-col gap-2">
          <div data-testid="vb-preview" data-screen={screen} className="relative aspect-video w-full overflow-hidden rounded-[14px] border border-[#2a2a2a] bg-[#1a1a1a]">
            {screen === "countdown" ? (
              <CountdownStage event={event} checker={stage.checker} showMeta={stage.showMeta} showLink={stage.showLink} lineSpacing={stage.lineSpacing} blockGap={stage.blockGap}
                clockScale={stage.clockScale} clockText={stage.clockText} logoUrl={stage.logoUrl} speakers={stage.speakers} gallerySeconds={stage.gallerySeconds} galleryPause={stage.galleryPause}
                galleryOffset={stage.galleryOffset} galleryScale={stage.galleryScale} social={socialLook(stage)} countdownStrokePx={stage.countdownStrokePx} countdownStrokeColor={stage.countdownStrokeColor}
                className="absolute inset-0 h-full w-full" />
            ) : (
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_40%,#3a3a44,#141414_70%)]">
                <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 font-mono text-[11px] tracking-[0.3em] text-white/25 uppercase">Program feed</span>
              </div>
            )}
            <VisualsLayer stage={stage} event={event} screen={screen} now={now} eventEndMs={eventEndMs} />
            {guides ? (
              <div aria-hidden data-testid="vb-guides-layer" className="pointer-events-none absolute inset-0 z-50">
                <div className="absolute border border-dashed border-[#C6FF00]/80" style={{ inset: "5%" }} />
                <div className="absolute border border-dashed border-[#FF6A00]/60" style={{ inset: `${(EDGE_PX / 1080) * 100}% ${(EDGE_PX / 1920) * 100}%` }} />
                <span className="absolute top-[5.4%] left-[5.4%] font-mono text-[10px] text-[#C6FF00]/80">SAFE 5%</span>
              </div>
            ) : null}
          </div>
          <p className="font-mono text-[11px] text-white/45">1920×1080 scaled · {screen === "countdown" ? "Countdown screen" : "Program"} · {showAll ? "every part forced on in the preview only" : "showing what is on air now"} · <span className="text-[#C6FF00]">lime = safe 5%</span> · <span className="text-[#FF6A00]">orange = edge {EDGE_PX}px</span></p>
        </section>

        {/* Inspector */}
        <aside data-testid="vb-inspector" className={`${panel} min-h-0 overflow-auto p-4`}>
          {sel.kind === "strap" ? (() => {
            const s = straps.find((x) => x.id === sel.id)
            if (!s) return <p className="text-sm text-white/50">Pick a speaker.</p>
            return (
              <div className="grid gap-3">
                <h2 className="text-[15px] font-semibold">Speaker preset</h2>
                <label className="grid gap-1"><Label>Name</Label><input data-testid="vb-strap-name" className={field} maxLength={120} value={s.name} onChange={(e) => patchStrap(s.id, { name: e.target.value })} /></label>
                <label className="grid gap-1"><Label>Title</Label><input data-testid="vb-strap-title" className={field} maxLength={120} value={s.title} onChange={(e) => patchStrap(s.id, { title: e.target.value })} /></label>
                <label className="grid gap-1"><Label>Handle</Label><input data-testid="vb-strap-handle" className={field} maxLength={120} value={s.handle} onChange={(e) => patchStrap(s.id, { handle: e.target.value })} /></label>
                <label className="grid gap-1"><Label>Platform</Label>
                  <select data-testid="vb-strap-platform" className={field} value={s.platform} onChange={(e) => patchStrap(s.id, { platform: e.target.value as Platform })}>{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select></label>
                <label className="grid gap-1"><Label>Style</Label>
                  <select data-testid="vb-strap-style" className={field} value={s.style} onChange={(e) => patchStrap(s.id, { style: e.target.value as StrapStyle })}>{STRAP_STYLES.map((p) => <option key={p} value={p}>{STRAP_STYLE_LABEL[p]}</option>)}</select></label>
                <p className="font-mono text-[10px] text-white/45">Applies on Save. A preset needs a name or a title.</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" data-testid="vb-strap-dup" disabled={straps.length >= STRAP_MAX} className={btn} onClick={() => setStraps(duplicateStrap(straps, s.id))}>Duplicate</button>
                  <button type="button" data-testid="vb-strap-delete" className={`${btn} border-[#FF3B3B]/60 text-[#FF3B3B]`} onClick={() => { setStraps(deleteStrap(straps, s.id)); setSel({ kind: "part", part: "strap" }) }}>Delete</button>
                  <button type="button" data-testid="vb-strap-cue" disabled={dirty || !savedStage.straps.some((x) => x.id === s.id)} title={dirty ? "Save first" : undefined} className={btn} onClick={() => void act({ type: "strap", id: s.id })}>Cue on deck <span className="text-[#FF6A00]">· live</span></button>
                </div>
              </div>
            )
          })() : sel.part === "ticker" ? (
            <div className="grid gap-3">
              <h2 className="text-[15px] font-semibold">Ticker bar</h2>
              <div className="grid gap-1"><Label live>Type</Label>
                <div className="flex gap-1">{TICKER_TYPES.map((t) => <button key={t} type="button" data-testid={`vb-ticker-${t}`} className={chip(stage.tickerType === t)} onClick={() => void visual({ target: "ticker", tickerType: t as TickerType })}>{t}</button>)}</div>
              </div>
              <LiveText label="Items (one per line)" testId="vb-ticker-items" multiline value={(live?.tickerItems ?? []).join("\n")} onApply={(v) => void visual({ target: "ticker", items: sanitizeTickerItems(v) })} />
              <p className="font-mono text-[10px] text-white/45">The bar runs full width at the bottom; bottom parts lift above it while it shows. Show/Hide is on the deck.</p>
            </div>
          ) : (() => {
            const part = sel.part
            const p = draft.visualsLayout[screen][part]
            const deckCorner = screen === "program" && (part === "strap" || part === "socials")
            const liveCorner: Corner = part === "strap" ? (live?.strapCorner ?? "bottom-left") : (live?.socialsCorner ?? "bottom-left")
            const set = (patch: Parameters<typeof setPlace>[3]) => setDraft({ ...draft, visualsLayout: setPlace(draft.visualsLayout, screen, part, patch) })
            return (
              <div className="grid gap-3">
                <h2 className="text-[15px] font-semibold">{LAYOUT_PART_LABEL[part]} <span className="font-mono text-[11px] font-normal text-white/45">· {screen}</span></h2>
                {part === "socials" && screen === "countdown" ? <p className="font-mono text-[10px] text-[#FF6A00]">The countdown screen has its own social icons, so the overlay circles only draw on program and OBS.</p> : null}
                <div className="grid gap-1">
                  <Label live={deckCorner}>Corner{deckCorner ? " (deck buttons)" : ""}</Label>
                  <div className="grid grid-cols-2 gap-1">
                    {CORNERS.map((c) => {
                      const active = deckCorner ? liveCorner === c : p.corner === c
                      return <button key={c} type="button" data-testid={`vb-corner-${c}`} aria-pressed={active} className={chip(active)}
                        onClick={() => (deckCorner ? void act(part === "strap" ? { type: "strap", corner: c } : { type: "socials", corner: c }) : set({ corner: c }))}>{CORNER_LABEL[c]}</button>
                    })}
                  </div>
                </div>
                <div className="grid gap-1"><Label>Snap to</Label>
                  <div className="flex gap-1">{(["safe", "edge"] as const).map((s) => <button key={s} type="button" data-testid={`vb-snap-${s}`} aria-pressed={p.snap === s} className={chip(p.snap === s)} onClick={() => set({ snap: s })}>{s === "safe" ? "Safe 5%" : `Edge ${EDGE_PX}px`}</button>)}</div>
                </div>
                <Slider label="X gap" testId="vb-dx" value={p.dx} range={GAP_X_RANGE} onChange={(n) => set({ dx: n })} />
                <Slider label="Y gap" testId="vb-dy" value={p.dy} range={GAP_Y_RANGE} onChange={(n) => set({ dy: n })} />
                <Slider label="Size" testId="vb-size" unit="%" value={p.size} range={SIZE_RANGE} onChange={(n) => set({ size: n })} />
                <p className="font-mono text-[10px] text-white/45">Layout applies on Save, for the {screen} screen only.</p>
                <hr className="border-[#2a2a2a]" />
                {part === "strap" ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="grid gap-1"><Label>Accent</Label><input type="color" data-testid="vb-accent" className="h-9 w-full" value={draft.strapAccent} onChange={(e) => setDraft({ ...draft, strapAccent: e.target.value })} /></label>
                      <label className="grid gap-1"><Label>Text</Label><input type="color" data-testid="vb-text" className="h-9 w-full" value={draft.strapText} onChange={(e) => setDraft({ ...draft, strapText: e.target.value })} /></label>
                    </div>
                    <label className="grid gap-1"><Label live>Motion</Label>
                      <select data-testid="vb-motion" className={field} value={live?.strapMotion ?? "slide-left"} onChange={(e) => void act({ type: "strap", motion: e.target.value as StrapMotion })}>{STRAP_MOTIONS.map((m) => <option key={m} value={m}>{STRAP_MOTION_LABEL[m]}</option>)}</select></label>
                    <label className="grid gap-1"><Label live>Style override</Label>
                      <select data-testid="vb-style-override" className={field} value={live?.strapStyle ?? ""} onChange={(e) => void act({ type: "strap", style: e.target.value as StrapStyle | "" })}>
                        <option value="">Each preset&apos;s own style</option>
                        {STRAP_STYLES.map((m) => <option key={m} value={m}>{STRAP_STYLE_LABEL[m]}</option>)}
                      </select></label>
                  </>
                ) : null}
                {part === "talk" ? (
                  <>
                    <LiveText label="Talk prefix (Session)" testId="vb-talk-prefix" value={live?.talkPrefix ?? stage.talkPrefix} onApply={(v) => void visual({ target: "talk", talkPrefix: v })} />
                    <LiveText label="Festival prefix" testId="vb-festival-prefix" value={live?.festivalPrefix ?? stage.festivalPrefix} onApply={(v) => void visual({ target: "talk", festivalPrefix: v })} />
                    <p className="font-mono text-[10px] text-white/45">Mode now: {live?.talkMode ?? "session"}. Start, ±1 min and Talk/Festival are on the deck.</p>
                  </>
                ) : null}
                {part === "qa" ? <LiveText label="Q&A text" testId="vb-qa-text" value={live?.qaText ?? stage.qaText} onApply={(v) => void visual({ target: "qa", text: v })} /> : null}
                {part === "sponsor" ? <LiveText label="Sponsored text" testId="vb-sponsor-text" value={live?.sponsorText ?? stage.sponsorText} onApply={(v) => void visual({ target: "sponsor", text: v })} /> : null}
              </div>
            )
          })()}
        </aside>
      </div>
    </main>
  )
}
