/**
 * Content-based A/V offset (flash + beep), read-only. One short ffmpeg decode of /capture (the output
 * probe's single reader, never alongside the packet probe): per-frame mean luma and 5ms 1 kHz-band RMS.
 * A flash onset (luma jumps up) is paired with the nearest beep onset (1 kHz level jumps up) within
 * ±500ms; the median of (beep − flash) is the offset: + = audio late. Nothing found = no result (silent).
 * Sources: the desk's A/V sync test (page flash + feeder beep: the capture chain only) or a flash+beep
 * clapper clip played in OBS (the whole input chain of that OBS).
 */
export const AV_READ_S = 4
export const PAIR_WINDOW_MS = 500

export function avDecodeArgs(url: string): string[] {
  return ["-hide_banner", "-nostats", "-loglevel", "info", "-rw_timeout", "5000000", "-i", url, "-t", String(AV_READ_S),
    "-filter_complex",
    "[0:v:0]scale=32:18,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG[v];" +
    "[0:a:0]bandpass=f=1000:width_type=q:w=4,asetnsamples=n=240:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level[a]",
    "-map", "[v]", "-map", "[a]", "-f", "null", "-"]
}

export type Sample = { t: number; v: number }
/** Pure: ffmpeg metadata=print / ametadata=print log lines → luma samples and audio RMS (dB) samples. */
export function parseAvMetadata(text: string): { luma: Sample[]; rms: Sample[] } {
  const luma: Sample[] = []
  const rms: Sample[] = []
  const pending: Record<string, number | undefined> = {}
  for (const line of text.split("\n")) {
    const m = /\[Parsed_(a?)metadata_\d+ @ [^\]]+\]\s*(.*)$/.exec(line)
    if (!m) continue
    const kind = m[1] === "a" ? "a" : "v"
    const body = m[2]
    const pt = /pts_time:(-?[\d.]+)/.exec(body)
    if (pt) { pending[kind] = Number(pt[1]); continue }
    const kv = /^lavfi\.(signalstats\.YAVG|astats\.Overall\.RMS_level)=(.+)$/.exec(body.trim())
    const t = pending[kind]
    if (!kv || t === undefined) continue
    const raw = kv[2].trim()
    const val = raw === "-inf" ? -120 : Number(raw)
    if (!Number.isFinite(val)) continue
    ;(kind === "v" ? luma : rms).push({ t, v: val })
    pending[kind] = undefined
  }
  return { luma, rms }
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }
export const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2 }

/** Rising edges: samples above the midpoint after at least minQuietS below it. Needs a real swing (minSwing). */
export function onsets(samples: Sample[], minSwing: number, minQuietS: number): number[] {
  if (samples.length < 3) return []
  const vals = samples.map((s) => s.v)
  const lo = pct(vals, 0.2)
  const hi = Math.max(...vals)
  if (!(hi - lo >= minSwing)) return []
  const mid = (lo + hi) / 2
  const out: number[] = []
  let quietSince: number | null = null
  for (const s of samples) {
    if (s.v < mid) { quietSince ??= s.t; continue }
    if (quietSince !== null && s.t - quietSince >= minQuietS) out.push(s.t)
    quietSince = null
  }
  return out
}

export type AvOffset = { offsetMs: number; pairs: number; spreadMs: number }
/** Pure: flash/beep onsets → median offset (+ = audio late), or null without at least 2 pairs. */
export function avOffset(luma: Sample[], rms: Sample[]): AvOffset | null {
  const flashes = onsets(luma, 60, 0.3) // sync flash: near-white over the page, 200ms of every second
  const beeps = onsets(rms, 25, 0.3) // 1 kHz band: 100ms beep vs silence/bed
  const d: number[] = []
  for (const f of flashes) {
    let best: number | null = null
    for (const b of beeps) { const x = (b - f) * 1000; if (Math.abs(x) <= PAIR_WINDOW_MS && (best === null || Math.abs(x) < Math.abs(best))) best = x }
    if (best !== null) d.push(best)
  }
  if (d.length < 2) return null
  return { offsetMs: Math.round(median(d)), pairs: d.length, spreadMs: Math.round(Math.max(...d) - Math.min(...d)) }
}

/** Dropout line for a content offset. */
export function avOffsetLine(r: AvOffset, tag: string, why: string): string {
  const s = r.offsetMs
  return `A/V offset ${s >= 0 ? "+" : ""}${s}ms (${s >= 0 ? "audio late" : "audio early"}) · ${tag} · ${r.pairs} flash/beep pairs, spread ${r.spreadMs}ms · ${why}`
}
