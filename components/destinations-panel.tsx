"use client"
/**
 * Desk (right column) "Saved destinations": every RTMP destination with where it is used (HD relay
 * forward /capture or /slate, Vertical /vertical forward, or a channel's direct target), masked URL,
 * Edit / Reveal / Delete, "+ Add destination" and an inline add/edit form with an explicit Save.
 * Keys never come to the browser except on Reveal (operator-only POST, hidden again after 30s); the
 * edit form gets the server part and the key's last 4 only. Saving a new key for a ticked forward
 * restarts only that forward (server side).
 *
 * Per-destination timer: activateAt (unix ms) shows as a tag on the card and a checkbox + datetime
 * in the editor. It does not affect the HD/Vertical group — only this destination.
 */
import { Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { ConfirmButton } from "@/components/confirm-button"
import { joinRtmpServerAndKey, splitRtmpUrl } from "@/lib/rtmp-join"
import { handleUnauthorized } from "@/lib/use-operator"

export type PanelDest = { id: string; name: string; host: string; masked: string; display?: string; createdAt: number; activateAt?: number | null; timerPath?: "slate" | "capture" | "vertical" | null }
type Tone = "solid" | "outline" | "danger" | "live"
type PillClass = (tone?: Tone, size?: "sm" | "md") => string
type Fwd = { destId: string; state: string; reconnects?: number; restarts?: number; health?: { fps?: number | null; kbps?: number | null; speed?: number | null } | null; error?: string | null; rawError?: string | null }
type Paths = Partial<Record<"slate" | "capture" | "vertical", { forwards: Fwd[]; available?: { destId: string; reason: string | null }[] }>>
export type ForwardPath = "capture" | "slate" | "vertical"
export type ForwardToggle = { path: ForwardPath; label: string; on: boolean; state: string | null; blocked: string | null; stats: string | null; error: string | null }
type UseFor = "none" | "capture" | "vertical"
type Form = { mode: "add" | "edit"; id: string | null; name: string; server: string; key: string; showKey: boolean; useFor: UseFor; keyTail: string; keyKind: "path" | "query" | "none"; savedKey: string | null; error: string; busy: boolean; timerOn: boolean; timerAt: string; timerPath: "slate" | "capture" | "vertical" }

const DOTS = "••••••••"
const FWD_LABEL: Record<string, string> = { forwarding: "live", connecting: "connecting", retrying: "retrying", stalled: "stalled", waiting: "waiting", blocked: "blocked", off: "off" }

function toLocalInput(ms: number | null | undefined): string {
  if (!ms) return ""
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(s: string): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}
function formatTime(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1)
  const isTomorrow = d.toDateString() === tomorrow.toDateString()
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  if (sameDay) return `today ${time}`
  if (isTomorrow) return `tomorrow ${time}`
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`
}

let pendingEdit: string | null = null
const EDIT_EVENT = "desk:edit-destination"
export function requestDestinationEdit(id: string) {
  pendingEdit = id
  window.dispatchEvent(new CustomEvent(EDIT_EVENT, { detail: id }))
}

export function joinedPreview(f: Pick<Form, "mode" | "server" | "key" | "showKey" | "keyTail" | "keyKind" | "savedKey">): string {
  const server = f.server.trim()
  if (!server) return ""
  const typed = f.key.trim()
  if (typed) return joinRtmpServerAndKey(server, f.showKey ? typed : `${typed.startsWith("?") ? "?" : ""}${DOTS}`)
  if (f.mode === "add") return server
  if (f.savedKey !== null) return joinRtmpServerAndKey(server, f.savedKey)
  if (f.keyKind === "none") return server
  return joinRtmpServerAndKey(server, `${f.keyKind === "query" ? "?" : ""}${DOTS}${f.keyTail}`)
}

export function destinationUses(id: string, paths: Paths | null, selected: { slate: string | null; capture: string | null }): { label: string; kind: "hd" | "vertical" | "channel"; state?: string }[] {
  const out: { label: string; kind: "hd" | "vertical" | "channel"; state?: string }[] = []
  for (const p of ["capture", "slate"] as const) {
    const f = paths?.[p]?.forwards.find((x) => x.destId === id)
    if (f) out.push({ label: `HD /${p} forward`, kind: "hd", state: f.state })
  }
  const v = paths?.vertical?.forwards.find((x) => x.destId === id)
  if (v) out.push({ label: "Vertical /vertical forward", kind: "vertical", state: v.state })
  if (selected.capture === id) out.push({ label: "Browser capture channel", kind: "channel" })
  if (selected.slate === id) out.push({ label: "Slate channel", kind: "channel" })
  return out
}

/** Pure: compact stats next to a live switch ("30 fps · 2500k · 1.00x · 2↻"), from /api/relay data. */
export function forwardStats(f: Fwd): string | null {
  const parts: string[] = []
  const h = f.health
  if (f.state === "forwarding" && h) {
    if (typeof h.fps === "number") parts.push(`${h.fps.toFixed(0)} fps`)
    if (typeof h.kbps === "number") parts.push(`${h.kbps}k`)
    if (typeof h.speed === "number") parts.push(`${h.speed.toFixed(2)}x`)
  }
  if (f.reconnects) parts.push(`${f.reconnects}↻`)
  else if (f.restarts && f.state !== "forwarding") parts.push(`${f.restarts} ${f.restarts === 1 ? "retry" : "retries"}`)
  return parts.length ? parts.join(" · ") : null
}

/** Pure: what the timer tag on a card says, e.g. "Timer · HD /capture · today 09:25". */
export function timerTag(at: number | null | undefined, path: PanelDest["timerPath"], when: (ms: number) => string): string | null {
  if (!at) return null
  const label = path === "vertical" ? "9:16 /vertical" : path ? `HD /${path}` : "no path"
  return `Timer · ${label} · ${when(at)}`
}

/** Pure: the per-destination forward switches (HD /capture, HD /slate, 9:16 /vertical) from /api/relay state. A ticked one can always be switched off; a blocked reason only stops switching on. */
export function forwardToggles(id: string, paths: Paths | null): ForwardToggle[] {
  const label: Record<ForwardPath, string> = { capture: "HD /capture", slate: "HD /slate", vertical: "9:16 /vertical" }
  return (["capture", "slate", "vertical"] as const).map((p) => {
    const f = paths?.[p]?.forwards.find((x) => x.destId === id) ?? null
    const reason = paths?.[p]?.available?.find((x) => x.destId === id)?.reason ?? null
    return { path: p, label: label[p], on: Boolean(f), state: f?.state ?? null, blocked: f ? null : reason, stats: f ? forwardStats(f) : null, error: f?.error && f.state !== "forwarding" && f.state !== "waiting" ? f.error : null }
  })
}

async function post(url: string, payload: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> | null; status: number }> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null)
  if (!response) return { ok: false, body: { error: "Could not reach the server." }, status: 0 }
  if (handleUnauthorized(response)) return { ok: false, body: null, status: response.status }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  return { ok: response.ok, body, status: response.status }
}

export function DestinationsPanel({ dests, selected, liveIds, pillClass, onChanged, onNote }: {
  dests: PanelDest[]
  selected: { slate: string | null; capture: string | null }
  liveIds: string[]
  pillClass: PillClass
  onChanged: () => void
  onNote: (tone: "ok" | "error", text: string) => void
}) {
  const [paths, setPaths] = useState<Paths | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(null)
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const note = (tone: "ok" | "error", text: string) => { setStatus({ tone, text }); onNote(tone, text) }
  const formRef = useRef<HTMLFormElement | null>(null)
  const loadPaths = useCallback(async () => {
    const body = (await (await fetch("/api/relay", { cache: "no-store" }).catch(() => null))?.json().catch(() => null)) as { paths?: Paths } | null
    if (body?.paths) setPaths(body.paths)
  }, [])
  useEffect(() => {
    const first = window.setTimeout(() => void loadPaths(), 0)
    const id = window.setInterval(() => void loadPaths(), 3000)
    return () => { window.clearTimeout(first); window.clearInterval(id) }
  }, [loadPaths])
  useEffect(() => {
    if (!revealed) return
    const id = window.setTimeout(() => setRevealed(null), 30_000)
    return () => window.clearTimeout(id)
  }, [revealed])

  const [fwdBusy, setFwdBusy] = useState<string | null>(null)
  // Same call RelayCard / VerticalCard used: POST /api/relay { action: "forward", path, destinationId, on }.
  async function setForward(id: string, name: string, path: ForwardPath, on: boolean) {
    setFwdBusy(`${path}-${id}`)
    const r = await post("/api/relay", { action: "forward", path, destinationId: id, on })
    setFwdBusy(null)
    const next = r.body?.paths as Paths | undefined
    if (next) setPaths(next); else void loadPaths()
    if (r.ok) note("ok", `${name}: /${path} forward ${on ? "on" : "off"}.`)
    else note("error", r.status === 401 ? `${name}: not switched, signed out. Sign in and try again.` : `${name}: /${path} forward not switched ${on ? "on" : "off"}: ${String(r.body?.error ?? (r.status ? `server returned ${r.status}` : "could not reach the server"))}`)
  }
  const focusForm = () => window.requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }))
  const startEdit = useCallback(async (id: string) => {
    const r = await post("/api/rtmp-destinations", { action: "edit-info", id })
    const info = r.body as { name?: string; server?: string; keyTail?: string; keyKind?: Form["keyKind"]; activateAt?: number | null; error?: string } | null
    if (!r.ok || !info?.server) { if (info?.error) note("error", info.error); return }
    const at = info.activateAt ?? null
    setForm({ mode: "edit", id, name: info.name ?? "", server: info.server, key: "", showKey: false, useFor: "none", keyTail: info.keyTail ?? "", keyKind: info.keyKind ?? "path", savedKey: null, error: "", busy: false, timerOn: at !== null, timerAt: toLocalInput(at), timerPath: (info as { timerPath?: "slate" | "capture" | "vertical" }).timerPath ?? "capture" })
    focusForm()
  }, [onNote]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const handle = (id: string) => { pendingEdit = null; void startEdit(id) }
    const onEvent = (e: Event) => handle((e as CustomEvent<string>).detail)
    window.addEventListener(EDIT_EVENT, onEvent)
    const first = pendingEdit ? window.setTimeout(() => pendingEdit && handle(pendingEdit), 0) : null
    return () => { window.removeEventListener(EDIT_EVENT, onEvent); if (first !== null) window.clearTimeout(first) }
  }, [startEdit])

  async function reveal(id: string) {
    if (revealed?.id === id) return setRevealed(null)
    const r = await post("/api/rtmp-destinations", { action: "reveal", id })
    const url = (r.body as { url?: string } | null)?.url
    if (r.ok && url) setRevealed({ id, url })
    else if (r.body?.error) note("error", String(r.body.error))
  }
  async function revealSavedKey() {
    if (!form?.id) return
    if (form.savedKey !== null) return setForm({ ...form, savedKey: null })
    const r = await post("/api/rtmp-destinations", { action: "reveal", id: form.id })
    const url = (r.body as { url?: string } | null)?.url
    if (r.ok && url) setForm((f) => (f ? { ...f, savedKey: splitRtmpUrl(url).key } : f))
  }
  async function save() {
    if (!form) return
    setForm({ ...form, busy: true, error: "" })
    const timerAt = form.timerOn ? fromLocalInput(form.timerAt) : null
    if (form.mode === "edit") {
      const r = await post("/api/rtmp-destinations", { action: "update", id: form.id, name: form.name, server: form.server, key: form.key })
      if (!r.ok) return setForm((f) => (f ? { ...f, busy: false, error: String(r.body?.error ?? `Server returned ${r.status}.`) } : f))
      if (form.id) {
        const t = await post("/api/rtmp-destinations", { action: "set-timer", id: form.id, activateAt: timerAt, timerPath: form.timerPath })
        if (!t.ok) return setForm((f) => (f ? { ...f, busy: false, error: `Saved, but the timer was not set: ${String(t.body?.error ?? t.status)}` } : f))
      }
      setForm(null)
      setRevealed(null)
      onChanged()
      note("ok", String(r.body?.note ?? "Saved."))
      return
    }
    const r = await post("/api/rtmp-destinations", { action: "add", name: form.name, url: joinRtmpServerAndKey(form.server, form.key) })
    const id = (r.body as { item?: { id?: string } } | null)?.item?.id
    if (!r.ok || !id) return setForm((f) => (f ? { ...f, busy: false, error: String(r.body?.error ?? `Server returned ${r.status}.`) } : f))
    if (timerAt) {
      const t = await post("/api/rtmp-destinations", { action: "set-timer", id, activateAt: timerAt, timerPath: form.timerPath })
      if (!t.ok) note("error", `Saved ${form.name.trim()}, but the timer was not set: ${String(t.body?.error ?? t.status)}`)
    }
    let msg = `Saved ${form.name.trim()}.`
    if (form.useFor !== "none") {
      const t = await post("/api/relay", { action: "forward", path: form.useFor, destinationId: id, on: true })
      msg = t.ok ? `${msg} Ticked for ${form.useFor === "vertical" ? "Vertical" : "HD /capture"}.` : `${msg} Could not tick it: ${String(t.body?.error ?? t.status)}`
    }
    setForm(null)
    onChanged()
    void loadPaths()
    note("ok", msg)
  }

  const groups: { title: string; items: PanelDest[] }[] = [
    { title: "HD (/capture · /slate)", items: [] },
    { title: "Vertical (/vertical)", items: [] },
    { title: "Not ticked for a forward", items: [] },
  ]
  for (const d of dests) {
    const uses = destinationUses(d.id, paths, selected)
    groups[uses.some((u) => u.kind === "hd") ? 0 : uses.some((u) => u.kind === "vertical") ? 1 : 2].items.push(d)
  }
  const input = "h-9 w-full rounded-lg border border-black/15 bg-white px-3 font-mono text-[13px]"
  const preview = form ? joinedPreview(form) : ""
  const timerPreview = form?.timerOn && form.timerAt ? fromLocalInput(form.timerAt) : null
  return (
    <div data-testid="dest-panel" className="space-y-3">
      <p className="font-mono text-[12px] text-black/70">Where each destination is used (HD relay forward, Vertical forward, or a channel). Edit replaces a rotated stream key: a ticked forward restarts with it on Save, nothing else restarts. Keys stay on this server; Reveal shows one for 30s.</p>
      {dests.length === 0 ? <p className="font-mono text-[12px] text-black/60">No destinations yet.</p> : null}
      {groups.filter((g) => g.items.length).map((g) => (
        <div key={g.title} className="space-y-2">
          <p className="font-mono text-[11px] font-bold tracking-[0.12em] text-black/50 uppercase">{g.title}</p>
          {g.items.map((d) => {
            const uses = destinationUses(d.id, paths, selected)
            const editing = form?.mode === "edit" && form.id === d.id
            const live = liveIds.includes(d.id)
            const timer = d.activateAt ? d.activateAt : null
            return (
              <div key={d.id} data-testid={`dest-card-${d.id}`} data-editing={editing ? "1" : undefined} className={`min-w-0 rounded-xl border p-3 ${editing ? "border-black/10 border-l-4 border-l-[#d93200] bg-[#fff7f2]" : "border-black/10 bg-white"}`}>
                <p className="text-[15px] font-bold break-words">{d.name}</p>
                <p data-testid={`dest-uses-${d.id}`} className="mt-0.5 flex flex-wrap gap-1 font-mono text-[11px] text-black/60">
                  {uses.length ? uses.map((u) => (
                    <span key={u.label} className={`rounded-full px-2 py-0.5 ${u.kind === "vertical" ? "bg-[#0000B6]/10 text-[#0000B6]" : u.kind === "hd" ? "bg-black/[0.06] text-black/80" : "bg-[#b45309]/10 text-[#7a3b06]"}`}>
                      {u.kind === "vertical" ? "9:16 " : u.kind === "hd" ? "HD " : ""}{u.label.replace(/^(HD|Vertical) /, "")}{u.state ? ` · ${FWD_LABEL[u.state] ?? u.state}` : ""}
                    </span>
                  )) : <span>not used yet</span>}
                  {timer ? <span data-testid={`dest-timer-${d.id}`} className="rounded-full bg-[#b45309]/10 px-2 py-0.5 text-[#b45309]">{timerTag(timer, d.timerPath, formatTime)}</span> : null}
                </p>
                <div data-testid={`dest-fwd-${d.id}`} className="mt-1.5 flex flex-wrap gap-1.5 font-mono text-[11px]">
                  {forwardToggles(d.id, paths).map((t) => {
                    const tid = `dest-fwd-${t.path}-${d.id}`
                    const busy = fwdBusy === `${t.path}-${d.id}` || !paths
                    return t.on ? (
                      <ConfirmButton key={t.path} data-testid={tid} data-on="1" data-state={t.state ?? undefined} disabled={busy} className="rounded-full bg-[#128a3e] px-2.5 py-1 font-bold text-white disabled:opacity-40"
                        confirmLabel={`Stop ${t.label}? Tap again`} onConfirm={() => void setForward(d.id, d.name, t.path, false)}>
                        ● {t.label} · {FWD_LABEL[t.state ?? ""] ?? t.state}{t.stats ? <span data-testid={`${tid}-stats`} className="font-normal"> · {t.stats}</span> : null}
                      </ConfirmButton>
                    ) : (
                      <button key={t.path} type="button" data-testid={tid} data-on="0" disabled={busy || Boolean(t.blocked)} title={t.blocked ?? `Forward ${t.label} to ${d.name}`}
                        className="rounded-full border border-black/15 bg-white px-2.5 py-1 text-black/70 hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40" onClick={() => void setForward(d.id, d.name, t.path, true)}>
                        ○ {t.label}
                      </button>
                    )
                  })}
                  {forwardToggles(d.id, paths).filter((t) => t.error).map((t) => <p key={`e-${t.path}`} data-testid={`dest-fwd-${t.path}-${d.id}-error`} className="basis-full break-words text-[11px] font-bold text-[#8a1c13]">{t.label}: {t.error}</p>)}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <p data-testid={`dest-display-${d.id}`} className="min-w-0 font-mono text-[12px] break-all">{revealed?.id === d.id ? revealed.url : (d.display ?? d.masked)}</p>
                  <span className="flex shrink-0 items-center gap-1 font-mono text-[12px] text-black/70">
                    <button type="button" data-testid={`dest-edit-${d.id}`} className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-black/5" onClick={() => void startEdit(d.id)}><Pencil aria-hidden className="size-3.5" />Edit</button>
                    <button type="button" data-testid={`dest-reveal-${d.id}`} aria-pressed={revealed?.id === d.id} className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-black/5" onClick={() => void reveal(d.id)}>{revealed?.id === d.id ? <EyeOff aria-hidden className="size-3.5" /> : <Eye aria-hidden className="size-3.5" />}{revealed?.id === d.id ? "Hide" : "Reveal"}</button>
                    <ConfirmButton data-testid={`dest-delete-${d.id}`} disabled={live} title={live ? "A channel is streaming to it: stop that channel first" : undefined} className="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-black/5 disabled:opacity-40" confirmLabel={uses.some((u) => u.state) ? "Delete? Its forward stops · tap again" : "Delete? Tap again"}
                      onConfirm={() => void post("/api/rtmp-destinations", { action: "delete", id: d.id }).then((r) => { if (r.ok) { onChanged(); note("ok", `Deleted ${d.name}.`) } else note("error", String(r.body?.error ?? r.status)) })}>
                      <Trash2 aria-hidden className="size-3.5" />Delete
                    </ConfirmButton>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      ))}
      <button type="button" data-testid="dest-panel-add" onClick={() => setForm({ mode: "add", id: null, name: "", server: "", key: "", showKey: false, useFor: "none", keyTail: "", keyKind: "path", savedKey: null, error: "", busy: false, timerOn: false, timerAt: "", timerPath: "capture" })}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-black/15 bg-white py-2.5 font-mono text-[13px] text-black/70 hover:bg-black/[0.03]">
        <Plus aria-hidden className="size-4" />Add destination
      </button>
      {status ? <p role="status" data-testid="dest-panel-status" className={`font-mono text-[12px] ${status.tone === "error" ? "font-bold text-[#b42318]" : "text-black/70"}`}>{status.text}</p> : null}
      {form ? (
        <form ref={formRef} data-testid="dest-panel-form" data-mode={form.mode} className="space-y-2.5 rounded-xl border border-black/10 bg-white p-4" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <div className="border-b border-black/10 pb-2">
            <p className="text-[15px] font-bold">{form.mode === "edit" ? "Edit destination" : "Add destination"}</p>
            <p className="font-mono text-[12px] text-black/60">{form.mode === "edit" ? "Update the details for this saved destination." : "Name, the service's server URL and its stream key."}</p>
          </div>
          <label className="block font-mono text-[12px] font-bold">Name
            <input data-testid="dest-panel-name" className={input} value={form.name} maxLength={60} placeholder="e.g. YouTube main" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="block font-mono text-[12px] font-bold">Server
            <input data-testid="dest-panel-server" className={input} value={form.server} autoComplete="off" spellCheck={false} placeholder="rtmp://a.rtmp.youtube.com/live2" onChange={(e) => setForm({ ...form, server: e.target.value })} />
          </label>
          <div className="font-mono text-[12px] font-bold">
            <label htmlFor="dest-panel-key">Stream key</label>
            <div className="flex gap-2">
              <input id="dest-panel-key" data-testid="dest-panel-key" type={form.showKey ? "text" : "password"} className={input} value={form.key} autoComplete="new-password" spellCheck={false}
                placeholder={form.mode === "edit" ? (form.keyKind === "none" ? "(no separate key)" : `${DOTS}${form.keyTail} (saved)`) : "xxxx-xxxx-xxxx (or ?password=…)"} onChange={(e) => setForm({ ...form, key: e.target.value })} />
              <button type="button" data-testid="dest-panel-key-eye" aria-label={form.showKey ? "Hide typed key" : "Show typed key"} aria-pressed={form.showKey} onClick={() => setForm({ ...form, showKey: !form.showKey })} className="grid h-9 w-10 shrink-0 place-items-center rounded-lg border border-black/15 bg-white">
                {form.showKey ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
              </button>
            </div>
            <p className="mt-1 font-normal text-black/60">{form.mode === "edit" ? "Leave blank to keep the existing stream key." : "Leave empty if the Server field already has the full URL."}</p>
          </div>
          {form.mode === "add" ? (
            <fieldset className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px]">
              <legend className="mb-1 font-bold">Use for</legend>
              {([["capture", "HD /capture forward"], ["vertical", "Vertical forward"], ["none", "Not yet"]] as const).map(([v, label]) => (
                <label key={v} className="flex items-center gap-1.5"><input type="radio" name="dest-use" data-testid={`dest-panel-use-${v}`} checked={form.useFor === v} onChange={() => setForm({ ...form, useFor: v })} />{label}</label>
              ))}
            </fieldset>
          ) : null}
          <div className="space-y-2 rounded-lg border border-dashed border-black/15 bg-[#fafaf8] p-3">
            <label className="flex items-center gap-2 font-mono text-[12px] font-normal">
              <input type="checkbox" data-testid="dest-panel-timer" checked={form.timerOn} onChange={(e) => setForm({ ...form, timerOn: e.target.checked })} className="size-4 accent-[#12b76a]" />
              Activate this destination on a timer
            </label>
            {form.timerOn ? (
              <div className="space-y-2">
                <label className="block font-mono text-[12px] font-bold">Start at
                  <input data-testid="dest-panel-timer-at" type="datetime-local" className={input} value={form.timerAt} onChange={(e) => setForm({ ...form, timerAt: e.target.value })} />
                </label>
                <fieldset className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px]">
                  <legend className="mb-1 font-bold">Activate on</legend>
                  {([["capture", "HD /capture"], ["slate", "HD /slate"], ["vertical", "Vertical"]] as const).map(([v, label]) => (
                    <label key={v} className="flex items-center gap-1.5 font-normal"><input type="radio" name="timer-path" data-testid={`dest-panel-timer-path-${v}`} checked={form.timerPath === v} onChange={() => setForm({ ...form, timerPath: v })} />{label}</label>
                  ))}
                </fieldset>
                {timerPreview ? <p className="rounded-lg bg-[#b45309]/10 px-2.5 py-2 font-mono text-[12px] text-[#b45309]">This destination starts forwarding at {formatTime(timerPreview)}. Other destinations are not affected.</p> : null}
              </div>
            ) : null}
          </div>
          {preview ? (
            <div data-testid="dest-panel-preview" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 font-mono text-[12px]">
              <span className="text-black/60">Preview (joined):</span>
              <span className="break-all">{preview}</span>
              {form.mode === "edit" && !form.key.trim() && form.keyKind !== "none" ? (
                <button type="button" data-testid="dest-panel-reveal-saved" className="col-start-2 justify-self-start text-[11px] text-black/60 underline underline-offset-2" onClick={() => void revealSavedKey()}>{form.savedKey !== null ? "Hide saved key" : "Reveal saved key"}</button>
              ) : null}
            </div>
          ) : null}
          {form.error ? <p role="alert" data-testid="dest-panel-error" className="font-mono text-[12px] font-bold text-[#b42318]">{form.error}</p> : null}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button type="submit" data-testid="dest-panel-save" disabled={form.busy} className={`${pillClass("live", "md")} min-w-28 rounded-lg`}>{form.busy ? "Saving…" : "Save"}</button>
            <button type="button" data-testid="dest-panel-cancel" className={`${pillClass("outline", "md")} min-w-28 rounded-lg`} onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
