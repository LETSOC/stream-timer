import { spawn } from "node:child_process"
import net from "node:net"
import { programPublisherHosts } from "@/lib/relay"
import { srtLevel, logState, parsePingMs, pingArgs, rttLevel, rttStats, RTT_INTERVAL_MS, type RttMethod, type RttSample, type RttView } from "@/lib/rtt"

type Src = "main" | "backup"
type State = { protocol: "rtmp" | "srt" | null; srt: import("@/lib/rtt").SrtLink | null; host: string | null; via: "push" | "pull" | null; samples: RttSample[]; logged: string | null; icmpFails: number }
const KEY = Symbol.for("stream-timer.rtt-monitor")
type Holder = { [KEY]?: { timer: NodeJS.Timeout | null; summaryAt: number; src: Record<Src, State> } }
const fresh = (): State => ({ protocol: null, srt: null, host: null, via: null, samples: [], logged: null, icmpFails: 0 })
function mon() {
  const h = globalThis as Holder
  h[KEY] ??= { timer: null, summaryAt: Date.now(), src: { main: fresh(), backup: fresh() } }
  return h[KEY]
}
const LABEL: Record<Src, string> = { main: "Main", backup: "Backup" }
const log = (line: string) => console.log(`[rtt] ${line}`)

function icmp(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    let out = ""
    let child
    try { child = spawn("ping", pingArgs(host, process.platform), { stdio: ["ignore", "pipe", "ignore"] }) } catch { return resolve(null) }
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000)
    child.stdout.on("data", (d) => (out += d))
    child.on("error", () => { clearTimeout(kill); resolve(null) })
    child.on("close", () => { clearTimeout(kill); resolve(parsePingMs(out)) })
  })
}

/** TCP handshake time: a SYN answered by SYN-ACK *or* RST (refused) is one round trip. Filtered/timeout = no answer. */
function tcp(host: string, ports = [1935, 443, 80]): Promise<number | null> {
  const one = (port: number) => new Promise<number | null>((resolve) => {
    const t0 = process.hrtime.bigint()
    const s = net.connect({ host, port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok ? Number(process.hrtime.bigint() - t0) / 1e6 : null) }
    s.setTimeout(1000, () => done(false))
    s.once("connect", () => done(true))
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED"))
  })
  return ports.reduce<Promise<number | null>>((p, port) => p.then((v) => (v !== null ? v : one(port))), Promise.resolve(null))
}

/** ICMP first; after 2 ICMP misses in a row also try TCP (cloud/NAT often drops ping). */
async function measure(st: State, host: string): Promise<{ ms: number | null; method: RttMethod | null }> {
  const ms = await icmp(host)
  if (ms !== null) { st.icmpFails = 0; return { ms, method: "icmp" } }
  st.icmpFails += 1
  const t = await tcp(host)
  return t !== null ? { ms: Math.round(t * 10) / 10, method: "tcp" } : { ms: null, method: null }
}

export function rttView(src: Src, now = Date.now()): RttView {
  const st = mon().src[src]
  const s = rttStats(st.samples, now)
  const base = { host: st.host, via: st.via, method: s.method, lastMs: s.lastMs, avgMs: s.avgMs, maxMs: s.maxMs, lossPct: s.lossPct, samples: s.recent.length, protocol: st.protocol, srt: st.srt }
  // SRT: MediaMTX's own link stats (RTT, packet loss) instead of ping.
  if (st.srt) return { ...base, lossPct: st.srt.lossPct, level: st.host ? srtLevel(st.srt) : null }
  return { ...base, level: st.host ? rttLevel(s.lastMs, s.avgMs, s.lossPct, s.recent.length) : null }
}

async function tick() {
  const m = mon()
  const hosts = await programPublisherHosts()
  const now = Date.now()
  await Promise.all((["main", "backup"] as const).map(async (src) => {
    const st = m.src[src]
    const pub = hosts[src]
    if (!pub) {
      if (st.host) log(`${LABEL[src]}: publisher gone (${st.host})`)
      Object.assign(st, fresh())
      return
    }
    if (pub.host !== st.host) {
      log(`${LABEL[src]}: publisher ${pub.host} (${pub.via}${pub.protocol ? `, ${pub.protocol.toUpperCase()}` : ""})`)
      Object.assign(st, fresh(), { host: pub.host, via: pub.via })
    }
    st.protocol = pub.protocol ?? null
    st.srt = pub.srt ?? null
    const r = pub.srt ? { ms: pub.srt.rttMs, method: "srt" as const } : await measure(st, pub.host)
    st.samples.push({ at: Date.now(), ...r })
    st.samples = st.samples.filter((x) => now - x.at <= 65_000)
    const v = rttView(src)
    const state = logState(v.level)
    if (state && state !== st.logged) {
      log(`${LABEL[src]} ${pub.host}: ${st.logged ?? "start"} → ${state} (${v.lastMs === null ? "no reply" : `${v.method} ${v.lastMs}ms`}, loss ${v.lossPct}%)`)
      st.logged = state
    }
  }))
  if (now - m.summaryAt >= 60_000) {
    m.summaryAt = now
    for (const src of ["main", "backup"] as const) {
      const v = rttView(src)
      if (v.host && v.samples) log(`${LABEL[src]} ${v.host} 1m: avg ${v.avgMs ?? "–"}ms max ${v.maxMs ?? "–"}ms loss ${v.lossPct}% (${v.method ?? "no reply"}, ${v.samples} samples)`)
    }
  }
}

export function startRttMonitor() {
  const m = mon()
  if (m.timer) return
  let busy = false
  m.timer = setInterval(() => {
    if (busy) return
    busy = true
    void tick().catch(() => undefined).finally(() => (busy = false))
  }, RTT_INTERVAL_MS)
  m.timer.unref()
}
