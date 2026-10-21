"use client"
/**
 * Desk panel: copyable SRT URLs for Main and Backup (MediaMTX, port 8890)
 * and the parallel SRS option (docker, port 10080).
 *
 * SRT is better on Wi-Fi — it retransmits inside the latency window instead of
 * dropping frames the way RTMP does. RTMP stays available for both feeds.
 */
import { useState } from "react"
import { copyOrShow } from "@/components/copy-fallback"

type SrtReveal = { url: string | null; lan: boolean; port: number; note: string }
type SrsOption = { host: string | null; rtmpServer: string | null; rtmpKey: string; srtUrl: string | null; flv: string | null; note: string }

async function reveal(action: string): Promise<SrtReveal | SrsOption | null> {
  const r = await fetch("/api/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null)
  if (!r?.ok) return null
  return (await r.json().catch(() => null)) as SrtReveal | SrsOption | null
}

function Row({ label, value, testId }: { label: string; value: string | null; testId: string }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[12px]">
      <span className="shrink-0 text-black/60">{label}</span>
      <span data-testid={testId} className="min-w-0 break-all">{value}</span>
      <button type="button" className="shrink-0 rounded border border-black/15 px-2 py-0.5 text-[11px] hover:bg-black/5" onClick={() => { void copyOrShow(label, value); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  )
}

export function SrtOptions() {
  const [main, setMain] = useState<SrtReveal | null>(null)
  const [backup, setBackup] = useState<SrtReveal | null>(null)
  const [srs, setSrs] = useState<SrsOption | null>(null)
  const [busy, setBusy] = useState(false)

  async function load(which: "main" | "backup" | "srs") {
    setBusy(true)
    const action = which === "main" ? "reveal-program-srt" : which === "backup" ? "reveal-backup-srt" : "reveal-srs"
    const body = await reveal(action)
    if (which === "main") setMain(body as SrtReveal)
    else if (which === "backup") setBackup(body as SrtReveal)
    else setSrs(body as SrsOption)
    setBusy(false)
  }

  return (
    <div data-testid="srt-options" className="space-y-3 rounded-xl border border-black/10 bg-white p-3">
      <p className="text-[14px] font-bold">SRT for OBS (better on Wi-Fi)</p>
      <p className="font-mono text-[11px] text-black/60">SRT retransmits lost packets inside its latency window, so short Wi-Fi drops don't stall the stream. RTMP stays available. Paste the SRT URL as the OBS Server and leave the Stream Key blank.</p>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] font-bold">Main</span>
          <button type="button" data-testid="srt-main-reveal" disabled={busy} className="rounded border border-black/15 px-2 py-0.5 font-mono text-[11px] hover:bg-black/5 disabled:opacity-40" onClick={() => void load("main")}>Reveal SRT</button>
        </div>
        {main ? (main.url ? <Row label="SRT" value={main.url} testId="srt-main-url" /> : <p className="font-mono text-[11px] text-black/50">{main.note}</p>) : null}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] font-bold">Backup</span>
          <button type="button" data-testid="srt-backup-reveal" disabled={busy} className="rounded border border-black/15 px-2 py-0.5 font-mono text-[11px] hover:bg-black/5 disabled:opacity-40" onClick={() => void load("backup")}>Reveal SRT</button>
        </div>
        {backup ? (backup.url ? <Row label="SRT" value={backup.url} testId="srt-backup-url" /> : <p className="font-mono text-[11px] text-black/50">{backup.note}</p>) : null}
      </div>

      <div className="space-y-1.5 border-t border-black/10 pt-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] font-bold">SRS (parallel)</span>
          <button type="button" data-testid="srt-srs-reveal" disabled={busy} className="rounded border border-black/15 px-2 py-0.5 font-mono text-[11px] hover:bg-black/5 disabled:opacity-40" onClick={() => void load("srs")}>Show URLs</button>
        </div>
        {srs ? (
          <div className="space-y-1">
            <p className="font-mono text-[11px] text-black/50">{srs.note}</p>
            <Row label="RTMP" value={srs.rtmpServer} testId="srs-rtmp" />
            <Row label="Key" value={srs.rtmpKey} testId="srs-key" />
            <Row label="SRT" value={srs.srtUrl} testId="srs-srt" />
            <Row label="Preview" value={srs.flv} testId="srs-flv" />
          </div>
        ) : null}
      </div>
    </div>
  )
}
