"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ConfirmButton } from "@/components/confirm-button"
import { StreamPlayer } from "@/components/stream-player"
import { joinRtmpServerAndKey } from "@/lib/rtmp-join"
import { handleUnauthorized } from "@/lib/use-operator"

type Tone = "solid" | "outline" | "danger" | "live"
type PillClass = (tone?: Tone, size?: "sm" | "md") => string
type Dest = { id: string; name: string; host: string; activateAt?: number | null; timerPath?: "slate" | "capture" | "vertical" | null }
type Health = { fps: number | null; kbps: number | null; speed?: number | null; level?: string; warnings?: string[] }
export type VerticalView = {
  running: boolean
  state: "blocked" | "off" | "waiting" | "connecting" | "forwarding" | "retrying" | "stalled"
  adopted: boolean
  restarts: number
  reconnects: number
  sourceReady: boolean
  encoder: string | null
  audio: "copy" | "aac" | null
  bg: string | null
  settings: { bg: string; encoder: "auto" | "libx264" | "videotoolbox"; audio: "auto" | "copy" | "aac" }
  publishing?: boolean
  autoEncoder?: "libx264" | "videotoolbox"
  health: Health
  error: string | null
  command: string | null
  logTail: string
  note?: string | null
}

type Forward = { rawError?: string | null; destId: string; name: string; host: string; state: VerticalView["state"]; restarts: number; reconnects: number; error: string | null; health: Health }
type VerticalPath = { ready: boolean; forwards: Forward[]; available?: { destId: string; reason: string | null }[] }
export const FORWARD_STATE_LABEL: Record<Forward["state"], string> = { blocked: "Blocked", off: "Off", waiting: "Waiting", connecting: "Connecting…", forwarding: "Forwarding", retrying: "Retrying", stalled: "Stalled" }

/** Relay /vertical: publisher + forwards (same data the Relay card shows), polled every 2s. */
export function useVerticalPath() {
  const [path, setPath] = useState<VerticalPath | null>(null)
  const load = useCallback(async () => {
    const body = (await (await fetch("/api/relay", { cache: "no-store" }).catch(() => null))?.json().catch(() => null)) as { paths?: { vertical?: VerticalPath } } | null
    if (body?.paths?.vertical) setPath(body.paths.vertical)
  }, [])
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0)
    const id = window.setInterval(() => void load(), 2000)
    return () => { window.clearTimeout(first); window.clearInterval(id) }
  }, [load])
  const setForward = useCallback(async (destinationId: string, on: boolean): Promise<string | null> => {
    const response = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "forward", path: "vertical", destinationId, on }) }).catch(() => null)
    if (!response) return "Could not reach the server."
    if (handleUnauthorized(response)) return null
    const body = (await response.json().catch(() => null)) as { paths?: { vertical?: VerticalPath }; error?: string } | null
    if (body?.paths?.vertical) setPath(body.paths.vertical)
    return response.ok ? null : (body?.error ?? `Server returned ${response.status}.`)
  }, [])
  return { path, setForward }
}

export const VERTICAL_STATE_LABEL: Record<VerticalView["state"], string> = { blocked: "Blocked", off: "Off", waiting: "Waiting for capture", connecting: "Connecting…", forwarding: "Live", retrying: "Retrying", stalled: "Stalled" }
const tone = (s: VerticalView["state"] | undefined) => (s === "forwarding" ? "bg-[#128a3e] text-white" : s === "connecting" || s === "retrying" || s === "waiting" ? "bg-[#b45309] text-white" : s === "stalled" || s === "blocked" ? "bg-[#d93200] text-white" : "bg-black/5 text-black/70")

/** Polls /api/vertical every 2s; act() posts an action and returns the error text (or null). */
export function useVertical() {
  const [view, setView] = useState<VerticalView | null>(null)
  const load = useCallback(async () => {
    const response = await fetch("/api/vertical", { cache: "no-store" }).catch(() => null)
    if (!response?.ok) return
    const body = (await response.json().catch(() => null)) as VerticalView | null
    if (body && typeof body.running === "boolean") setView(body)
  }, [])
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0)
    const id = window.setInterval(() => void load(), 2000)
    return () => { window.clearTimeout(first); window.clearInterval(id) }
  }, [load])
  const act = useCallback(async (payload: Record<string, unknown>): Promise<{ error: string | null; note: string | null }> => {
    const response = await fetch("/api/vertical", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null)
    if (!response) return { error: "Could not reach the server.", note: null }
    if (handleUnauthorized(response)) return { error: null, note: null }
    const body = (await response.json().catch(() => null)) as (VerticalView & { error?: string }) | null
    if (body && typeof body.running === "boolean") setView(body)
    return { error: response.ok ? null : (body?.error ?? `Server returned ${response.status}.`), note: body?.note ?? null }
  }, [])
  return { view, act, reload: load }
}

