"use client"

import { useCallback, useEffect, useState } from "react"
import { forwardStats } from "@/components/destinations-panel"
import { joinRtmpServerAndKey } from "@/lib/rtmp-join"
import { handleUnauthorized } from "@/lib/use-operator"

type Dest = { id: string; name: string; host: string; activateAt?: number | null; timerPath?: "slate" | "capture" | "vertical" | null }
type Fwd = { destId: string; state: string; reconnects?: number; restarts?: number; health?: { fps?: number | null; kbps?: number | null; speed?: number | null }; error?: string | null }
type PathInfo = { ready: boolean; tracks: string[]; forwards: Fwd[]; available?: { destId: string; reason: string }[] }

const TONE: Record<string, string> = { forwarding: "bg-[#128a3e] text-white", connecting: "bg-[#b45309] text-white", retrying: "bg-[#b45309] text-white", waiting: "bg-black/5 text-black/70", stalled: "bg-[#d93200] text-white", blocked: "bg-[#d93200] text-white" }
const LABEL: Record<string, string> = { forwarding: "Forwarding", connecting: "Connecting", retrying: "Retrying", waiting: "Waiting", stalled: "Stalled", blocked: "Blocked" }

/** Pure: a ticked forward that is actually (trying to) send; unticking it needs a second tap. */
export function isLiveForward(state: string | null | undefined): boolean {
  return state === "forwarding" || state === "connecting" || state === "retrying" || state === "stalled"
}

/** Pure: the message after a failed tick. null = ok. */
export function tickError(name: string, path: string, on: boolean, res: { ok: boolean; status: number; error?: string | null } | null): string | null {
  if (res?.ok) return null
  const what = `${name}: /${path} not ${on ? "ticked" : "unticked"}`
  if (!res) return `${what}: could not reach the server.`
  if (res.status === 401) return `${what}: signed out. Sign in and try again.`
  return `${what}: ${res.error ?? `server returned ${res.status}`}.`
}

function fmtTimer(ms: number): string {
  const dt = new Date(ms)
  const now = new Date()
  const same = dt.toDateString() === now.toDateString()
  const tom = new Date(now); tom.setDate(now.getDate() + 1)
  const time = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  if (same) return `today ${time}`
  if (dt.toDateString() === tom.toDateString()) return `tomorrow ${time}`
  return `${dt.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`
}

