"use client"
import { useShown } from "@/lib/use-shown"
import { useLoadAlert } from "@/lib/use-load-alert"
import { LoadPaused } from "@/components/load-paused"

/**
 * Desktop Visuals builder (/visuals/builder, operator only): Library · Preview · Inspector.
 * Save-path fields (speaker presets, colours, layout) are a draft until Save (PUT /api/event).
 * Live fields (texts, ticker, prefixes, strap motion/style, program corners) apply at once over the
 * deck socket and are marked "applies live". The preview is the real VisualsLayer at 1920x1080, scaled.
 */
import Link from "next/link"
import { LinkPill } from "@/components/link-pill"
import { AppNav } from "@/components/app-nav"
import { UploadProgress } from "@/components/upload-progress"
import { FilePicker } from "@/components/file-picker"
import { useUpload } from "@/lib/use-upload"
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { COUNTDOWN_PART_LABEL, COUNTDOWN_PARTS, CountdownStage, type CountdownPart } from "@/components/countdown-stage"
import { VisualsLayer } from "@/components/visuals-layer"
import { NameStrap } from "@/components/name-strap"
import { SceneCardView } from "@/components/visual-assets"
import { LOGO_IDS, LOGO_SOURCES, SCENE_BG_MODES, SCENE_IDS, SCENE_PILL_PLACES, SCENE_LABEL, sanitizeSvg, type LogoConfig, type LogoId, type LogoSource, type QrConfig, type SceneCard, type SceneId } from "@/lib/visuals-assets"
import { DEFAULT_EVENT, type EventConfig } from "@/lib/event"
import { parseStage, socialLook } from "@/lib/stage"
import { endCardAt, type TransportAction } from "@/lib/transport"
import { useDeckSocket } from "@/lib/use-deck-socket"
import { CORNER_LABEL, CORNERS, STRAP_ACCENT_LABEL, STYLE_ACCENTS, STRAP_COLOR_LABEL, STYLE_COLORS, strapColors, type StrapColorKey, TEXT_SCALE_RANGE, strapAccentOn, type StrapDesign, type TextScalePart, PLATFORM_LABEL, PLATFORMS, STRAP_MAX, STRAP_MOTION_LABEL, STRAP_MOTIONS, STRAP_STYLE_LABEL, STRAP_STYLES, TICKER_TYPES, sanitizeTickerItems, type Corner, type Platform, type StrapMotion, type StrapPreset, type StrapStyle, type TickerType } from "@/lib/visuals"
import { EDGE_PX, GAP_X_RANGE, GAP_Y_RANGE, LAYOUT_PART_LABEL, SIZE_RANGE, type LayoutPart, type LayoutScreen } from "@/lib/visuals-layout"
import { DEFAULT_PILL, parsePillDesign, PILL_BOX_LABEL, PILL_BOXES, PILL_ICON_MODE_LABEL, PILL_ICON_MODES, PILL_LAYOUT_LABEL, PILL_LAYOUTS, PILL_NUM_LABEL, PILL_NUM_RANGE, PILL_NUMS, PILL_ORDER_LABEL, PILL_ORDERS, type PillDesign } from "@/lib/strap-pill"
import { toggleDraftAccent, addStrap, cueState, builderProgramFeed, deleteStrap, draftDirty, draftFrom, duplicateStrap, previewStage, saveBody, setPlace, type BuilderDraft, type LoadedEvent } from "@/lib/visuals-builder"
import { StreamPlayer } from "@/components/stream-player"
import { ProgramPlayer, programOperatorSrc } from "@/components/program-feed"
import { muteOnlyAudio } from "@/lib/preview-audio"

type Sel = { kind: "part"; part: LayoutPart | "ticker" } | { kind: "strap"; id: string } | { kind: "scene"; id: SceneId }

function LibGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div data-testid={`vb-group-${title.toLowerCase()}`} className="mb-3">
      <p className={`${mono} mb-1`}>{title}</p>
      <ul className="m-0 grid list-none gap-0.5 p-0">{children}</ul>
    </div>
  )
}
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

/**
 * Social pill layout options (StrapDesign.pill). Off = the classic pill exactly as before; "Customise"
 * starts from the classic values, so nothing moves until a control is changed. Applies on Save.
 */
