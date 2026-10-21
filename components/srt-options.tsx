"use client"
/**
 * Desk panel for the parallel SRS ingest (docker).
 *
 * Shows engaged/idle from a probe of the SRS HTTP port, and builds the SRT
 * (and HLS) links for the chosen latency. Not part of MediaMTX failover.
 */
import { useCallback, useEffect, useState } from "react"
import { copyOrShow } from "@/components/copy-fallback"

type Latency = "low" | "balanced" | "reliable"
const LATENCY_US: Record<Latency, number> = { low: 200000, balanced: 300000, reliable: 500000 }
const LATENCY_LABEL: Record<Latency, string> = { low: "Low (200 ms)", balanced: "Balanced (300 ms)", reliable: "Reliable (500 ms)" }

type SrsStatus = { engaged: boolean; host: string | null; note: string }

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
  // Probe the SRS HTTP port from the browser. CORS may block; a successful response means engaged.
  let engaged = false
  if (host) {
    const probe = await fetch(`http://${host}:8088/api/v1/summaries`, { mode: "no-cors" }).catch(() => null)
    // no-cors returns an opaque response if the port answers; a network error means not engaged.
    engaged = probe !== null
  }
  return { engaged, host, note: engaged ? "SRS docker is answering." : host ? "SRS not answering on :8088. Start the docker container." : (body?.note ?? "No LAN IP.") }
}

function Row({ label, value, testId }: { label: string; value: string | null; testId: string }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[12px]">
      <span className="w-14 shrink-0 text-black/50">{label}</span>
      <span data-testid={testId} className="min-w-0 flex-1 break-all">{value}</span>
      <button type="button" className="shrink-0 rounded-full border border-black/15 px-2.5 py-0.5 text-[11px] hover:bg-black/5" onClick={() => { void copyOrShow(label, value); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  )
}

export function SrtOptions() {
  const [status, setStatus] = useState<SrsStatus | null>(null)
  const [latency, setLatency] = useState<Latency>("balanced")
  const [key, setKey] = useState("backup2")
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    setStatus(await probeSrs())
    setBusy(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const host = status?.host
  const engaged = status?.engaged === true
  const latUs = LATENCY_US[latency]
  const srtUrl = host ? buildSrt(host, key.trim() || "backup2", latUs) : null
  const hlsUrl = host ? buildHls(host, key.trim() || "backup2") : null

  return (
    <div data-testid="srs-panel" className="space-y-3 rounded-xl border border-black/10 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[15px] font-bold">SRS (parallel)</p>
        <span data-testid="srs-engaged" data-engaged={engaged ? "yes" : "no"} className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ${
          engaged ? "bg-[#067647] text-white" : "bg-black/10 text-black/60"
        }`}>{engaged ? "Engaged" : "Idle"}</span>
      </div>
      <p className="font-mono text-[11px] text-black/60">Separate from MediaMTX. Does not join Main/Backup failover. Start the docker container for Engaged.</p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px]">
        <span className="text-black/60">Latency</span>
        {(["low", "balanced", "reliable"] as const).map((v) => (
          <label key={v} className="flex items-center gap-1.5">
            <input type="radio" name="srs-latency" data-testid={`srs-latency-${v}`} checked={latency === v} onChange={() => setLatency(v)} />
            {LATENCY_LABEL[v]}
          </label>
        ))}
      </div>

      <label className="block font-mono text-[12px] font-bold">Stream key
        <input data-testid="srs-key" className="mt-1 h-9 w-full rounded-lg border border-black/15 bg-white px-3 font-mono text-[13px]" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} />
      </label>

      {status ? <p className="font-mono text-[11px] text-black/50">{status.note}</p> : null}

      <div className="space-y-1.5">
        <Row label="SRT" value={srtUrl} testId="srs-srt" />
        <Row label="HLS" value={hlsUrl} testId="srs-hls" />
      </div>

      <button type="button" data-testid="srs-refresh" disabled={busy} className="rounded-lg border border-black/15 px-3 py-1.5 font-mono text-[12px] hover:bg-black/5 disabled:opacity-40" onClick={() => void refresh()}>
        {busy ? "Checking…" : "Refresh status"}
      </button>
    </div>
  )
}
