/**
 * Per-source network RTT to each program publisher (pure parts). Samples every ~5s, 60s window.
 * ok / high (amber: >50ms or any loss) / bad (red: >150ms or loss >10%) / lost (no replies).
 */
export type RttMethod = "icmp" | "tcp"
export type RttSample = { at: number; ms: number | null; method: RttMethod | null }
export type RttLevel = "ok" | "high" | "bad" | "lost"
export type RttView = { host: string | null; via: "push" | "pull" | null; method: RttMethod | null; lastMs: number | null; avgMs: number | null; maxMs: number | null; lossPct: number; samples: number; level: RttLevel | null }

export const RTT_WINDOW_MS = 60_000
export const RTT_INTERVAL_MS = 5_000

/** "time=7.12 ms" (macOS/Linux iputils/busybox), "time<1 ms" → 0.5. */
export function parsePingMs(output: string): number | null {
  const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(output)
  if (!m) return null
  const v = Number(m[1])
  if (!Number.isFinite(v)) return null
  return /time</i.test(m[0]) ? v / 2 : v
}

export function pingArgs(host: string, platform: string): string[] {
  // -W: macOS = ms, Linux = s. -n: no DNS.
  return platform === "darwin" ? ["-n", "-c", "1", "-W", "1000", host] : ["-n", "-c", "1", "-W", "1", host]
}

export function rttStats(samples: RttSample[], now: number) {
  const recent = samples.filter((s) => now - s.at <= RTT_WINDOW_MS)
  const ok = recent.map((s) => s.ms).filter((v): v is number => v !== null)
  const lossPct = recent.length ? Math.round(((recent.length - ok.length) / recent.length) * 100) : 0
  const avgMs = ok.length ? Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 10) / 10 : null
  const maxMs = ok.length ? Math.round(Math.max(...ok) * 10) / 10 : null
  const last = recent.at(-1)
  return { recent, lossPct, avgMs, maxMs, lastMs: last?.ms ?? null, method: [...recent].reverse().find((s) => s.method)?.method ?? null }
}

export function rttLevel(lastMs: number | null, avgMs: number | null, lossPct: number, samples: number): RttLevel | null {
  if (!samples) return null
  if (avgMs === null) return "lost"
  const ms = Math.max(lastMs ?? 0, avgMs)
  if (ms > 150 || lossPct > 10) return "bad"
  if (ms > 50 || lossPct > 0) return "high"
  return "ok"
}

/** Card label: "ping 7ms · 0%" / "tcp 23ms · 8% loss" / "—". */
export function rttLabel(v: RttView | null | undefined): string {
  if (!v || !v.host || !v.samples) return "—"
  if (v.level === "lost") return `lost · ${v.lossPct}%`
  const ms = v.lastMs ?? v.avgMs
  return `${v.method === "tcp" ? "tcp" : "ping"} ${ms === null ? "–" : ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms${v.lossPct ? ` · ${v.lossPct}% loss` : ""}`
}

/** Log state names: ok / high / lost (high covers amber and red). */
export function logState(level: RttLevel | null): "ok" | "high" | "lost" | null {
  return level === null ? null : level === "lost" ? "lost" : level === "ok" ? "ok" : "high"
}
