"use client"
/** Desk + deck: the LAN URL another device on this Wi-Fi can open, with a scannable QR. IP is detected server-side (/api/ip). */
import { Check, ChevronDown, ChevronUp, Copy, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { copyOrShow, CopyFallbackHost } from "@/components/copy-fallback"
import { QrImage } from "@/components/qr-image"

type Info = { ip: string | null; port: number; base: string | null; boundToLan: boolean }
type View = "desk" | "deck"
const PATH: Record<View, string> = { desk: "/", deck: "/deck" }

const listeners = new Set<() => void>()
function usePref(key: string, fallback: string): [string, (v: string) => void] {
  const value = useSyncExternalStore((n) => { listeners.add(n); return () => { listeners.delete(n) } }, () => window.localStorage.getItem(key) ?? fallback, () => fallback)
  return [value, (v) => { window.localStorage.setItem(key, v); for (const n of listeners) n() }]
}

export function LocalAccessPill({ dark = false, className = "" }: { dark?: boolean; className?: string }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [ok, setOk] = useState<boolean | null>(null)
  const [spin, setSpin] = useState(false)
  const [copied, setCopied] = useState(false)
  const [collapsed, setCollapsed] = usePref("local-access-collapsed", "0")
  const [auto, setAuto] = usePref("local-access-auto", "1")
  const [view, setView] = usePref("local-access-view", dark ? "deck" : "desk")
  const v: View = view === "deck" ? "deck" : "desk"

  const load = useCallback(async () => {
    const r = await fetch("/api/ip", { cache: "no-store" }).catch(() => null)
    const body = r?.ok ? ((await r.json().catch(() => null)) as Info | null) : null
    setOk(Boolean(body?.base))
    if (body) setInfo((prev) => (prev && prev.base === body.base && prev.boundToLan === body.boundToLan ? prev : body))
  }, [])
  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0)
    if (auto !== "1") return () => window.clearTimeout(first)
    const id = window.setInterval(() => void load(), 10_000)
    return () => { window.clearTimeout(first); window.clearInterval(id) }
  }, [auto, load])

  const hostPort = info?.ip ? `${info.ip}:${info.port}` : null
  const url = info?.base ? `${info.base}${PATH[v] === "/" ? "/" : PATH[v]}` : null
  const shortUrl = hostPort ? `${hostPort}${PATH[v] === "/" ? "" : PATH[v]}` : "No network"
  const t = dark
    ? { card: "bg-white/5 text-white ring-1 ring-white/10", sub: "text-white/55", field: "bg-white/10", btn: "bg-white/10 text-white", seg: "bg-white/10", segOn: "bg-white text-black", segOff: "text-white/70", qrBox: "bg-white/5 ring-white/10", chip: "bg-white/10 text-white/85" }
    : { card: "bg-white text-black ring-1 ring-black/10 shadow-sm", sub: "text-black/50", field: "bg-[#f1f0ec]", btn: "bg-white text-black ring-1 ring-black/10", seg: "bg-[#f1f0ec]", segOn: "bg-black text-white", segOff: "text-black/55", qrBox: "bg-[#f7f6f2] ring-black/5", chip: "bg-[#f1f0ec] text-black/80" }
  const dot = ok === false ? "bg-[#f04438]" : ok ? "bg-[#12b76a]" : "bg-[#98a2b3]"
  const refresh = async () => { setSpin(true); await load(); window.setTimeout(() => setSpin(false), 400) }
  const copy = async () => { if (!url) return; await copyOrShow("Local URL", url); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }

  if (collapsed === "1") {
    return (
      <button type="button" data-testid="local-access" data-collapsed="1" onClick={() => setCollapsed("0")} aria-expanded={false}
        className={`flex w-full items-center gap-2.5 rounded-full px-4 py-3 text-left ${t.card} ${className}`}>
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
        <span className="font-mono text-[12px] font-bold tracking-[0.16em] uppercase">Local access</span>
        <span data-testid="local-access-short" className="min-w-0 flex-1 truncate font-mono text-[13px]">{shortUrl}</span>
        <ChevronDown aria-hidden className={`size-4 shrink-0 ${t.sub}`} />
      </button>
    )
  }
  return (
    <section data-testid="local-access" data-collapsed="0" data-url={url ?? ""} aria-label="Local access" className={`@container rounded-[22px] p-4 ${t.card} ${className}`}>
      <CopyFallbackHost />
      <div className="flex items-center gap-2.5">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
        <h2 className="font-mono text-[12px] font-bold tracking-[0.16em] uppercase">Local access</h2>
        {ok ? <span data-testid="local-access-live" className="rounded-full bg-[#12b76a]/15 px-2 py-0.5 font-mono text-[11px] font-bold tracking-[0.1em] text-[#12b76a] ring-1 ring-[#12b76a]/30">LIVE</span>
          : ok === false ? <span className="rounded-full bg-[#f04438]/15 px-2 py-0.5 font-mono text-[11px] font-bold tracking-[0.1em] text-[#f04438]">OFFLINE</span> : null}
        <label className={`ml-auto inline-flex cursor-pointer items-center gap-1 font-mono text-[11px] ${t.sub}`} title="Re-check the IP every 10s">
          <input type="checkbox" data-testid="local-access-auto" checked={auto === "1"} onChange={(e) => setAuto(e.target.checked ? "1" : "0")} className="size-3.5 accent-[#12b76a]" />Auto
        </label>
        <button type="button" data-testid="local-access-refresh" aria-label="Refresh IP" onClick={() => void refresh()} className="grid size-8 place-items-center rounded-full">
          <RefreshCw aria-hidden className={`size-4 ${spin ? "animate-spin" : ""}`} />
        </button>
        <button type="button" data-testid="local-access-collapse" aria-label="Collapse" aria-expanded onClick={() => setCollapsed("1")} className="grid size-8 place-items-center rounded-full">
          <ChevronUp aria-hidden className="size-4" />
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-3 @[560px]:flex-row @[560px]:items-start">
        <div className="min-w-0 flex-1 space-y-3">
          <div className={`flex items-center gap-3 rounded-full py-2 pr-2 pl-5 ${t.field}`}>
            <span className={`font-mono text-[11px] tracking-[0.12em] ${t.sub}`}>IP</span>
            <span data-testid="local-access-ip" className="min-w-0 flex-1 truncate font-mono text-[16px] font-semibold">{hostPort ?? (ok === null ? "Detecting…" : "No LAN address")}</span>
            <button type="button" data-testid="local-access-copy" aria-label="Copy URL" disabled={!url} onClick={() => void copy()} className={`grid size-9 shrink-0 place-items-center rounded-full disabled:opacity-40 ${t.btn}`}>
              {copied ? <Check aria-hidden className="size-4 text-[#12b76a]" /> : <Copy aria-hidden className="size-4" />}
            </button>
          </div>
          <div>
            <div className={`mb-1.5 flex justify-between font-mono text-[11px] tracking-[0.12em] uppercase ${t.sub}`}><span>View</span><span className="normal-case">{PATH[v]}</span></div>
            <div role="radiogroup" aria-label="View" className={`grid grid-cols-2 gap-1 rounded-full p-1 ${t.seg}`}>
              {(["desk", "deck"] as const).map((name) => (
                <button key={name} type="button" role="radio" aria-checked={v === name} data-testid={`local-access-view-${name}`} onClick={() => setView(name)}
                  className={`min-h-10 rounded-full text-[15px] capitalize ${v === name ? `${t.segOn} font-semibold` : t.segOff}`}>{name}</button>
              ))}
            </div>
          </div>
          {info && !info.boundToLan ? <p data-testid="local-access-bind" className="font-mono text-[11px] text-[#f79009]">Server is listening on this machine only: restart with BIND_HOST=0.0.0.0 so phones can reach it.</p> : null}
        </div>
        <div className={`flex flex-col items-center gap-3 rounded-2xl p-4 ring-1 @[560px]:shrink-0 ${t.qrBox}`}>
          {url ? <QrImage key={url} url={url} alt={`QR code: ${url}`} className="size-44 rounded-xl bg-white p-2 shadow-sm" /> : <div className="grid size-44 place-items-center rounded-xl bg-white/60 font-mono text-[12px] text-black/50">No address</div>}
          <span data-testid="local-access-url" className={`max-w-full truncate rounded-full px-3 py-1 font-mono text-[12px] ${t.chip}`}>{url ?? "—"}</span>
        </div>
      </div>
    </section>
  )
}
