"use client"
/** Phone /deck: LAN ingest server URLs (Bonjour name + IP) with Copy, and a QR code of the backup laptop's Server URL. */
import QRCode from "qrcode"
import { useEffect, useState } from "react"
import { CopyFallbackHost, copyOrShow } from "@/components/copy-fallback"

type Ingest = { lan: boolean; lanUrl: string | null; mdnsUrl?: string | null; mdns?: { state: string; name: string; conflictWith: string | null } }

export function LanIngestInfo() {
  const [ingest, setIngest] = useState<Ingest | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [showQr, setShowQr] = useState(false)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const body = (await (await fetch("/api/relay", { cache: "no-store" }).catch(() => null))?.json().catch(() => null)) as { ingest?: Ingest } | null
      if (!cancelled) setIngest(body?.ingest ?? null)
    }
    void load()
    const id = window.setInterval(() => void load(), 5000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])
  const server = ingest?.mdnsUrl ?? ingest?.lanUrl ?? null
  useEffect(() => {
    if (!server) return
    let cancelled = false
    void QRCode.toString(server, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then((svg) => { if (!cancelled) setQr(svg) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [server])
  if (!ingest?.lan) return null
  const row = (label: string, value: string, testid: string) => (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-white/50">{label}</span>
      <span data-testid={testid} className="min-w-0 flex-1 break-all">{value}</span>
      <button type="button" className="shrink-0 rounded-full border border-white/30 px-3 py-1 text-[13px]" onClick={() => void copyOrShow(`${label} server`, value)}>Copy</button>
    </div>
  )
  return (
    <div data-testid="deck-lan" className="col-span-2 mt-1 space-y-2 rounded-xl bg-white/5 p-3 font-mono text-[13px] text-white/85">
      <h2 className="font-mono text-[12px] tracking-[0.12em] text-white/60 uppercase">LAN ingest (second laptop)</h2>
      {ingest.mdnsUrl ? row("LAN", ingest.mdnsUrl, "deck-lan-mdns") : null}
      {ingest.lanUrl ? row(ingest.mdnsUrl ? "LAN IP" : "LAN", ingest.lanUrl, "deck-lan-ip") : null}
      {ingest.mdns?.state === "conflict" ? <p className="text-[#fdb022]">{ingest.mdns.name}.local is taken by {ingest.mdns.conflictWith ?? "another device"}: use the IP, or rename on the desk.</p> : null}
      <CopyFallbackHost />
      {server && qr && !showQr ? (
        <button type="button" data-testid="deck-lan-qr-show" onClick={() => setShowQr(true)} className="rounded-full border border-white/30 px-3 py-1 text-[13px]">Show QR</button>
      ) : null}
      {server && qr && showQr ? (
        <div className="flex items-center gap-3" onClick={() => setShowQr(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img data-testid="deck-lan-qr" alt={`QR: ${server}`} className="size-32 shrink-0 rounded bg-white p-1" src={`data:image/svg+xml;utf8,${encodeURIComponent(qr)}`} />
          <p className="text-white/60">Backup OBS › Settings › Stream › Server: scan or type this. Stream key: reveal it on the desk (keys never shown here).</p>
        </div>
      ) : null}
    </div>
  )
}
