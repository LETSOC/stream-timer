"use client"

import { useCallback, useEffect, useState } from "react"
import { ConfirmButton } from "@/components/confirm-button"
import { joinRtmpServerAndKey } from "@/lib/rtmp-join"
import { handleUnauthorized } from "@/lib/use-operator"

type Dest = { id: string; name: string; host: string; activateAt?: number | null; timerPath?: "slate" | "capture" | "vertical" | null }
type Fwd = { destId: string; state: string; reconnects?: number; health?: { fps?: number | null; kbps?: number | null; speed?: number | null }; error?: string | null }
type PathInfo = { ready: boolean; tracks: string[]; forwards: Fwd[]; available?: { destId: string; reason: string }[] }

const TONE: Record<string, string> = { forwarding: "bg-[#128a3e] text-white", connecting: "bg-[#b45309] text-white", retrying: "bg-[#b45309] text-white", waiting: "bg-black/5 text-black/70", stalled: "bg-[#d93200] text-white", blocked: "bg-[#d93200] text-white" }
const LABEL: Record<string, string> = { forwarding: "Forwarding", connecting: "Connecting", retrying: "Retrying", waiting: "Waiting", stalled: "Stalled", blocked: "Blocked" }

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

  const tick = async (path: string, id: string, on: boolean) => {
    const key = `${path}:${id}`
    setPending((s) => new Set(s).add(key))
    await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "forward", path, destinationId: id, on }) }).catch(() => null)
    setPending((s) => { const n = new Set(s); n.delete(key); return n })
    void load()
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
                          <input type="checkbox" className="mt-0.5 shrink-0" checked={on} disabled={blocked || pending.has(key)} onChange={(e) => void tick(id, d.id, e.target.checked)} />
                          <span className="min-w-0 break-words"><span className="font-bold">{d.name}</span> <span className="text-black/60">· {d.host}</span></span>
                        </label>
                        {onEdit ? <button type="button" className="shrink-0 text-[11px] text-black/50 underline underline-offset-2" onClick={() => onEdit(d.id)}>Edit</button> : null}
                      </div>
                      {d.activateAt ? <p className="pl-6 text-[11px] text-[#b45309]">Timer · {d.timerPath ?? "?"} · {fmtTimer(d.activateAt)}</p> : null}
                      {fwd ? <div className="flex flex-wrap items-center gap-1 pl-6">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${TONE[fwd.state] ?? "bg-black/5"}`}>{LABEL[fwd.state] ?? fwd.state}</span>
                        {fwd.health?.fps != null ? <span className="text-[11px] text-[#0f6b31]">{fwd.health.fps.toFixed(1)} fps · {fwd.health.kbps}k</span> : null}
                      </div> : null}
                      {fwd?.error && fwd.state !== "waiting" ? <p className="pl-6 text-[11px] text-[#8a1c13]">{fwd.error}</p> : null}
                      {blocked ? <p className="pl-6 text-[11px] font-bold text-[#8a4b06]">{reason}</p> : null}
                    </li>
                  )
                })}
              </ul>
              {adding === id ? (
                <div className="space-y-2 border-t border-black/10 pt-2">
                  <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-8 w-full rounded-lg border border-black/10 px-2 text-[12px]" />
                  <input placeholder="Server (rtmp://…)" value={form.server} onChange={(e) => setForm({ ...form, server: e.target.value })} className="h-8 w-full rounded-lg border border-black/10 px-2 text-[12px]" />
                  <input placeholder="Stream key" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} className="h-8 w-full rounded-lg border border-black/10 px-2 text-[12px]" />
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