function PillOptions({ pill, onPill }: { pill: PillDesign | undefined; onPill: (p: PillDesign | undefined) => void }) {
  if (!pill) {
    return (
      <div data-testid="vb-pill-options" className="grid gap-1"><Label>Pill layout</Label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-testid="vb-pill-customise" className={chip(false)} onClick={() => onPill({ ...DEFAULT_PILL })}>Customise</button>
          <span className="font-mono text-[10px] text-white/45">Classic: live dot · icon · two lines.</span>
        </div>
      </div>
    )
  }
  const set = (patch: Partial<PillDesign>) => onPill(parsePillDesign({ ...pill, ...patch }))
  const choice = <T extends string>(label: string, id: string, list: readonly T[], labels: Record<T, string>, value: T, key: keyof PillDesign) => (
    <div className="grid gap-1"><Label>{label}</Label>
      <div className="flex flex-wrap gap-1">{list.map((v) => <button key={v} type="button" data-testid={`vb-pill-${id}-${v}`} aria-pressed={value === v} className={chip(value === v)} onClick={() => set({ [key]: v } as Partial<PillDesign>)}>{labels[v]}</button>)}</div>
    </div>
  )
  const nums = PILL_NUMS.filter((k) => !(pill.icon === "full" && k === "iconSize") && !(pill.icon !== "full" && k === "iconInset") && !(pill.box !== "glass" && k === "blur"))
  return (
    <div data-testid="vb-pill-options" className="grid gap-3">
      <div className="flex items-center justify-between"><Label>Pill layout</Label>
        <button type="button" data-testid="vb-pill-classic" className={btn} onClick={() => onPill(undefined)}>Back to classic</button>
      </div>
      {choice("Text", "layout", PILL_LAYOUTS, PILL_LAYOUT_LABEL, pill.layout, "layout")}
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" data-testid="vb-pill-hide-sub" checked={!pill.hideSub} onChange={(e) => set({ hideSub: !e.target.checked })} className="accent-[#D9FF43]" /> Show handle / title line</label>
      {choice("Order", "order", PILL_ORDERS, PILL_ORDER_LABEL, pill.order, "order")}
      {choice("Icon", "icon", PILL_ICON_MODES, PILL_ICON_MODE_LABEL, pill.icon, "icon")}
      {choice("Box", "box", PILL_BOXES, PILL_BOX_LABEL, pill.box, "box")}
      {nums.map((k) => <Slider key={k} label={PILL_NUM_LABEL[k]} testId={`vb-pill-${k}`} value={pill[k]} range={PILL_NUM_RANGE[k]} onChange={(n) => set({ [k]: n } as Partial<PillDesign>)} />)}
      <span className="font-mono text-[10px] text-white/45">Live dot and icon show or hide with the Accents above. Auto order: dot · icon · text, or icon first when full-bleed. Full-bleed: the icon fills the pill{"'"}s height and hugs its side.</span>
    </div>
  )
}

/**
 * One strap design's values: name and subline text size and its accents (✓ = shown). Off accents are
 * not drawn, so the strap box shrinks to fit. Applies on Save, for every preset using this design.
 */
function DesignValues({ style, design, onSize, onAccent, onColor, onPill, onOneLine, accent, text }: { style: StrapStyle; design: StrapDesign; onSize: (p: Partial<Pick<StrapDesign, "nameSize" | "subSize">>) => void; onAccent: (a: (typeof STYLE_ACCENTS)[StrapStyle][number]) => void; onColor: (colors: StrapDesign["colors"]) => void; onPill: (pill: PillDesign | undefined) => void; onOneLine: (one: boolean) => void; accent: string; text: string }) {
  const c = strapColors(style, design, accent, text)
  const setColor = (k: StrapColorKey, v: string | null) => { const next = { ...(design.colors ?? {}) }; if (v === null) delete next[k]; else next[k] = v; onColor(Object.keys(next).length ? next : undefined) }
  return (
    <div data-testid="vb-design-values" data-style={style} className="grid gap-3 rounded-[10px] border border-[#2a2a2a] p-2">
      <Slider label="Name text size" testId="vb-name-size" unit="%" value={design.nameSize} range={TEXT_SCALE_RANGE} onChange={(n) => onSize({ nameSize: n })} />
      <Slider label="Subline text size" testId="vb-sub-size" unit="%" value={design.subSize} range={TEXT_SCALE_RANGE} onChange={(n) => onSize({ subSize: n })} />
      <div className="grid gap-1"><Label>Accents (tap to show or hide)</Label>
        <div className="flex flex-wrap gap-1">
          {STYLE_ACCENTS[style].map((a) => {
            const shown = strapAccentOn(design, a)
            return <button key={a} type="button" data-testid={`vb-accent-${a}`} aria-pressed={shown} className={chip(shown)} onClick={() => onAccent(a)}>{shown ? "✓ " : ""}{STRAP_ACCENT_LABEL[a]}</button>
          })}
        </div>
      </div>
      {style === "line" ? (
        <div className="grid gap-1"><Label>Text</Label>
          <div className="flex gap-1">{([false, true] as const).map((one) => <button key={String(one)} type="button" data-testid={`vb-line-${one ? "inline" : "stack"}`} aria-pressed={Boolean(design.oneLine) === one} className={chip(Boolean(design.oneLine) === one)} onClick={() => onOneLine(one)}>{one ? "One line" : "Two lines"}</button>)}</div>
        </div>
      ) : null}
      {style === "pill" ? <PillOptions pill={design.pill} onPill={onPill} /> : null}
      <div className="grid gap-1"><Label>Colours (each element on its own)</Label>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {STYLE_COLORS[style].map((k) => {
            const own = design.colors?.[k] !== undefined
            return (
              <label key={k} className="flex items-center gap-2 text-[12px]">
                <input type="color" data-testid={`vb-color-${k}`} className="h-7 w-9 shrink-0" value={c[k] || "#888888"} onChange={(e) => setColor(k, e.target.value)} />
                <span className="flex-1">{style === "pill" && k === "bar" ? "Border" : style === "house" && k === "bar" ? "Edge bar" : k === "icon" && !c.icon ? "Platform icon (brand)" : STRAP_COLOR_LABEL[k]}</span>
                {own ? <button type="button" data-testid={`vb-color-${k}-reset`} title="Back to the design colour" className="font-mono text-[10px] text-white/50 underline" onClick={() => setColor(k, null)}>reset</button> : null}
              </label>
            )
          })}
        </div>
        <span className="font-mono text-[10px] text-white/45">Unchanged colours follow the strap Accent and Text colours below.</span>
      </div>
    </div>
  )
}

/** Text size % slider (Save path) for the pills and the ticker. */
function TextSize({ label = "Text size", value, onChange, testId }: { label?: string; value: number; onChange: (n: number) => void; testId: string }) {
  return <Slider label={label} testId={testId} unit="%" value={value} range={TEXT_SCALE_RANGE} onChange={onChange} />
}

export function VisualsBuilder() {
  const uploader = useUpload()
  const { link, state, run } = useDeckSocket()
  const [loaded, setLoaded] = useState<LoadedEvent | null>(null)
  const [draft, setDraft] = useState<BuilderDraft | null>(null)
  const [sel, setSel] = useState<Sel>({ kind: "part", part: "strap" })
  const [screen, setScreen] = useState<LayoutScreen>("countdown")
  const [guides, setGuides] = useState(true)
  const [showAll, setShowAll] = useState(true)
  /** Preview only: countdown-page parts hidden while placing overlays (never saved, /stream unaffected). */
  // Program preview background: relay player (delayed reference), real /stream, or static placeholder.
  const [programBg, setProgramBg] = useState<"relay" | "live" | "placeholder">("relay")
  // Live: the real /stream page in an iframe (only mounted while selected).
  const [liveView, setLiveView] = useState(false)
  /** Builder › Name strap: which design the inspector edits (also drawn in the preview while selected). */
  const [designEdit, setDesignEdit] = useState<StrapStyle | null>(null)
  const [cdHide, setCdHide] = useState<Partial<Record<CountdownPart, boolean>>>({})
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
  const feed = builderProgramFeed(state, screen === "program" && programBg === "relay")
  const liveFields = useMemo(() => (live ? Object.fromEntries(Object.entries(live).filter(([k]) => k !== "straps" && k !== "tickerCount")) : undefined), [live])
  const event = (loaded?.event ?? DEFAULT_EVENT) as EventConfig
  const stageBase = useMemo(() => (loaded && draft ? previewStage(loaded.stage, liveFields, draft, { showAll, strapId: sel.kind === "strap" ? sel.id : undefined, now, logo: sel.kind === "part" && (LOGO_IDS as readonly string[]).includes(sel.part) ? (sel.part as LogoId) : undefined }) : null), [loaded, draft, liveFields, showAll, sel, now])
  const editingDesign = sel.kind === "part" && sel.part === "strap" && designEdit !== null
  const stage = useMemo(() => (stageBase && editingDesign && designEdit ? { ...stageBase, strapStyle: designEdit } : stageBase), [stageBase, editingDesign, designEdit])
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
  const [cueing, setCueing] = useState<string | null>(null)
  const [cuedFlash, setCuedFlash] = useState<string | null>(null)
  useEffect(() => { if (!cuedFlash) return; const t = window.setTimeout(() => setCuedFlash(null), 1800); return () => window.clearTimeout(t) }, [cuedFlash])
  async function cue(id: string) {
    setCueing(id)
    const r = await run({ type: "strap", id }, undefined)
    setCueing(null)
    if (r.ok) setCuedFlash(id)
    else if (r.status !== 401) setNote({ tone: "error", text: r.error ?? `Cue failed (${r.status})` })
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
    const end = endCardAt(event.date, event.time, event.endTime, event.timeZone, stage.endOffsetMin)
    return Number.isFinite(end) ? end : null
  }, [stage, event])

  if (!draft || !stage || !savedStage) {
    return <main className="grid min-h-dvh place-items-center bg-[#0a0a0a] font-mono text-sm text-white/60">{note?.text ?? "Loading builder…"}</main>
  }
  const straps = draft.straps
  const setStraps = (next: StrapPreset[]) => setDraft({ ...draft, straps: next })
  const patchStrap = (id: string, p: Partial<StrapPreset>) => setStraps(straps.map((s) => (s.id === id ? { ...s, ...p } : s)))
  const setDesign = (style: StrapStyle, p: Partial<StrapDesign>) => setDraft({ ...draft, strapDesigns: { ...draft.strapDesigns, [style]: { ...draft.strapDesigns[style], ...p } } })
  const setTextScale = (k: TextScalePart, n: number) => setDraft({ ...draft, textScale: { ...draft.textScale, [k]: n } })
  const designValues = (style: StrapStyle) => <DesignValues style={style} design={draft.strapDesigns[style]} onSize={(p) => setDesign(style, p)} onAccent={(a) => setDraft(toggleDraftAccent(draft, style, a))} onColor={(colors) => setDesign(style, { colors })} onPill={(pill) => setDesign(style, { pill })} onOneLine={(one) => setDesign(style, { oneLine: one || undefined })} accent={draft.strapAccent} text={draft.strapText} />
  const on: Record<LayoutPart | "ticker", boolean> = {
    ...(Object.fromEntries(LOGO_IDS.map((id) => [id, (live?.logosOn ?? []).includes(id)])) as Record<LogoId, boolean>),
    qr: live?.qrOn === true,
    qrLogo: live?.qrLogoOn === true,
    strap: live?.strapMode === "in" || live?.strapMode === "loop",
    talk: live?.talkVisible === true,
    qa: live?.qaVisible === true,
    sponsor: live?.sponsorVisible === true,
    socials: live?.socialsOverlay === true,
    ticker: live?.tickerVisible === true,
  }

  const libItem = (c: LayoutPart | "ticker") => (
    <li key={c}>
      <button type="button" data-testid={`vb-lib-${c}`} onClick={() => setSel({ kind: "part", part: c })} className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[13px] ${sel.kind === "part" && sel.part === c ? "bg-white/10 ring-1 ring-[#D9FF43]" : "hover:bg-white/5"}`}>
        <span className={`size-2 rounded-full ${on[c] ? "bg-[#FF3B3B] shadow-[0_0_8px_#FF3B3B]" : "bg-white/20"}`} />
        <span className="flex-1">{COMPONENT_LABEL[c]}</span>
        {on[c] ? <span className="font-mono text-[9px] text-[#FF3B3B]">ON AIR</span> : null}
      </button>
    </li>
  )
  const setLogo = (id: LogoId, p: Partial<LogoConfig>) => setDraft({ ...draft, logos: { ...draft.logos, [id]: { ...draft.logos[id], ...p } } })
  const setQr = (p: Partial<QrConfig>) => setDraft({ ...draft, qr: { ...draft.qr, ...p } })
  const setScene = (id: SceneId, p: Partial<SceneCard>) => setDraft({ ...draft, scenes: { ...draft.scenes, [id]: { ...draft.scenes[id], ...p } } })
  async function upload(file: File, kind: "logo" | "card" | "video", tag: string): Promise<string | null> {
    const limit = kind === "video" ? 100_000_000 : 5_000_000
    if (file.size > limit) { const text = kind === "video" ? "Video is over 100 MB." : "File is over 5 MB."; uploader.fail(tag, file.name, text); setNote({ tone: "error", text }); return null }
    const q = kind === "logo" ? "?kind=logo" : kind === "video" ? "?kind=video" : ""
    const res = await uploader.start(`/api/upload${q}`, file, tag)
    const url = res && res.status < 300 && typeof res.body?.url === "string" ? res.body.url : null
    return url
  }

  return (
    <main data-testid="visuals-builder" className="flex h-dvh flex-col bg-[#0a0a0a] text-white max-xl:h-auto max-xl:min-h-dvh max-xl:overflow-y-auto" style={{ fontFamily: "var(--font-instrument-sans), 'Instrument Sans', Arial, sans-serif", paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      <header className="flex flex-wrap items-center gap-3 border-b border-[#2a2a2a] px-4 py-3 sm:px-6">
        <div className="w-[240px] shrink-0">
          <p className="font-mono text-[12px] tracking-[0.16em] text-white/40 uppercase">Hyphen Festival 2026</p>
          <h1 className="font-sans text-xl font-black tracking-tight uppercase">Visuals builder</h1>
        </div>
        <AppNav page="builder" />
        <div className="ml-6 flex gap-1" role="group" aria-label="Screen">
          {(["countdown", "program"] as const).map((s) => <button key={s} type="button" data-testid={`vb-screen-${s}`} aria-pressed={!liveView && screen === s} onClick={() => { setScreen(s); setLiveView(false) }} className={chip(!liveView && screen === s)}>{s === "countdown" ? "Countdown" : "Program"}</button>)}
          <button type="button" data-testid="vb-screen-live" aria-pressed={liveView} title="The real /stream page, muted: what goes on air" onClick={() => setLiveView(true)} className={chip(liveView)}>Live</button>
        </div>
        <button type="button" data-testid="vb-guides" aria-pressed={guides} onClick={() => setGuides(!guides)} className={chip(guides)}>Safe-area guides</button>
        <button type="button" data-testid="vb-showall" aria-pressed={showAll} onClick={() => setShowAll(!showAll)} className={chip(showAll)}>Show all overlays (preview)</button>
        <div className="ml-auto flex items-center gap-2">
          {note ? <span data-testid="vb-note" className={`font-mono text-[11px] ${note.tone === "ok" ? "text-[#D9FF43]" : "text-[#FF3B3B]"}`}>{note.text}</span> : null}
          {dirty ? <span className="font-mono text-[11px] text-[#FF6A00]">Unsaved changes</span> : null}
          <button type="button" data-testid="vb-revert" disabled={!dirty || saving} onClick={() => setDraft(draftFrom(savedStage))} className={btn}>Revert</button>
          <button type="button" data-testid="vb-save" disabled={!dirty || saving} onClick={() => void save()} className="rounded-full bg-[#D9FF43] px-4 py-1.5 font-mono text-[12px] font-bold text-[#0a0a0a] disabled:opacity-35">{saving ? "Saving…" : "Save"}</button>
          <LinkPill link={link} testId="vb-link-state" />

        </div>
      </header>

      <div className={`grid min-h-0 flex-1 gap-4 p-4 max-xl:flex-none ${liveView ? "grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]" : "grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)_320px]"}`}>
        {/* Library */}
        <aside data-testid="vb-library" className={`${panel} flex min-h-0 max-h-[40dvh] flex-col overflow-auto p-3 xl:max-h-none`}>
          <LibGroup title="Straps">{libItem("strap")}</LibGroup>
          <div className="mb-2 flex items-center">
            <p className={`${mono} mr-auto`}>Speakers ({straps.length}/{STRAP_MAX})</p>
            <button type="button" data-testid="vb-strap-add" disabled={straps.length >= STRAP_MAX} className={btn} onClick={() => { const next = addStrap(straps); setStraps(next); setSel({ kind: "strap", id: next[next.length - 1].id }) }}>+ Add</button>
          </div>
          <ul className="m-0 grid list-none gap-1 p-0">
            {straps.map((s) => (
              <li key={s.id}>
                <button type="button" data-testid={`vb-strap-${s.id}`} onClick={() => setSel({ kind: "strap", id: s.id })} className={`w-full rounded-[10px] px-2.5 py-2 text-left ${sel.kind === "strap" && sel.id === s.id ? "bg-white/10 ring-1 ring-[#D9FF43]" : "hover:bg-white/5"}`}>
                  <span className="block text-[13px] font-semibold break-words">{s.name || "(no name)"}{live?.strapId === s.id ? <span className="ml-2 font-mono text-[9px] text-[#D9FF43]">CUED</span> : null}</span>
                  <span className="block font-mono text-[10px] text-white/50 break-words">{s.title || "—"} · {STRAP_STYLE_LABEL[s.style].split(" ")[0]}</span>
                </button>
              </li>
            ))}
          </ul>
          <LibGroup title="Logos">{LOGO_IDS.map((id) => libItem(id))}</LibGroup>
          <LibGroup title="QR">{libItem("qr")}{libItem("qrLogo")}</LibGroup>
          <LibGroup title="Scenes">
            {SCENE_IDS.map((id) => (
              <li key={id}>
                <button type="button" data-testid={`vb-lib-scene-${id}`} onClick={() => setSel({ kind: "scene", id })} className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[13px] ${sel.kind === "scene" && sel.id === id ? "bg-white/10 ring-1 ring-[#D9FF43]" : "hover:bg-white/5"}`}>
                  <span className="size-2 rounded-full" style={{ background: draft.scenes[id].dot }} />
                  <span className="flex-1">{SCENE_LABEL[id]}</span>
                  {state?.overlay === id ? <span className="font-mono text-[9px] text-[#FF3B3B]">ON AIR</span> : null}
                </button>
              </li>
            ))}
            <li className="px-2.5 py-1 font-mono text-[10px] text-white/40">Break · Hold · Welcome · End: desk › Cards</li>
          </LibGroup>
          <LibGroup title="Pills">{libItem("talk")}{libItem("qa")}{libItem("sponsor")}</LibGroup>
          <LibGroup title="Ticker">{libItem("ticker")}</LibGroup>
          <LibGroup title="Socials">{libItem("socials")}</LibGroup>
        </aside>

        {/* Preview */}
        <section className="flex min-h-0 flex-col gap-2">
          {liveView ? <LiveMonitor state={state} /> : (<>
          <div className="flex min-h-0 flex-1 items-center justify-center max-xl:h-[52dvh] max-xl:flex-none" style={{ containerType: "size" }}>
          <div data-testid="vb-preview" data-screen={screen} className="relative aspect-video overflow-hidden rounded-[14px] border border-[#2a2a2a] bg-[#1a1a1a] [&_.visuals-layer]:pointer-events-none" style={{ width: "min(100cqw, calc(100cqh * 16 / 9))", height: "min(100cqh, calc(100cqw * 9 / 16))" }}>
            {screen === "countdown" ? (
              <CountdownStage event={event} checker={stage.checker} showMeta={stage.showMeta} showLink={stage.showLink} lineSpacing={stage.lineSpacing} blockGap={stage.blockGap}
                clockScale={stage.clockScale} clockText={stage.clockText} logoUrl={stage.logoUrl} speakers={stage.speakers} gallerySeconds={stage.gallerySeconds} galleryPause={stage.galleryPause}
                galleryOffset={stage.galleryOffset} galleryScale={stage.galleryScale} social={socialLook(stage)} countdownStrokePx={stage.countdownStrokePx} countdownStrokeColor={stage.countdownStrokeColor}
                slateLook={stage.slateLook} bg={stage.countdownBg} hide={cdHide} className="absolute inset-0 h-full w-full" />
            ) : programBg === "live" ? (
              // Real /stream (same as Live tab top): true overlay timing. Muted.
              <ShownFrame testId="vb-program-stream" title="/stream (program background)" src="/stream?mute=1" className="pointer-events-none absolute inset-0 h-full w-full border-0" />
            ) : programBg === "relay" && feed.path ? (
              // Relay player behind the overlays: follows Main/Backup, delayed reference, muted by default.
              <div data-testid="vb-program-live" data-source={feed.source} className="absolute inset-0 bg-black"><StreamPlayer key={feed.path} src={`/api/relay/hls/${feed.path}/index.m3u8`} scope="builder-program" /></div>
            ) : (
              <div data-testid="vb-program-placeholder" className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_40%,#3a3a44,#141414_70%)]">
                <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 font-mono text-[11px] tracking-[0.3em] text-white/25 uppercase">Program feed</span>
                {programBg === "relay" && !feed.signal ? <span data-testid="vb-program-nosignal" className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 font-mono text-[10px] tracking-[0.15em] text-[#FF6A00] uppercase">No program signal</span> : null}
              </div>
            )}
            {programBg !== "live" || screen === "countdown" ? <VisualsLayer stage={stage} event={event} screen={screen} now={now} eventEndMs={eventEndMs} /> : null}
            {sel.kind === "scene" ? <SceneCardView id={sel.id} card={draft.scenes[sel.id]} qr={draft.qr} now={now} className="absolute inset-0 z-40 h-full" /> : null}
            {guides ? (
              <div aria-hidden data-testid="vb-guides-layer" className="pointer-events-none absolute inset-0 z-50">
                <div className="absolute border border-dashed border-[#C6FF00]/80" style={{ inset: "5%" }} />
                <div className="absolute border border-dashed border-[#FF6A00]/60" style={{ inset: `${(EDGE_PX / 1080) * 100}% ${(EDGE_PX / 1920) * 100}%` }} />
                <span className="absolute top-[5.4%] left-[5.4%] font-mono text-[10px] text-[#C6FF00]/80">SAFE 5%</span>
              </div>
            ) : null}
          </div>
          </div>
          {screen === "countdown" ? (
            <div data-testid="vb-cd-hide" className="flex flex-wrap items-center gap-1">
              <span className={`${mono} mr-1`}>Hide on countdown (preview only)</span>
              {COUNTDOWN_PARTS.map((part) => <button key={part} type="button" data-testid={`vb-cd-hide-${part}`} aria-pressed={Boolean(cdHide[part])} onClick={() => setCdHide({ ...cdHide, [part]: !cdHide[part] })} className={chip(Boolean(cdHide[part]))}>{COUNTDOWN_PART_LABEL[part]}</button>)}
              <button type="button" data-testid="vb-cd-hide-reset" onClick={() => setCdHide({})} className={btn}>Show page</button>
            </div>
          ) : (
            <div data-testid="vb-program-feed" className="flex flex-wrap items-center gap-1">
              <span className={`${mono} mr-1`}>Program background</span>
              <button type="button" data-testid="vb-feed-relay" aria-pressed={programBg === "relay"} onClick={() => setProgramBg("relay")} className={chip(programBg === "relay")}>Program background</button>
              <button type="button" data-testid="vb-feed-live" aria-pressed={programBg === "live"} onClick={() => setProgramBg("live")} className={chip(programBg === "live")}>Live feed</button>
              <button type="button" data-testid="vb-feed-placeholder" aria-pressed={programBg === "placeholder"} onClick={() => setProgramBg("placeholder")} className={chip(programBg === "placeholder")}>Placeholder</button>
              <span className="font-mono text-[10px] text-white/45">{programBg === "live" ? "Real /stream, muted. True overlay timing (a little behind, like the Live tab)." : programBg === "relay" ? "Relay player, follows Main/Backup. Delayed reference only." : "Static. Good for placing without a feed."}</span>
            </div>
          )}
          <p className="font-mono text-[11px] text-white/45">1920×1080 scaled · {screen === "countdown" ? "Countdown screen" : "Program"} · {showAll ? "every part forced on in the preview only" : "showing what is on air now"} · <span className="text-[#C6FF00]">lime = safe 5%</span> · <span className="text-[#FF6A00]">orange = edge {EDGE_PX}px</span></p>
          </>)}
        </section>

        {/* Inspector — hidden on Live (multiview needs the space); fully present on Countdown / Program */}
        {!liveView ? (
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
                <Label>{STRAP_STYLE_LABEL[s.style]} design (shared by every preset in this style)</Label>
                {designValues(s.style)}
                <div data-testid="vb-strap-mini" className="overflow-hidden rounded-[10px] bg-[repeating-conic-gradient(#222_0_25%,#2a2a2a_0_50%)] bg-[length:16px_16px] p-3" style={{ "--px": "0.34px" } as CSSProperties}>
                  <NameStrap key={`${s.id}-${s.style}`} preset={s} visible look={{ style: s.style, motion: savedStage.strapMotion, accent: draft.strapAccent, text: draft.strapText, design: draft.strapDesigns[s.style] }} />
                </div>
                <p className="font-mono text-[10px] text-white/45">Live preview of this preset (the big preview shows it too). Applies on Save. A preset needs a name or a title.</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" data-testid="vb-strap-dup" disabled={straps.length >= STRAP_MAX} className={btn} onClick={() => setStraps(duplicateStrap(straps, s.id))}>Duplicate</button>
                  <button type="button" data-testid="vb-strap-delete" className={`${btn} border-[#FF3B3B]/60 text-[#FF3B3B]`} onClick={() => { setStraps(deleteStrap(straps, s.id)); setSel({ kind: "part", part: "strap" }) }}>Delete</button>
                  {(() => {
                    const cs = cueState(live, s.id)
                    const unsaved = !savedStage.straps.some((x) => x.id === s.id)
                    const busy = cueing === s.id
                    const flash = cuedFlash === s.id
                    const look = cs === "live" ? "border-[#FF6A00]! bg-[#FF6A00] text-black!" : cs === "cued" ? "border-[#D9FF43]! bg-[#D9FF43] text-black!" : ""
                    const label = busy ? "Cueing…" : cs === "live" ? "● On air now" : flash ? "Cued ✓" : cs === "cued" ? "✓ Cued on deck" : <>Cue on deck <span className="text-[#FF6A00]">· live</span></>
                    return (
                      <button type="button" data-testid="vb-strap-cue" data-cue={cs} aria-pressed={cs !== "idle"} aria-live="polite" disabled={busy || cs !== "idle" || dirty || unsaved}
                        title={cs === "live" ? "This preset is on air. Take it off from the deck." : cs === "cued" ? "Already cued on the deck. Put it on air from the deck." : dirty ? "Save first" : unsaved ? "Save this preset first" : "Cue this preset on the deck (live)"}
                        className={`${btn} transition-[transform,background-color,color] duration-150 active:scale-95 ${look} ${cs !== "idle" ? "disabled:opacity-100" : ""} ${busy ? "animate-pulse" : ""}`} onClick={() => void cue(s.id)}>{label}</button>
                    )
                  })()}
                </div>
                {cueState(live, s.id) === "idle" && (dirty || !savedStage.straps.some((x) => x.id === s.id)) ? <p data-testid="vb-strap-cue-hint" className="font-mono text-[10px] text-white/45">Save to cue this preset on the deck.</p> : null}
              </div>
            )
          })() : sel.kind === "scene" ? (() => {
            const id = sel.id
            const c = draft.scenes[id]
            return (
              <div className="grid gap-3">
                <h2 className="text-[15px] font-semibold">Scene card · {SCENE_LABEL[id]}</h2>
                <label className="grid gap-1"><Label>Label</Label><input data-testid="vb-scene-label" className={field} maxLength={120} value={c.label} onChange={(e) => setScene(id, { label: e.target.value })} /></label>
                <label className="grid gap-1"><Label>Subline</Label><input data-testid="vb-scene-sub" className={field} maxLength={120} value={c.sub} onChange={(e) => setScene(id, { sub: e.target.value })} /></label>
                <label className="grid gap-1"><Label>Pill text</Label><input data-testid="vb-scene-pill" className={field} maxLength={120} value={c.pill} onChange={(e) => setScene(id, { pill: e.target.value })} /></label>
                <TextSize label="Pill text size" testId="vb-scene-pill-size" value={c.pillSize} onChange={(n) => setScene(id, { pillSize: n })} />
                <div className="grid gap-1"><Label>Pill placement</Label><div className="flex gap-1">{SCENE_PILL_PLACES.map((p) => <button key={p} type="button" data-testid={`vb-scene-pill-place-${p}`} aria-pressed={c.pillPlace === p} className={chip(c.pillPlace === p)} onClick={() => setScene(id, { pillPlace: p })}>{p === "top" ? "Top" : "Bottom"}</button>)}</div></div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1"><Label>Dot colour</Label><input type="color" data-testid="vb-scene-dot" className="h-9 w-full" value={c.dot} onChange={(e) => setScene(id, { dot: e.target.value })} /></label>
                  <label className="grid gap-1"><Label>Background</Label><input type="color" data-testid="vb-scene-bg" className="h-9 w-full" value={c.bg} onChange={(e) => setScene(id, { bg: e.target.value })} /></label>
                </div>
                <div className="grid gap-1"><Label>Background mode</Label>
                  <div className="flex gap-1">{SCENE_BG_MODES.map((m) => <button key={m} type="button" data-testid={`vb-scene-mode-${m}`} aria-pressed={c.bgMode === m} className={chip(c.bgMode === m)} onClick={() => setScene(id, { bgMode: m })}>{m === "solid" ? "Solid" : m === "image" ? "Image" : "Hero"}</button>)}</div>
                </div>
                <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={c.gradient} onChange={(e) => setScene(id, { gradient: e.target.checked })} className="accent-[#D9FF43]" /> Showreel gradient (solid mode)</label>
                {c.bgMode !== "solid" ? (
                  <div className="grid gap-1"><Label>{c.bgMode === "hero" ? "Hero image (above the title)" : "Background image"}</Label>
                    <FilePicker testId="vb-scene-image" label="Choose image" accept="image/png,image/jpeg,image/webp" busy={uploader.busy} onFile={(f) => void upload(f, "card", `vb-scene-image-${id}`).then((url) => url && setScene(id, { image: url }))} />
                  <UploadProgress state={uploader.state} tag={`vb-scene-image-${id}`} />
                    {c.image ? <span className="font-mono text-[10px] text-white/50">{c.image} <button type="button" className="underline" onClick={() => setScene(id, { image: "" })}>remove</button></span> : null}
                  </div>
                ) : null}
                {c.bgMode === "image" ? <Slider label="Dim" testId="vb-scene-dim" unit="%" value={c.dim} range={{ min: 0, max: 90 }} onChange={(n) => setScene(id, { dim: n })} /> : null}
                <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={c.showQr} onChange={(e) => setScene(id, { showQr: e.target.checked })} className="accent-[#D9FF43]" /> Animated QR bottom-right (QR link)</label>
                                <div className="grid gap-2 rounded-[10px] border border-[#2a2a2a] p-2">
                  <Label>Showreel video (local MP4, with audio)</Label>
                  <FilePicker testId="vb-scene-video" label="Choose video (mp4)" accept="video/mp4" busy={uploader.busy} onFile={(f) => void upload(f, "video", `vb-scene-video-${id}`).then((url) => url && setScene(id, { video: url }))} />
                  <UploadProgress state={uploader.state} tag={`vb-scene-video-${id}`} />
                  {c.video ? <span className="truncate font-mono text-[10px] text-white/50">{c.video}</span> : <span className="font-mono text-[10px] text-white/40">No video</span>}
                  {c.video ? <button type="button" className={btn} onClick={() => setScene(id, { video: "" })}>Remove video</button> : null}
                  <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" data-testid="vb-scene-videofront" checked={c.videoFront} onChange={(e) => setScene(id, { videoFront: e.target.checked })} className="accent-[#D9FF43]" /> Video in front (above card text and QR)</label>
                  <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" data-testid="vb-scene-overlay" checked={c.overlayOn} disabled={c.videoFront} onChange={(e) => setScene(id, { overlayOn: e.target.checked })} className="accent-[#D9FF43]" /> Overlay on video{c.videoFront ? " (only when the video is behind)" : ""}</label>
                  {c.overlayOn && !c.videoFront ? (
                    <div className="grid grid-cols-2 items-end gap-2">
                      <label className="grid gap-1"><Label>Overlay colour</Label><input type="color" data-testid="vb-scene-overlay-color" className="h-9 w-full" value={c.overlayColor} onChange={(e) => setScene(id, { overlayColor: e.target.value })} /></label>
                      <Slider label="Overlay opacity" testId="vb-scene-overlay-opacity" unit="%" value={c.overlayOpacity} range={{ min: 0, max: 100 }} onChange={(n) => setScene(id, { overlayOpacity: n })} />
                    </div>
                  ) : null}
                  <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" data-testid="vb-scene-pausebed" checked={c.pauseBed} onChange={(e) => setScene(id, { pauseBed: e.target.checked })} className="accent-[#D9FF43]" /> Pause audio bed while the video plays</label>
                  <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" data-testid="vb-scene-loop" checked={c.loop} onChange={(e) => setScene(id, { loop: e.target.checked })} className="accent-[#D9FF43]" /> Loop video</label>
                  <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" data-testid="vb-scene-autoswitch" checked={c.autoSwitch} onChange={(e) => setScene(id, { autoSwitch: e.target.checked })} className="accent-[#D9FF43]" /> Play once, then switch</label>
                  {c.autoSwitch ? (
                    <label className="grid gap-1"><Label>Then go to</Label>
                      <select data-testid="vb-scene-next" className={field} value={c.next} onChange={(e) => setScene(id, { next: e.target.value as SceneCard["next"] })}>
                        <option value="">Program</option>
                        {SCENE_IDS.filter((s) => s !== id).map((s) => <option key={s} value={s}>{SCENE_LABEL[s]}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <p className="font-mono text-[10px] text-white/45">Plays on the scene card with sound. In OBS, enable “Control audio via OBS” on the Browser Source. Auto-switch only fires on the real /stream output.</p>
                </div>
                <p className="font-mono text-[10px] text-white/45">Applies on Save. Put it on air from the deck › Scenes (two taps while program is live).</p>
              </div>
            )
          })() : sel.part === "ticker" ? (
            <div className="grid gap-3">
              <h2 className="text-[15px] font-semibold">Ticker bar</h2>
              <div className="grid gap-1"><Label live>Type</Label>
                <div className="flex gap-1">{TICKER_TYPES.map((t) => <button key={t} type="button" data-testid={`vb-ticker-${t}`} className={chip(stage.tickerType === t)} onClick={() => void visual({ target: "ticker", tickerType: t as TickerType })}>{t}</button>)}</div>
              </div>
              <LiveText key={stage.tickerType} label={`${stage.tickerType === "social" ? "Social" : "Planner"} items (one per line)`} testId="vb-ticker-items" multiline value={(stage.tickerType === "social" ? live?.tickerSocialItems : live?.tickerPlannerItems) ?.join("\n") ?? ""} onApply={(v) => void visual({ target: "ticker", items: sanitizeTickerItems(v), list: stage.tickerType })} />
              <TextSize testId="vb-ticker-size" value={draft.textScale.ticker} onChange={(n) => setTextScale("ticker", n)} />
              <p className="font-mono text-[10px] text-white/45">Text size applies on Save; the bar grows with it. The bar runs full width at the bottom; bottom parts lift above it while it shows. Show/Hide is on the deck.</p>
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
                {part === "strap" ? (() => {
                  const style = designEdit ?? (live?.strapStyle || straps.find((x) => x.id === stage.strapId)?.style || "house")
                  return (
                    <div data-testid="vb-strap-design" className="grid gap-3">
                      <label className="grid gap-1"><Label>Design</Label>
                        <select data-testid="vb-design" className={field} value={style} onChange={(e) => setDesignEdit(e.target.value as StrapStyle)}>{STRAP_STYLES.map((m) => <option key={m} value={m}>{STRAP_STYLE_LABEL[m]}</option>)}</select></label>
                      {designValues(style)}
                      <p className="font-mono text-[10px] text-white/45">The preview shows the design you pick here. Sizes and accents apply on Save, to every preset in this design. Which design goes on air is the Style override below (live) or each preset{"'"}s own style.</p>
                      <hr className="border-[#2a2a2a]" />
                    </div>
                  )
                })() : null}
                {part === "socials" && screen === "countdown" ? <p className="font-mono text-[10px] text-[#FF6A00]">The countdown screen has its own social icons, so the overlay circles only draw on program and OBS.</p> : null}
                <div className="grid gap-1">
                  <Label live={deckCorner}>Corner{deckCorner ? " (deck buttons)" : ""}</Label>
                  <div className="grid grid-cols-2 gap-1">
                    {CORNERS.map((c) => {
                      const active = deckCorner ? liveCorner === c : p.corner === c
                      return <button key={c} type="button" data-testid={`vb-corner-${c}`} aria-pressed={active} className={chip(active)}
                        onClick={() => (deckCorner ? void act(part === "strap" ? { type: "strap", corner: c } : { type: "socials", corner: c }) : set({ corner: c, ...(c !== p.corner ? { dx: 0, dy: 0 } : {}) }))}>{CORNER_LABEL[c]}</button>
                    })}
                  </div>
                  {part === "strap" ? (
                    <button type="button" data-testid="vb-center" aria-pressed={Boolean(p.center)} className={`${chip(Boolean(p.center))} justify-self-start`} onClick={() => set({ center: !p.center, ...(!p.center ? { dx: 0 } : {}) })}>Centre (top or bottom)</button>
                  ) : null}
                </div>
                <div className="grid gap-1"><Label>Snap to</Label>
                  <div className="flex gap-1">{(["safe", "edge"] as const).map((s) => <button key={s} type="button" data-testid={`vb-snap-${s}`} aria-pressed={p.snap === s} className={chip(p.snap === s)} onClick={() => set({ snap: s })}>{s === "safe" ? "Safe 5%" : `Edge ${EDGE_PX}px`}</button>)}</div>
                </div>
                <Slider label="X gap" testId="vb-dx" value={p.dx} range={GAP_X_RANGE} onChange={(n) => set({ dx: n })} />
                <Slider label="Y gap" testId="vb-dy" value={p.dy} range={GAP_Y_RANGE} onChange={(n) => set({ dy: n })} />
                <Slider label="Size" testId="vb-size" unit="%" value={p.size} range={SIZE_RANGE} onChange={(n) => set({ size: n })} />
                <p className="font-mono text-[10px] text-white/45">Gaps run from the chosen corner across the full 1920x1080 frame; picking a new corner resets them to 0. Layout applies on Save, for the {screen} screen only.</p>
                <hr className="border-[#2a2a2a]" />
                {part === "strap" ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="grid gap-1"><Label>Accent (default)</Label><input type="color" data-testid="vb-accent" className="h-9 w-full" value={draft.strapAccent} onChange={(e) => setDraft({ ...draft, strapAccent: e.target.value })} /></label>
                      <label className="grid gap-1"><Label>Text (default)</Label><input type="color" data-testid="vb-text" className="h-9 w-full" value={draft.strapText} onChange={(e) => setDraft({ ...draft, strapText: e.target.value })} /></label>
                    </div>
                    <label className="grid gap-1"><Label live>Motion</Label>
                      <select data-testid="vb-motion" className={field} value={live?.strapMotion ?? "slide-left"} onChange={(e) => void act({ type: "strap", motion: e.target.value as StrapMotion })}>{STRAP_MOTIONS.map((m) => <option key={m} value={m}>{STRAP_MOTION_LABEL[m]}</option>)}</select></label>
                    <label className="grid gap-1"><Label live>Style override</Label>
                      <select data-testid="vb-style-override" className={field} value={live?.strapStyle ?? ""} onChange={(e) => void act({ type: "strap", style: e.target.value as StrapStyle | "" })}>
                        <option value="">Each preset{"'"}s own style</option>
                        {STRAP_STYLES.map((m) => <option key={m} value={m}>{STRAP_STYLE_LABEL[m]}</option>)}
                      </select></label>
                  </>
                ) : null}
                {(LOGO_IDS as readonly string[]).includes(part) ? (() => {
                  const id = part as LogoId
                  const lg = draft.logos[id]
                  return (
                    <>
                      <div className="grid gap-1"><Label>Source</Label>
                        <div className="flex gap-1">{LOGO_SOURCES.map((src: LogoSource) => <button key={src} type="button" data-testid={`vb-logo-src-${src}`} aria-pressed={lg.source === src} className={chip(lg.source === src)} onClick={() => setLogo(id, { source: src })}>{src === "default" ? "Built-in" : src === "image" ? "Upload" : "Paste SVG"}</button>)}</div>
                      </div>
                      {lg.source === "default" ? <label className="grid gap-1"><Label>Colour (brand orange)</Label><input type="color" data-testid="vb-logo-color" className="h-9 w-full" value={lg.color} onChange={(e) => setLogo(id, { color: e.target.value })} /></label> : null}
                      {lg.source === "image" ? (
                        <div className="grid gap-1"><Label>PNG, JPG or SVG (max 5 MB; SVG 100 KB, cleaned)</Label>
                          <FilePicker testId="vb-logo-upload" label="Choose image" accept="image/png,image/jpeg,image/svg+xml" busy={uploader.busy} onFile={(f) => void upload(f, "logo", `vb-logo-upload-${id}`).then((url) => url && setLogo(id, { image: url }))} />
                  <UploadProgress state={uploader.state} tag={`vb-logo-upload-${id}`} />
                          {lg.image ? <span className="font-mono text-[10px] text-white/50">{lg.image}</span> : <span className="font-mono text-[10px] text-[#FF6A00]">No image yet</span>}
                        </div>
                      ) : null}
                      {lg.source === "svg" ? (
                        <label className="grid gap-1"><Label>Paste SVG code</Label>
                          <textarea data-testid="vb-logo-svg" rows={5} defaultValue={lg.svg} className={`${field} h-auto py-2 font-mono text-[11px]`} onBlur={(e) => { const clean = sanitizeSvg(e.target.value); setLogo(id, { svg: clean }); if (e.target.value.trim() && !clean) setNote({ tone: "error", text: "That SVG can't be used (not an SVG, or unsafe)." }) }} />
                          <span className="font-mono text-[10px] text-white/45">Scripts, foreignObject, event handlers and external links are removed. Shown as an image.</span>
                        </label>
                      ) : null}
                      <label className="grid gap-1"><Label>Caption text (optional)</Label><input data-testid="vb-logo-text" className={field} maxLength={120} value={lg.text} onChange={(e) => setLogo(id, { text: e.target.value })} /></label>
                      <p className="font-mono text-[10px] text-white/45">Show/Hide on the deck › Logos.</p>
                    </>
                  )
                })() : null}
                {part === "qr" || part === "qrLogo" ? (
                  <>
                    <label className="grid gap-1"><Label>QR link (shared by both QR codes)</Label><input data-testid="vb-qr-url" className={field} maxLength={500} value={draft.qr.url} onChange={(e) => setQr({ url: e.target.value })} /></label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="grid gap-1"><Label>Code colour</Label><input type="color" data-testid="vb-qr-color" className="h-9 w-full" value={draft.qr.color} onChange={(e) => setQr({ color: e.target.value })} /></label>
                      {part === "qr"
                        ? <label className="grid gap-1"><Label>Step accent</Label><input type="color" data-testid="vb-qr-accent" className="h-9 w-full" value={draft.qr.accent} onChange={(e) => setQr({ accent: e.target.value })} /></label>
                        : <label className="grid gap-1"><Label>Badge colour</Label><input type="color" data-testid="vb-qr-badge-color" className="h-9 w-full" value={draft.qr.badgeColor} onChange={(e) => setQr({ badgeColor: e.target.value })} /></label>}
                    </div>
                    {part === "qr" ? (
                      <>
                        <label className="grid gap-1"><Label>Caption</Label><input data-testid="vb-qr-caption" className={field} maxLength={120} value={draft.qr.caption} onChange={(e) => setQr({ caption: e.target.value })} /></label>
                        <label className="grid gap-1"><Label>Caption line 2</Label><input className={field} maxLength={120} value={draft.qr.caption2} onChange={(e) => setQr({ caption2: e.target.value })} /></label>
                      </>
                    ) : <label className="grid gap-1"><Label>Badge text (max 4)</Label><input data-testid="vb-qr-badge" className={field} maxLength={4} value={draft.qr.badgeText} onChange={(e) => setQr({ badgeText: e.target.value })} /></label>}
                    <p className="font-mono text-[10px] text-white/45">{part === "qr" ? "A real code (ECC M); the orange cell steps round the quiet zone, never over the code." : "ECC H, so the centre badge still scans. Keep it dark on white."} Show/Hide on the deck › QR.</p>
                  </>
                ) : null}
                {part === "talk" ? (
                  <>
                    <LiveText label="Talk prefix (Session)" testId="vb-talk-prefix" value={live?.talkPrefix ?? stage.talkPrefix} onApply={(v) => void visual({ target: "talk", talkPrefix: v })} />
                    <LiveText label="Festival prefix" testId="vb-festival-prefix" value={live?.festivalPrefix ?? stage.festivalPrefix} onApply={(v) => void visual({ target: "talk", festivalPrefix: v })} />
                    <TextSize label="Talk ends text size" testId="vb-talk-size" value={draft.textScale.talk} onChange={(n) => setTextScale("talk", n)} />
                    <TextSize label="Festival ends text size" testId="vb-festival-size" value={draft.textScale.festival} onChange={(n) => setTextScale("festival", n)} />
                    <p className="font-mono text-[10px] text-white/45">Text sizes apply on Save; the pill grows with the text. Mode now: {live?.talkMode ?? "session"}. Start, ±1 min and Talk/Festival are on the deck.</p>
                  </>
                ) : null}
                {part === "qa" ? <><LiveText label="Q&A text" testId="vb-qa-text" value={live?.qaText ?? stage.qaText} onApply={(v) => void visual({ target: "qa", text: v })} /><TextSize testId="vb-qa-size" value={draft.textScale.qa} onChange={(n) => setTextScale("qa", n)} /></> : null}
                {part === "sponsor" ? <><LiveText label="Sponsored text" testId="vb-sponsor-text" value={live?.sponsorText ?? stage.sponsorText} onApply={(v) => void visual({ target: "sponsor", text: v })} /><TextSize testId="vb-sponsor-size" value={draft.textScale.sponsor} onChange={(n) => setTextScale("sponsor", n)} /></> : null}
              </div>
            )
          })()}
        </aside>
        ) : null}
      </div>
    </main>
  )
}

/**
 * Live monitor: the real /stream page (?mute=1, the existing mute param: program and bed audio off),
 * 1920x1080 scaled to fit, like OBS's program monitor. Only mounted while the Live tab is selected.
 * An operator session may view /stream without the OBS view key (same as the phone deck's preview).
 * Below it: a light Main | Backup multiview (ProgramPlayer, muted = WebRTC). Does not affect /stream.
 */
function LiveMonitor({ state }: { state: { programSource?: "main" | "backup"; programReady?: boolean | null; programSources?: { main?: { ready?: boolean }; backup?: { ready?: boolean } } | null; rearmHoldMs?: number } | null }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.4)
  const [gen, setGen] = useState(0)
  const [touch] = useState(() => typeof window !== "undefined" && muteOnlyAudio({ ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false, deck: false }))
  const [showMv, setShowMv] = useState(!touch)
  const liveShown = useShown(box) // hidden tab / scrolled away: unmount the /stream iframe (stops its players)
  const loadGate = useLoadAlert() // Mac overloaded: live frame and multiview hidden (manual "show anyway")
  useEffect(() => {
    const node = box.current
    if (!node) return
    // Fit the 1920x1080 frame to the box, not the width alone: a wide window
    // shrinks this box above the multiview, and a width-only scale paints over it.
    const fit = () => setScale(Math.min(node.clientWidth / 1920, node.clientHeight / 1080))
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    fit()
    return () => observer.disconnect()
  }, [])
  const onAir = state?.programSource === "backup" ? "backup" : "main"
  const mainReady = state?.programSources?.main?.ready ?? state?.programReady === true
  const backupReady = state?.programSources?.backup?.ready ?? false
  const rearm = state?.rearmHoldMs ?? 0
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div ref={box} data-testid="vb-live" className="relative min-h-0 flex-1 overflow-hidden rounded-[14px] border border-[#2a2a2a] bg-black max-xl:min-h-[46dvh]">
        {loadGate.paused ? <LoadPaused reason={loadGate.alert?.reason ?? ""} onShow={loadGate.showAnyway} className="absolute inset-0" /> : liveShown ? <iframe key={gen} data-testid="vb-live-frame" data-gen={gen} title="/stream (on air)" src="/stream?mute=1&diag=1" className="pointer-events-none absolute top-1/2 left-1/2 origin-center border-0" style={{ width: 1920, height: 1080, transform: `translate(-50%, -50%) scale(${scale})` }} /> : null}
        <span data-testid="vb-live-onair" className="absolute top-2 left-2 z-10 flex items-center gap-1.5 rounded-full bg-[#d93200] px-2.5 py-1 font-mono text-[10px] font-bold tracking-[0.15em] text-white uppercase"><span className="size-1.5 rounded-full bg-white" />On air</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-testid="vb-live-reload" onClick={() => setGen((g) => g + 1)} className="rounded-full border border-white/20 px-3 py-1 font-mono text-[11px] text-white hover:bg-white/10">Reload</button>
        <span className="font-mono text-[10px] text-white/45">/stream?mute=1&diag=1 · muted · what goes on air. Player lines land in the dropout log as [desk] or [phone].</span>
      </div>

      {/* Main | Backup multiview — hidden on touch until tapped (two extra decodes). Desktop shows it. */}
      {showMv && !loadGate.paused ? (
      <div data-testid="vb-multiview" className="grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {([
          { id: "main", label: "Main", path: "program", ready: mainReady },
          { id: "backup", label: "Backup", path: "program-backup", ready: backupReady },
        ] as const).map((s) => (
          <div key={s.id} data-testid={`vb-mv-${s.id}`} className="relative aspect-video overflow-hidden rounded-[14px] border border-[#2a2a2a] bg-black">
            <ProgramPlayer scope={`builder-mv-${s.id}`} src={programOperatorSrc(s.path)} ready={s.ready} rearmHoldMs={rearm} />
            <span className={`pointer-events-none absolute top-1.5 left-1.5 z-20 flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[9px] font-bold tracking-[0.12em] uppercase ${onAir === s.id ? "bg-[#d93200] text-white" : "bg-black/70 text-white/80"}`}>
              {onAir === s.id ? <span className="size-1.5 rounded-full bg-white" /> : null}
              {s.label}{onAir === s.id ? " · On air" : ""}
            </span>
          </div>
        ))}
      </div>
      ) : showMv ? null : (
        <button type="button" data-testid="vb-multiview-show" onClick={() => setShowMv(true)} className="self-start rounded-full border border-white/20 px-3 py-1 font-mono text-[11px] text-white hover:bg-white/10">Show Main | Backup</button>
      )}
      <p className="font-mono text-[10px] text-white/40">{showMv ? "Main and Backup, muted (WebRTC). Unmute one only if you need to hear it." : "Multiview hidden on this device. Tap to load Main and Backup."}</p>
    </div>
  )
}

/** A /stream preview iframe mounted only while on screen and the tab is visible. */
function ShownFrame({ testId, title, src, className }: { testId: string; title: string; src: string; className: string }) {
  const box = useRef<HTMLDivElement>(null)
  const shown = useShown(box)
  const loadGate = useLoadAlert()
  if (loadGate.paused) return <LoadPaused reason={loadGate.alert?.reason ?? ""} onShow={loadGate.showAnyway} className="absolute inset-0" />
  return <div ref={box} className="absolute inset-0">{shown ? <iframe data-testid={testId} title={title} src={src} className={className} /> : null}</div>
}
