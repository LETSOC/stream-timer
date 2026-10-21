"use client"
/**
 * Desk panel for the parallel SRS ingest (docker).
 *
 * Collapses to a pill (same shape as Local access). Expanded: latency choice
 * builds the SRT link, HLS is m3u8. Not part of MediaMTX failover.
 */
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { copyOrShow } from "@/components/copy-fallback"

type Latency = "low" | "balanced" | "reliable"
const LATENCY_US: Record<Latency, number> = { low: 200000, balanced: 300000, reliable: 500000 }
const LATENCY_SHORT: Record<Latency, string> = { low: "Low 200", balanced: "Balanced 300", reliable: "Reliable 500" }

type SrsStatus = { engaged: boolean; host: string | null; note: string }

const listeners = new Set<() => void>()
function usePref(key: string, fallback: string): [string, (v: string) => void] {
  const value = useSyncExternalStore((n) => { listeners.add(n); return () => { listeners.delete(n) } }, () => window.localStorage.getItem(key) ?? fallback, () => fallback)
  return [value, (v) => { window.localStorage.setItem(key, v); for (const n of listeners) n() }]
}

function buildSrt(host: string, key: string, latencyUs: number) {
  return `srt://${host}:10080?streamid=#!::r=live/${key},m=publish&latency=${latencyUs}`
}
function buildHls(host: string, key: string) {
  return `http://${host}:8088/live/${key}.m3u8`
}

async function probeSrs(): Promise<SrsStatus> {
  const r = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reveal-srs" }) }).catch(() => null)
  if (!r?.ok) return { engaged: false, host: null, note: "Could not reach the server." }
  const body = (await r.json().catch(() => null)) as { host?: string | null; note?: string } | null
  const host = body?.host ?? null
  let engaged = false
  if (host) {
    const probe = await fetch(`http://${host}:8088/api/v1/summaries`, { mode: "no-cors" }).catch(() => null)
    engaged = probe !== null
  }
  return { engaged, host, note: engaged ? "SRS docker is answering." : host ? "SRS not answering on :8088. Start the docker container." : (body?.note ?? "No LAN IP.") }
}

function Field({ label, value, testId, onCopy }: { label: string; value: string; testId: string; onCopy: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <p className="mb-1.5 font-mono text-[11px] tracking-[0.12em] text-black/50 uppercase">{label}</p>
      <div className="flex items-center gap-3 rounded-full bg-[#f1f0ec] py-2 pr-2 pl-5">
        <span data-testid={testId} className="min-w-0 flex-1 truncate font-mono text-[15px] font-semibold">{value}</span>
        <button type="button" aria-label={`Copy ${label}`} onClick={() => { onCopy(); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }} className="grid size-9 shrink-0 place-items-center rounded-full bg-white ring-1 ring-black/10">
          {copied ? <Check aria-hidden className="size-4 text-[#12b76a]" /> : <Copy aria-hidden className="size-4" />}
        </button>
      </div>
    </div>
  )
}

export function SrtOptions() {
  const [status, setStatus] = useState<SrsStatus | null>(null)
  const [latency, setLatency] = useState<Latency>("reliable")
  const [key, setKey] = useState("backup2")
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = usePref("srs-collapsed", "1")

  const refresh = useCallback(async () => {
    setBusy(true)
    setStatus(await probeSrs())
    setBusy(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const host = status?.host
  const engaged = status?.engaged === true
  const latUs = LATENCY_US[latency]
  const k = key.trim() || "backup2"
  const srtUrl = host ? buildSrt(host, k, latUs) : null
  const hlsUrl = host ? buildHls(host, k) : null
  const dot = engaged ? "bg-[#12b76a]" : "bg-[#98a2b3]"
  const short = engaged ? `10080 · ${LATENCY_SHORT[latency]}` : "Idle · start docker"

  if (collapsed === "1") {
    return (
      <button type="button" data-testid="srs-panel" data-collapsed="1" onClick={() => setCollapsed("0")} aria-expanded={false}
        className="flex w-full items-center gap-2.5 rounded-full bg-white px-4 py-3 text-left ring-1 ring-black/10 shadow-sm">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
        <span className="font-mono text-[12px] font-bold tracking-[0.16em] uppercase">SRS</span>
        <span data-testid="srs-short" className="min-w-0 flex-1 truncate font-mono text-[13px]">{short}</span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-black/50" />
      </button>
    )
  }

  return (
    <section data-testid="srs-panel" data-collapsed="0" aria-label="SRS" className="space-y-3 rounded-[22px] bg-white p-4 ring-1 ring-black/10 shadow-sm">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
        <h2 className="font-mono text-[12px] font-bold tracking-[0.16em] uppercase">SRS</h2>
        <span data-testid="srs-engaged" data-engaged={engaged ? "yes" : "no"} className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-bold tracking-[0.1em] ${
          engaged ? "bg-[#12b76a]/15 text-[#067647] ring-1 ring-[#12b76a]/30" : "bg-black/5 text-black/50"
        }`}>{engaged ? "ENGAGED" : "IDLE"}</span>
        <button type="button" data-testid="srs-refresh" disabled={busy} aria-label="Refresh" onClick={() => void refresh()} className="ml-auto grid size-8 place-items-center rounded-full text-black/50 hover:bg-[#f1f0ec] disabled:opacity-40">
          <span className={`font-mono text-[11px] ${busy ? "animate-pulse" : ""}`}>{busy ? "…" : "↻"}</span>
        </button>
        <button type="button" data-testid="srs-collapse" aria-label="Collapse" aria-expanded onClick={() => setCollapsed("1")} className="grid size-8 place-items-center rounded-full hover:bg-[#f1f0ec]">
          <ChevronUp aria-hidden className="size-4" />
        </button>
      </div>

      <div>
        <p className="mb-1.5 font-mono text-[11px] tracking-[0.12em] text-black/50 uppercase">Latency</p>
        <div role="radiogroup" aria-label="Latency" className="grid grid-cols-3 gap-1 rounded-full bg-[#f1f0ec] p-1">
          {(["low", "balanced", "reliable"] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={latency === v} data-testid={`srs-latency-${v}`} onClick={() => setLatency(v)}
              className={`min-h-10 rounded-full text-[14px] ${latency === v ? "bg-black font-semibold text-white" : "text-black/55"}`}>{LATENCY_SHORT[v]}</button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1.5 font-mono text-[11px] tracking-[0.12em] text-black/50 uppercase">Stream key</p>
        <div className="flex items-center gap-3 rounded-full bg-[#f1f0ec] py-2 pr-2 pl-5">
          <span className="font-mono text-[11px] tracking-[0.12em] text-black/50">KEY</span>
          <input data-testid="srs-key" className="min-w-0 flex-1 bg-transparent font-mono text-[15px] font-semibold outline-none" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
        </div>
      </div>

      {srtUrl ? <Field label="SRT for OBS" value={srtUrl} testId="srs-srt" onCopy={() => void copyOrShow("SRS SRT", srtUrl)} /> : null}
      {hlsUrl ? <Field label="HLS preview" value={hlsUrl} testId="srs-hls" onCopy={() => void copyOrShow("SRS HLS", hlsUrl)} /> : null}

      <p className="font-mono text-[11px] text-black/50">{status?.note ?? "Separate from MediaMTX. Does not join Main/Backup failover."}</p>
    </section>
  )
}
