"use client"

import { useEffect, useState } from "react"
import { copyOrShow } from "@/components/copy-fallback"
import type { AvLive, AvSample } from "@/lib/av-diagnostics"
import type { MediamtxPathStat } from "@/lib/relay"

type Diag = { lanIp?: string | null; serverNow: number; live: AvLive; mediamtx: { api: "on" | "off"; url: string | null; paths: MediamtxPathStat[] }; samples: AvSample[]; count: number }

const ms = (v: number | null | undefined) => (typeof v === "number" ? `${v} ms` : "—")
const mb = (b: number | null) => (b === null ? "—" : b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`)

/** Desk › A/V diagnostics: read-only numbers, STREAM timecode toggle, Mark → data/av-log.jsonl, CSV, MediaMTX stats. */
export function AvDiagnosticsPanel({ streamTimecode, fps }: { streamTimecode: boolean; fps: number }) {
  const [diag, setDiag] = useState<Diag | null>(null)
  const [reading, setReading] = useState("")
  const [note, setNote] = useState("")
  const [audioOff, setAudioOff] = useState("")
  const [msg, setMsg] = useState("")
  const [tc, setTc] = useState<{ on: boolean; fps: number } | null>(null)
  // The synced value changed (another desk or the save came back): drop the optimistic copy.
  const [seenProp, setSeenProp] = useState(`${streamTimecode}:${fps}`)
  if (seenProp !== `${streamTimecode}:${fps}`) { setSeenProp(`${streamTimecode}:${fps}`); setTc(null) }
  const tcOn = tc?.on ?? streamTimecode
  const tcFps = tc?.fps ?? fps
  useEffect(() => {
    let alive = true
    const load = () => void fetch("/api/av-diagnostics", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((b: Diag | null) => { if (alive && b) setDiag(b) }).catch(() => undefined)
    load()
    const id = window.setInterval(load, 1000)
    return () => { alive = false; window.clearInterval(id) }
  }, [])

  async function setTimecode(patch: { show?: boolean; fps?: number }) {
    setTc({ on: patch.show ?? tcOn, fps: patch.fps ?? tcFps })
    const r = await fetch("/api/deck/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: { type: "timecode", ...patch }, from: "desk" }) }).catch(() => null)
    if (!r?.ok) { setTc(null); setMsg("Could not change the STREAM timecode.") }
  }
  async function post(body: Record<string, unknown>) {
    const r = await fetch("/api/av-diagnostics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null)
    return r?.ok ? ((await r.json()) as { sample?: AvSample; count?: number; archived?: string | null }) : null
  }
  async function mark() {
    const out = await post({ action: "mark", readingMs: reading, audioOffsetMs: audioOff, note })
    if (!out) return setMsg("Mark failed.")
    setMsg(`Marked #${out.count} at ${new Date(out.sample!.at).toLocaleTimeString()}`)
    setReading("")
    setAudioOff("")
    setNote("")
  }

  const l = diag?.live
  const row = "flex justify-between gap-2 border-b border-black/5 py-1 font-mono text-[13px]"
  return (
    <div className="grid gap-4" data-testid="av-diagnostics">
      <p className="font-mono text-[12px] text-black/70">Read-only. Nothing here changes sync. See docs/av-timecode.md for the TC1–TC4 drift test.</p>

      <div className="grid gap-2 rounded-xl border border-black/15 p-3">
        <p className="font-mono text-[12px] tracking-[0.12em] text-black/60 uppercase">Timecodes</p>
        <label className="flex items-center gap-2 font-mono text-[13px] text-black/80">
          <input type="checkbox" data-testid="tc-stream-toggle" className="size-4 accent-black" checked={tcOn} onChange={(e) => void setTimecode({ show: e.target.checked })} />
          Show STREAM timecode on /stream (TC2)
        </label>
        <label className="flex items-center gap-2 font-mono text-[13px] text-black/80">fps
          <select data-testid="tc-stream-fps" className="h-8 rounded-lg border border-black/10 px-2" value={tcFps} onChange={(e) => void setTimecode({ fps: Number(e.target.value) })}>
            {[25, 30, 50, 60].map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <TcUrls fps={tcFps} lanIp={diag?.lanIp ?? null} />
        <p className="font-mono text-[12px] text-black/60">TC1 “OBS SRC” = OBS Browser Source <code>/overlay/timecode?fps={tcFps}</code> (1920×1080, bottom-right). STREAM sits just left of it, so both read side by side on YouTube. STREAM − OBS SRC = chain delay.</p>
      </div>

      <div className="rounded-xl border border-black/15 p-3" data-testid="av-live">
        <p className="mb-1 font-mono text-[12px] tracking-[0.12em] text-black/60 uppercase">Live (Browser capture {l?.mixing ? `· mixing ${l.source}` : "· not mixing program"})</p>
        <div className={row}><span>/stream player latency</span><b>{ms(l?.playerLatencyMs)}</b></div>
        <div className={row}><span>Adaptive program audio delay</span><b>{ms(l?.audioDelayMs)}</b></div>
        <div className={row}><span>Auto input offset ({l?.source ?? "main"})</span><b>{ms(l?.autoOffsetMs)}</b></div>
        <div className={row}><span>Manual A/V offset</span><b>{ms(l?.avOffsetMs)}</b></div>
        <div className={row}><span>Manual program offset ({l?.source ?? "main"})</span><b>{ms(l?.programOffsetMs)}</b></div>
        <div className={row}><span>Jitter</span><b>{ms(l?.jitterMs)}</b></div>
      </div>

      <div className="grid gap-2 rounded-xl border border-black/15 p-3">
        <p className="font-mono text-[12px] tracking-[0.12em] text-black/60 uppercase">Drift log ({diag?.count ?? 0} samples · data/av-log.jsonl)</p>
        <div className="grid grid-cols-[1fr_1fr_2fr] gap-2">
          <input data-testid="av-reading" inputMode="numeric" placeholder="STREAM − OBS SRC ms" className="h-9 rounded-xl border border-black/10 bg-[#F6F6F3] px-3 text-sm" value={reading} onChange={(e) => setReading(e.target.value)} />
          <input data-testid="av-audio-offset" inputMode="numeric" placeholder="Audio offset ms (+ = late)" className="h-9 rounded-xl border border-black/10 bg-[#F6F6F3] px-3 text-sm" value={audioOff} onChange={(e) => setAudioOff(e.target.value)} />
          <input data-testid="av-note" placeholder="Note (e.g. YouTube phone, TC4 +6.2s)" className="h-9 rounded-xl border border-black/10 bg-[#F6F6F3] px-3 text-sm" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="av-mark" className="rounded-full bg-black px-4 py-2 font-mono text-[12px] text-white" onClick={() => void mark()}>Mark</button>
          <a data-testid="av-csv" href="/api/av-diagnostics?format=csv" className="rounded-full border border-black/30 px-4 py-2 font-mono text-[12px] text-black no-underline">Download CSV</a>
          <button type="button" className="rounded-full border border-black/30 px-4 py-2 font-mono text-[12px]" onClick={() => void post({ action: "new" }).then((o) => setMsg(o?.archived ? `Started a new log (old one kept as ${o.archived})` : "Log was already empty"))}>New test (archive log)</button>
        </div>
        {msg ? <p data-testid="av-msg" className="font-mono text-[12px] text-black/70">{msg}</p> : null}
        {diag?.samples.length ? (
          <table className="w-full font-mono text-[11px]">
            <thead><tr className="text-left text-black/60"><th>Time</th><th>Player</th><th>Delay</th><th>Offs</th><th>Reading</th><th>Audio</th><th>Note</th></tr></thead>
            <tbody>
              {diag.samples.slice(-8).reverse().map((s) => (
                <tr key={s.at}><td>{new Date(s.at).toLocaleTimeString()}</td><td>{s.playerLatencyMs ?? "—"}</td><td>{s.audioDelayMs ?? "—"}</td><td>{s.avOffsetMs + s.programOffsetMs}</td><td>{s.readingMs ?? "—"}</td><td>{s.audioOffsetMs ?? "—"}</td><td className="truncate">{s.note}</td></tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="rounded-xl border border-black/15 p-3" data-testid="av-mediamtx">
        <p className="mb-1 font-mono text-[12px] tracking-[0.12em] text-black/60 uppercase">MediaMTX (TC3) {diag?.mediamtx.api === "on" ? `· ${diag.mediamtx.url}` : ""}</p>
        {!diag ? <p className="font-mono text-[12px]">Loading…</p> : diag.mediamtx.api === "off" ? (
          <p data-testid="av-mediamtx-off" className="font-mono text-[12px] text-black/70">API off or unreachable. Our relay starts MediaMTX with its API on 127.0.0.1:{"{RELAY_API_PORT, default 19997}"}: start the relay (Encoder › Relay). For another MediaMTX set <code>api: yes</code> (apiAddress :9997) in its mediamtx.yml and start the app with <code>MEDIAMTX_API_URL=http://127.0.0.1:9997</code>.</p>
        ) : diag.mediamtx.paths.length ? (
          <table className="w-full font-mono text-[12px]">
            <thead><tr className="text-left text-black/60"><th>Path</th><th>Ready</th><th>In</th><th>Out</th><th>Readers</th><th>Tracks</th></tr></thead>
            <tbody>{diag.mediamtx.paths.map((p) => <tr key={p.name}><td>{p.name}</td><td>{p.ready ? "yes" : "no"}</td><td>{mb(p.bytesReceived)}</td><td>{mb(p.bytesSent)}</td><td>{p.readers}</td><td>{p.tracks.join(", ") || "—"}</td></tr>)}</tbody>
          </table>
        ) : <p className="font-mono text-[12px]">API on, no paths yet.</p>}
      </div>
    </div>
  )
}

/** OBS URLs for TC1 main (computer 1, this Mac) and backup (computer 2, over the LAN). */
function TcUrls({ fps, lanIp }: { fps: number; lanIp: string | null }) {
  const [copied, setCopied] = useState<string | null>(null)
  const port = typeof window === "undefined" ? "43211" : window.location.port || "43211"
  const lan = lanIp ? `http://${lanIp}:${port}` : null
  const items = [
    { id: "main", label: "OBS computer 1 · OBS SRC", url: `http://127.0.0.1:${port}/overlay/timecode?fps=${fps}&beep=1`, hint: "This Mac (bottom-right, white)." },
    { id: "backup", label: "OBS computer 2 · BACKUP SRC", url: `${lan ?? `http://<this-mac-LAN-IP>:${port}`}/overlay/timecode/backup?fps=${fps}&beep=1`, hint: lan ? `Over the LAN (${lanIp}); start the app with BIND_HOST=0.0.0.0. Bottom-left, amber.` : "LAN IP not found: use this Mac's LAN IP and BIND_HOST=0.0.0.0." },
  ]
  const copy = async (id: string, url: string) => {
    if ((await copyOrShow("Timecode OBS URL", url)) !== "copied") return
    setCopied(id)
    window.setTimeout(() => setCopied(null), 1600)
  }
  return (
    <div className="grid gap-2" data-testid="tc-urls">
      {items.map((i) => (
        <div key={i.id} className="grid gap-1 font-mono text-[12px]">
          <span className="font-bold">{i.label}</span>
          <div className="flex items-center gap-2">
            <code data-testid={`tc-url-${i.id}`} className="min-w-0 flex-1 truncate rounded-lg bg-[#F6F6F3] px-2 py-1">{i.url}</code>
            <button type="button" data-testid={`tc-copy-${i.id}`} className="shrink-0 rounded-full bg-black px-3 py-1 text-white" onClick={() => void copy(i.id, i.url)}>{copied === i.id ? "Copied" : "Copy"}</button>
          </div>
          <span className="text-black/60">{i.hint}</span>
        </div>
      ))}
    </div>
  )
}