/** Desk › Encoder: the Vertical (9:16) output card. */
export function VerticalCard({ dests, pillClass, onDestsChanged, onEdit }: { dests: Dest[]; pillClass: PillClass; onDestsChanged?: () => void; /** opens the desk's Saved destinations editor */ onEdit?: (id: string) => void }) {
  const { view, act } = useVertical()
  const [busy, setBusy] = useState<string | null>(null)
  const pendingFwd = useRef<Set<string>>(new Set())
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null)
  const [form, setForm] = useState<{ open: boolean; name: string; server: string; key: string }>({ open: false, name: "", server: "", key: "" })
  const [preview, setPreview] = useState(false)
  const { path, setForward } = useVerticalPath()
  const relayReady = path ? path.ready : null
  const live = view?.running === true
  const s = view?.settings
  const run = async (key: string, payload: Record<string, unknown>) => {
    setBusy(key)
    const r = await act(payload)
    setBusy(null)
    setMessage(r.error ? { tone: "error", text: r.error } : r.note ? { tone: "info", text: r.note } : null)
    return r.error === null
  }
  const save = (patch: Partial<VerticalView["settings"]>) => void run("settings", { action: "settings", settings: patch })
  const toggle = async (id: string, on: boolean) => {
    pendingFwd.current.add(id)
    setBusy(`fwd-${id}`)
    const error = await setForward(id, on)
    setBusy(null)
    pendingFwd.current.delete(id)
    setMessage(error ? { tone: "error", text: error } : null)
  }
  async function addDest() {
    setBusy("add")
    const response = await fetch("/api/rtmp-destinations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", name: form.name, url: joinRtmpServerAndKey(form.server, form.key) }) }).catch(() => null)
    setBusy(null)
    if (!response) return setMessage({ tone: "error", text: "Could not reach the server." })
    if (handleUnauthorized(response)) return
    const body = (await response.json().catch(() => null)) as { item?: { id: string }; error?: string } | null
    if (!response.ok || !body?.item) return setMessage({ tone: "error", text: body?.error ?? `Server returned ${response.status}.` })
    onDestsChanged?.()
    setForm({ open: false, name: "", server: "", key: "" })
    void toggle(body.item.id, true)
  }
  const h = view?.health
  return (
    <div data-testid="vertical-card" className="min-w-0 space-y-3 rounded-2xl border border-black/10 bg-white p-3 break-words [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[13px] font-bold tracking-[0.04em]">/vertical 9:16</p>
        <span data-testid="vertical-status" data-state={view?.state ?? "loading"} className={`inline-flex items-center gap-2 rounded-full px-3 py-1 font-mono text-[12px] font-bold tracking-[0.14em] uppercase ${tone(view?.state)}`}>
          <span className={`size-1.5 rounded-full ${live ? "animate-pulse bg-white" : "bg-black/30"}`} />
          {view ? VERTICAL_STATE_LABEL[view.state] : "…"}
          {view && view.restarts > 0 ? <span title="Times the loop relaunched ffmpeg"> · {view.restarts} {view.restarts === 1 ? "restart" : "restarts"}</span> : null}
        </span>
      </div>
      <p className="font-mono text-[12px] text-black/70">Reads Browser capture from the relay (/capture), re-encodes it to 1080×1920 (whole 16:9 picture centred, bars top and bottom) and publishes it to the relay as /vertical. Destinations below are forwards from /vertical, like the HD relay. Needs Browser capture publishing to the relay. H.264 4500k, 30 fps, keyframe 2s.</p>
      <div className="space-y-1 font-mono text-[12px] text-black/70">
        <p className="font-bold text-black">Vertical destinations</p>
        {dests.length === 0 ? <p>No saved destinations yet. Add one below.</p> : null}
        {dests.map((d) => {
          const fwd = path?.forwards.find((f) => f.destId === d.id)
          const checked = pendingFwd.current.has(d.id) ? !Boolean(fwd) : Boolean(fwd)
          const reason = path?.available?.find((x) => x.destId === d.id)?.reason ?? null
          // Only a real conflict blocks ticking (a ticked one can always be unticked). Ticks apply live.
          const blocked = Boolean(reason) && !checked
          return (
            <div key={d.id} data-testid={`vertical-dest-row-${d.id}`} data-blocked={blocked ? "1" : "0"} data-state={fwd?.state ?? "off"} className="space-y-0.5">
              <div className="flex items-center gap-2">
              <label className={`flex min-w-0 flex-1 items-center gap-2 ${blocked ? "cursor-not-allowed" : "cursor-pointer text-black"}`}>
                <input type="checkbox" data-testid={`vertical-dest-${d.id}`} className="size-4 shrink-0 accent-black" disabled={blocked || busy === `fwd-${d.id}` || !path} checked={checked} onChange={(e) => void toggle(d.id, e.target.checked)} />
                <span className="min-w-0 truncate"><span className="font-bold">{d.name}</span> · {d.host}</span>
                {fwd ? <span data-testid={`vertical-fwd-state-${d.id}`} className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${tone(fwd.state)}`}>{FORWARD_STATE_LABEL[fwd.state]}{fwd.reconnects ? ` · ${fwd.reconnects}↻` : ""}</span> : null}
              </label>
              {onEdit ? <button type="button" data-testid={`vertical-dest-edit-${d.id}`} title="Edit name / server / stream key (Saved destinations, right column)" className="shrink-0 text-[11px] text-black/50 underline underline-offset-2 hover:text-black" onClick={() => onEdit(d.id)}>Edit</button> : null}
              </div>
              {d.activateAt ? <p data-testid={`vertical-timer-${d.id}`} className="pl-6 text-[11px] text-[#b45309]">Timer · {d.timerPath ?? "?"} · {(() => { const dt = new Date(d.activateAt!); const now = new Date(); const same = dt.toDateString() === now.toDateString(); const tom = new Date(now); tom.setDate(now.getDate() + 1); const time = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); return same ? `today ${time}` : dt.toDateString() === tom.toDateString() ? `tomorrow ${time}` : `${dt.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}` })()}</p> : null}
              {fwd && fwd.state === "forwarding" && fwd.health.kbps !== null ? <p className="pl-6 text-[11px] text-[#0f6b31]">{fwd.health.fps !== null ? `${fwd.health.fps.toFixed(1)} fps · ` : ""}{fwd.health.kbps}k{fwd.health.speed ? ` · ${fwd.health.speed.toFixed(2)}x` : ""}</p> : null}
              {fwd?.error && fwd.state !== "forwarding" ? <p title={fwd.rawError ?? undefined} data-testid={`vertical-fwd-error-${d.id}`} className={`pl-6 text-[11px] font-bold ${fwd.state === "waiting" ? "text-black/60" : "text-[#8a1c13]"}`}>{fwd.error}</p> : null}
              {blocked ? <p data-testid={`vertical-dest-reason-${d.id}`} className="pl-6 text-[11px] font-bold text-[#8a4b06]">{reason}</p> : null}
            </div>
          )
        })}
        <p className="text-[11px] text-black/60">Each ticked destination is its own relay forward from /vertical (ffmpeg -c copy): tick or untick while live, the encoder keeps running. A rejected key backs off (up to 30s between tries).</p>
        <button type="button" data-testid="vertical-dest-add" className={pillClass("outline", "sm")} onClick={() => setForm({ ...form, open: !form.open })}>+ Add vertical destination</button>
        {form.open ? (
          <form data-testid="vertical-dest-form" className="space-y-2 rounded-xl border border-black/10 bg-[#F6F6F3] p-3" onSubmit={(e) => { e.preventDefault(); void addDest() }}>
            <input aria-label="Destination name" data-testid="vertical-dest-name" className="h-9 w-full border px-3 text-sm" placeholder="Name, e.g. TikTok Live" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <label className="block text-[11px] text-black/60">Server
              <input aria-label="Server" data-testid="vertical-dest-url" autoComplete="off" spellCheck={false} className="h-9 w-full border px-3 text-sm" placeholder="rtmp://push.example.com/live" value={form.server} onChange={(e) => setForm({ ...form, server: e.target.value })} />
            </label>
            <label className="block text-[11px] text-black/60">Stream key
              <input aria-label="Stream key" data-testid="vertical-dest-key" type="password" autoComplete="off" spellCheck={false} className="h-9 w-full border px-3 text-sm" placeholder="xxxx-xxxx (leave empty if Server has the full URL)" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
            </label>
            <p className="text-[11px] text-black/60">Saved with the other destinations (same allow-list: RTMP_ALLOWED_HOSTS, or LAN + YouTube/Restream/Castr/Twitch/Facebook) and ticked for Vertical.</p>
            <div className="flex gap-2">
              <button type="submit" data-testid="vertical-dest-save" disabled={busy !== null} className={pillClass("live", "sm")}>Save destination</button>
              <button type="button" className={pillClass("outline", "sm")} onClick={() => setForm({ open: false, name: "", server: "", key: "" })}>Cancel</button>
            </div>
          </form>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[12px] text-black/70">
        <label htmlFor="vertical-bg">Bars</label>
        <select id="vertical-bg" data-testid="vertical-bg" disabled={live || !s} value={s && ["#000000", "#0000B6"].includes(s.bg) ? s.bg : "custom"} onChange={(e) => e.target.value !== "custom" && save({ bg: e.target.value })} className="h-8 border px-2">
          <option value="#000000">Black</option>
          <option value="#0000B6">Hyphen blue #0000B6</option>
          {s && !["#000000", "#0000B6"].includes(s.bg) ? <option value="custom">{s.bg}</option> : null}
        </select>
        <input type="color" aria-label="Custom bar colour" data-testid="vertical-bg-custom" disabled={live || !s} value={s?.bg.toLowerCase() ?? "#000000"} onChange={(e) => save({ bg: e.target.value })} className="h-8 w-10 border" />
        <label htmlFor="vertical-encoder">Encoder</label>
        <select id="vertical-encoder" data-testid="vertical-encoder" disabled={live || !s} value={s?.encoder ?? "auto"} onChange={(e) => save({ encoder: e.target.value as VerticalView["settings"]["encoder"] })} className="h-8 border px-2">
          <option value="auto">Auto ({view?.autoEncoder === "videotoolbox" ? "VideoToolbox on this Mac" : "libx264 here; VideoToolbox on a Mac"})</option>
          <option value="libx264">libx264 (CPU, strict CBR)</option>
          <option value="videotoolbox">VideoToolbox (Mac GPU, lighter)</option>
        </select>
        <label htmlFor="vertical-audio">Audio</label>
        <select id="vertical-audio" data-testid="vertical-audio" disabled={live || !s} value={s?.audio ?? "auto"} onChange={(e) => save({ audio: e.target.value as VerticalView["settings"]["audio"] })} className="h-8 border px-2">
          <option value="auto">Auto (copy AAC, else re-encode)</option>
          <option value="copy">Copy</option>
          <option value="aac">AAC 128k 48 kHz</option>
        </select>
      </div>
      {live ? (
        <p data-testid="vertical-health" className="font-mono text-[12px] text-black/70">
          → relay /vertical{view.publishing ? " ● publishing" : " (not publishing yet)"} · {view.encoder} · audio {view.audio}
          {h && h.fps !== null ? ` · ${h.fps.toFixed(1)} fps` : ""}{h && h.kbps !== null ? ` · ${h.kbps}k` : ""}{h?.speed ? ` · ${h.speed.toFixed(2)}x` : ""}
          {!view.sourceReady ? <span className="block font-bold text-[#8a4b06]">Browser capture isn&apos;t publishing to the relay (/capture). Start it with destination “Relay”.</span> : null}
          {h?.warnings?.length ? <span className="block font-bold text-[#8a4b06]">{h.warnings.join(" · ")}</span> : null}
        </p>
      ) : null}
      {view?.error && live ? <p role="alert" data-testid="vertical-error" className="rounded-xl border border-[#b45309]/40 bg-[#b45309]/10 px-3 py-2 font-mono text-[12px] font-bold text-[#7a3b06]">{view.error}</p> : null}
      {view?.adopted && live ? <p data-testid="vertical-adopted" className="font-mono text-[12px] text-black/70">Found Vertical already running (started before the server restarted). Stop works on it.</p> : null}
      <div className="flex flex-wrap gap-2">
        <ConfirmButton data-testid="vertical-start" className={pillClass("solid")} disabled={live || busy !== null || !s} confirmLabel="Start vertical? · confirm" onConfirm={() => void run("start", { action: "start" })}>{busy === "start" ? "Starting…" : "Start vertical"}</ConfirmButton>
        <ConfirmButton data-testid="vertical-stop" className={pillClass("danger")} disabled={!live || busy !== null} confirmLabel="Stop vertical? · confirm" onConfirm={() => void run("stop", { action: "stop" })}>{busy === "stop" ? "Stopping…" : "Stop"}</ConfirmButton>
      </div>
      <button type="button" data-testid="vertical-preview" aria-pressed={preview} className={pillClass("outline", "sm")} onClick={() => setPreview(!preview)}>{preview ? "Hide preview" : "Preview /vertical"}</button>
      {preview ? (
        <div data-testid="vertical-preview-box" data-ready={relayReady ? "1" : "0"} className="relative mx-auto aspect-[9/16] w-full max-w-[240px] overflow-hidden rounded-lg bg-black">
          {relayReady ? <StreamPlayer src="/api/relay/hls/vertical/index.m3u8" /> : (
            <span data-testid="vertical-preview-off" className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-3 text-center font-mono text-[12px] text-white/70">
              <span className="font-bold text-white/90">{relayReady === null ? "Loading…" : "Not publishing"}</span>
              {relayReady === null ? null : live ? "Vertical is starting or Browser capture isn't on the relay yet." : "Start Vertical to see /vertical here."}
            </span>
          )}
        </div>
      ) : null}
      {view?.command ? (
        <details className="font-mono text-[11px] text-black/60">
          <summary>ffmpeg command (keys redacted)</summary>
          <p data-testid="vertical-command" className="mt-1 break-all">{view.command}</p>
        </details>
      ) : null}
      {message ? <p role="status" data-testid="vertical-message" className={`font-mono text-[13px] ${message.tone === "error" ? "font-bold text-[#b42318]" : "text-black/70"}`}>{message.text}</p> : null}
    </div>
  )
}

/** Deck tile: status + two-tap Start/Stop. */
export function VerticalDeckTile() {
  const { view, act } = useVertical()
  const [armed, setArmed] = useState<"start" | "stop" | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!armed) return
    const id = window.setTimeout(() => setArmed(null), 3000)
    return () => window.clearTimeout(id)
  }, [armed])
  const live = view?.running === true
  const kind = live ? "stop" : "start"
  const tap = async () => {
    if (armed !== kind) return setArmed(kind)
    setArmed(null)
    setBusy(true)
    const r = await act({ action: kind })
    setBusy(false)
    setError(r.error)
  }
  const st = view?.state
  return (
    <div data-testid="deck-vertical" data-state={st ?? "loading"} className="col-span-2 rounded-2xl bg-white/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-mono text-[13px] font-bold tracking-[0.08em] uppercase">Vertical 9:16</p>
        <span data-testid="deck-vertical-status" className={`rounded-full px-2.5 py-1 font-mono text-[12px] font-bold uppercase ${st === "forwarding" ? "bg-[#12b76a] text-black" : st === "connecting" || st === "retrying" || st === "waiting" ? "bg-[#fdb022] text-black" : st === "stalled" || st === "blocked" ? "bg-[#f04438] text-white" : "bg-white/15"}`}>{view ? VERTICAL_STATE_LABEL[view.state] : "…"}</span>
      </div>
      {live ? <p className="mb-2 truncate font-mono text-[12px] text-white/70">→ /vertical{view.publishing ? "" : " (waiting)"}{view.health.fps !== null ? ` · ${view.health.fps.toFixed(0)} fps` : ""}{view.health.kbps !== null ? ` · ${view.health.kbps}k` : ""}{view.restarts ? ` · ${view.restarts} restarts` : ""}</p> : <p className="mb-2 font-mono text-[12px] text-white/60">Off · destinations are /vertical forwards (desk › Encoder)</p>}
      <button type="button" data-testid="deck-vertical-toggle" data-armed={armed ? "1" : undefined} disabled={busy || !view} onClick={() => void tap()}
        className={`min-h-14 w-full touch-manipulation rounded-2xl px-3 py-2 text-[17px] font-bold select-none disabled:opacity-35 ${live ? "border-2 border-[#f97066] text-[#fda29b]" : "bg-white/10 text-white"} ${armed ? "ring-4 ring-[#fdb022] ring-offset-2 ring-offset-[#0b0b0f]" : ""}`}>
        {armed ? "Tap again to confirm" : busy ? "…" : live ? "Stop vertical" : "Start vertical"}
      </button>
      {error ? <p role="alert" className="mt-2 font-mono text-[12px] text-[#fda29b]">{error}</p> : null}
    </div>
  )
}