export function PathPanels({ dests, onEdit, onDestsChanged }: { dests: Dest[]; onEdit?: (id: string) => void; onDestsChanged?: () => void }) {
  const [relay, setRelay] = useState<{ paths?: Record<string, PathInfo> } | null>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState<"slate" | "capture" | "vertical" | null>(null)
  const [form, setForm] = useState({ name: "", server: "", key: "" })
  const [msg, setMsg] = useState<{ tone: "info" | "error"; text: string } | null>(null)

  const load = useCallback(async () => {
    const r = await fetch("/api/relay", { cache: "no-store" }).catch(() => null)
    if (!r?.ok) return
    const body = await r.json().catch(() => null)
    if (body?.paths) setRelay(body)
  }, [])
  useEffect(() => { const t = setTimeout(load, 0); const i = setInterval(load, 2000); return () => { clearTimeout(t); clearInterval(i) } }, [load])

  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 3000); return () => clearTimeout(t) }, [armed])

  const tick = async (path: string, id: string, name: string, on: boolean) => {
    const key = `${path}:${id}`
    setArmed(null)
    setPending((s) => new Set(s).add(key))
    const r = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "forward", path, destinationId: id, on }) }).catch(() => null)
    const body = r ? ((await r.json().catch(() => null)) as { error?: string } | null) : null
    setPending((s) => { const n = new Set(s); n.delete(key); return n })
    const error = tickError(name, path, on, r ? { ok: r.ok, status: r.status, error: body?.error ?? null } : null)
    setMsg(error ? { tone: "error", text: error } : null)
    if (r) handleUnauthorized(r)
    void load()
  }
  // Unticking a live forward: first tap arms (row says "tap again"), second within 3s stops it.
  const onToggle = (path: string, id: string, name: string, next: boolean, live: boolean) => {
    const key = `${path}:${id}`
    if (!next && live && armed !== key) return setArmed(key)
    void tick(path, id, name, next)
  }

  const add = async (path: "slate" | "capture" | "vertical") => {
    if (!form.name.trim() || !form.server.trim()) return setMsg({ tone: "error", text: "Name and server required." })
    const r = await fetch("/api/rtmp-destinations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", name: form.name, url: joinRtmpServerAndKey(form.server, form.key) }) }).catch(() => null)
    if (!r) return setMsg({ tone: "error", text: "Could not reach the server." })
    if (handleUnauthorized(r)) return
    const body = await r.json().catch(() => null)
    if (!r.ok || !body?.item) return setMsg({ tone: "error", text: body?.error ?? "Could not save." })
    onDestsChanged?.()
    setForm({ name: "", server: "", key: "" })
    setAdding(null)
    setMsg({ tone: "info", text: "Saved. Tick it, or set a timer, to start." })
  }

  const paths = [
    { id: "capture" as const, title: "/capture", status: (p?: PathInfo) => p?.ready ? "receiving" : "no publisher" },
    { id: "slate" as const, title: "/slate", status: (p?: PathInfo) => p?.ready ? "receiving" : "no publisher" },
    { id: "vertical" as const, title: "/vertical 9:16", status: (p?: PathInfo) => p?.ready ? "live" : "off" },
  ]

  return (
    <div className="mt-4 space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {paths.map(({ id, title, status }) => {
          const info = relay?.paths?.[id]
          const enabled = new Map((info?.forwards ?? []).map((f) => [f.destId, f]))
          return (
            <div key={id} data-testid={`path-panel-${id}`} className="min-w-0 space-y-2 rounded-2xl border border-black/10 bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold">{title}</span>
                <span className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-bold uppercase ${info?.ready ? "bg-[#128a3e] text-white" : "bg-black/5 text-black/60"}`}>{status(info)}</span>
              </div>
              <ul className="space-y-1">
                {dests.map((d) => {
                  const fwd = enabled.get(d.id)
                  const key = `${id}:${d.id}`
                  const on = pending.has(key) ? !Boolean(fwd) : Boolean(fwd)
                  const reason = info?.available?.find((x) => x.destId === d.id)?.reason
                  const blocked = Boolean(reason) && !on
                  return (
                    <li key={d.id} className="space-y-0.5 font-mono text-[12px]">
                      <div className="flex items-start gap-2">
                        <label className="flex min-w-0 flex-1 items-start gap-2">
                          <input type="checkbox" className="mt-0.5 shrink-0" checked={on} disabled={blocked || pending.has(key)} onChange={(e) => onToggle(id, d.id, d.name, e.target.checked, isLiveForward(fwd?.state))} />
                          <span className="min-w-0 break-words"><span className="font-bold">{d.name}</span> <span className="text-black/60">· {d.host}</span></span>
                        </label>
                        {onEdit ? <button type="button" className="shrink-0 text-[11px] text-black/50 underline underline-offset-2" onClick={() => onEdit(d.id)}>Edit</button> : null}
                      </div>
                      {d.activateAt ? <p className="pl-6 text-[11px] text-[#b45309]">Timer · {d.timerPath ?? "?"} · {fmtTimer(d.activateAt)}</p> : null}
                      {fwd ? <div className="flex flex-wrap items-center gap-1 pl-6">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${TONE[fwd.state] ?? "bg-black/5"}`}>{LABEL[fwd.state] ?? fwd.state}</span>
                        {(() => { const st = forwardStats(fwd); return st ? <span data-testid={`path-fwd-stats-${id}-${d.id}`} className={`text-[11px] ${fwd.state === "forwarding" ? "text-[#0f6b31]" : "text-[#8a4b06]"}`}>{st}</span> : null })()}
                      </div> : null}
                      {armed === key ? <p data-testid={`path-fwd-confirm-${id}-${d.id}`} role="alert" className="pl-6 text-[11px] font-bold text-[#b42318]">Stop this live forward? Untick again to confirm.</p> : null}
                      {fwd?.error && fwd.state !== "waiting" && fwd.state !== "forwarding" ? <p className="pl-6 text-[11px] text-[#8a1c13]">{fwd.error}</p> : null}
                      {blocked ? <p className="pl-6 text-[11px] font-bold text-[#8a4b06]">{reason}</p> : null}
                    </li>
                  )
                })}
              </ul>
              {adding === id ? (
                <div className="space-y-2 border-t border-black/10 pt-2">
                  <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-8 w-full rounded-lg border border-black/10 px-2 text-[12px]" />
                  <input placeholder="Server (rtmp://…)" value={form.server} onChange={(e) => setForm({ ...form, server: e.target.value })} className="h-8 w-full rounded-lg border border-black/10 px-2 text-[12px]" />
                  <input placeholder="Stream key" type="password" autoComplete="new-password" spellCheck={false} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} className="h-8 w-full rounded-lg border border-black/10 px-2 text-[12px]" />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void add(id)} className="rounded-full bg-black px-3 py-1 text-[12px] font-bold text-white">Save</button>
                    <button type="button" onClick={() => setAdding(null)} className="text-[12px] text-black/50">Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => { setAdding(id); setForm({ name: "", server: "", key: "" }) }} className="w-full rounded-xl border border-black/10 py-2 text-[12px] text-black/60">+ Add {id} destination</button>
              )}
            </div>
          )
        })}
      </div>
      {msg ? <p className={`font-mono text-[12px] ${msg.tone === "error" ? "font-bold text-[#b42318]" : "text-black/70"}`}>{msg.text}</p> : null}
    </div>
  )
}
