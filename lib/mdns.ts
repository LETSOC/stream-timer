/**
 * mDNS / Bonjour for LAN ingest: while "Accept program ingest from LAN" is on (and the program input
 * armed) the second laptop can use rtmp://<name>.local:19350/ instead of an IP that changes with DHCP.
 * Publishes an A record <name>.local → current LAN IP and an _rtmp._tcp service on the ingest port.
 *
 * Backends: macOS → `dns-sd -P` (mDNSResponder owns port 5353 there; it also handles probing/renames).
 * Elsewhere (or MDNS_BACKEND=js) → a small multicast-dns responder in this process.
 * Before publishing, a 1s probe asks the network for <name>.local; an answer from another machine is a
 * name conflict: we don't publish (no hijacking) and the desk warns.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import os from "node:os"
import makeMdns from "multicast-dns"

export const DEFAULT_MDNS_NAME = "hyphen-stream"
export type MdnsConfig = { name: string; ip: string; port: number }
export type MdnsState = { state: "off" | "probing" | "active" | "conflict" | "error"; name: string; host: string | null; ip: string | null; backend: "dns-sd" | "js" | null; conflictWith: string | null; error: string | null }

/** Pure: a DNS label we accept for <name>.local (lowercase letters, digits, hyphens; 1-63, no edge hyphen). */
export function cleanMdnsName(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const name = raw.trim().toLowerCase().replace(/\.local\.?$/, "")
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? name : null
}
export const mdnsHost = (name: string) => `${name}.local`
export const serviceType = "_rtmp._tcp.local"
export const instanceName = (name: string) => `${name}.${serviceType}`

type Answer = { name: string; type: string; ttl?: number; data: unknown; flush?: boolean }
/** Pure: records answering one question (empty = not ours). ttl 0 = goodbye. */
export function answersFor(cfg: MdnsConfig, q: { name: string; type: string }, ttl = 120): Answer[] {
  const host = mdnsHost(cfg.name)
  const inst = instanceName(cfg.name)
  const a: Answer = { name: host, type: "A", ttl, flush: true, data: cfg.ip }
  const srv: Answer = { name: inst, type: "SRV", ttl, flush: true, data: { port: cfg.port, weight: 0, priority: 0, target: host } }
  const txt: Answer = { name: inst, type: "TXT", ttl, flush: true, data: ["path=/program", "app=stream-timer"] }
  const ptr: Answer = { name: serviceType, type: "PTR", ttl, data: inst }
  const qn = q.name.toLowerCase()
  if (qn === host && (q.type === "A" || q.type === "ANY")) return [a]
  if (qn === serviceType && (q.type === "PTR" || q.type === "ANY")) return [ptr, srv, txt, a]
  if (qn === "_services._dns-sd._udp.local" && q.type === "PTR") return [{ name: qn, type: "PTR", ttl, data: serviceType }]
  if (qn === inst && (q.type === "SRV" || q.type === "ANY")) return [srv, a]
  if (qn === inst && q.type === "TXT") return [txt]
  return []
}
export function allRecords(cfg: MdnsConfig, ttl = 120): Answer[] {
  return answersFor(cfg, { name: serviceType, type: "PTR" }, ttl)
}

/** Pure: does a response show someone else owns <name>.local? Returns their IP. */
export function conflictFrom(answers: { name: string; type: string; data: unknown }[], name: string, ownIps: string[]): string | null {
  for (const r of answers) if (r.type === "A" && r.name.toLowerCase() === mdnsHost(name) && typeof r.data === "string" && !ownIps.includes(r.data)) return r.data
  return null
}
export function ownIps(): string[] {
  return Object.values(os.networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address))
}

// ---------- runtime (singleton on globalThis: server.ts and Next's bundle share it) ----------
type Runtime = { cfg: MdnsConfig | null; status: MdnsState; responder: ReturnType<typeof makeMdns> | null; child: ChildProcess | null; gen: number }
const KEY = Symbol.for("stream-timer.mdns")
function rt(): Runtime {
  const g = globalThis as { [KEY]?: Runtime }
  return (g[KEY] ??= { cfg: null, status: offState(DEFAULT_MDNS_NAME), responder: null, child: null, gen: 0 })
}
function offState(name: string): MdnsState {
  return { state: "off", name, host: null, ip: null, backend: null, conflictWith: null, error: null }
}
export function mdnsStatus(): MdnsState {
  return rt().status
}
function pickBackend(): "dns-sd" | "js" {
  if (process.env.MDNS_BACKEND === "js") return "js"
  if (process.env.MDNS_BACKEND === "dns-sd") return "dns-sd"
  return process.platform === "darwin" && spawnSync("which", ["dns-sd"]).status === 0 ? "dns-sd" : "js"
}

function probe(name: string, ms = 1000): Promise<string | null> {
  return new Promise((resolve) => {
    let m: ReturnType<typeof makeMdns>
    try { m = makeMdns({ reuseAddr: true }) } catch { resolve(null); return }
    const mine = ownIps()
    let found: string | null = null
    m.on("response", (res: { answers: Answer[]; additionals?: Answer[] }) => { found ??= conflictFrom([...res.answers, ...(res.additionals ?? [])], name, mine) })
    m.on("error", () => undefined)
    m.query([{ name: mdnsHost(name), type: "A" }])
    setTimeout(() => m.query([{ name: mdnsHost(name), type: "A" }]), 300)
    setTimeout(() => { try { m.destroy() } catch { /* */ } resolve(found) }, ms)
  })
}

function teardown(r: Runtime) {
  if (r.responder && r.cfg) {
    try { r.responder.respond({ answers: allRecords(r.cfg, 0) as never }) } catch { /* goodbye best effort */ }
    const old = r.responder
    setTimeout(() => { try { old.destroy() } catch { /* */ } }, 100)
  }
  r.responder = null
  if (r.child) { r.child.kill("SIGTERM"); r.child = null }
}

/** Make the advertisement match `want` (null = stop). Cheap to call every monitor tick. */
export async function syncMdns(want: MdnsConfig | null, nameIfOff = DEFAULT_MDNS_NAME): Promise<void> {
  const r = rt()
  const same = want && r.cfg && want.name === r.cfg.name && want.ip === r.cfg.ip && want.port === r.cfg.port
  if (same) return
  if (!want) {
    if (r.cfg || r.status.state !== "off") { teardown(r); r.cfg = null; r.gen++; r.status = offState(nameIfOff) }
    else r.status.name = nameIfOff
    return
  }
  // Name/IP/port changed (or first start): re-probe and re-publish.
  teardown(r)
  r.cfg = want
  const gen = ++r.gen
  const backend = pickBackend()
  r.status = { state: "probing", name: want.name, host: mdnsHost(want.name), ip: want.ip, backend, conflictWith: null, error: null }
  const other = await probe(want.name)
  if (gen !== r.gen) return
  if (other) {
    r.status = { ...r.status, state: "conflict", conflictWith: other }
    console.log(`[mdns] ${mdnsHost(want.name)} is already used by ${other}: not advertising (pick another name)`)
    return
  }
  try {
    if (backend === "dns-sd") {
      // dns-sd -P <instance> <type> <domain> <port> <host> <ip> [txt...]: registers the service and proxies the A record.
      const child = spawn("dns-sd", ["-P", want.name, "_rtmp._tcp", "local", String(want.port), mdnsHost(want.name), want.ip, "path=/program", "app=stream-timer"], { stdio: ["ignore", "pipe", "pipe"] })
      r.child = child
      child.stdout?.on("data", (d: Buffer) => {
        const text = d.toString()
        if (gen !== r.gen) return
        if (/Name now registered and active/i.test(text)) r.status = { ...r.status, state: "active" }
        if (/conflict|already in use/i.test(text)) r.status = { ...r.status, state: "conflict", conflictWith: "another device (dns-sd)" }
      })
      child.on("exit", (code) => { if (gen === r.gen && r.child === child) { r.child = null; r.cfg = null; r.status = { ...r.status, state: "error", error: `dns-sd exited (${code})` } } })
      setTimeout(() => { if (gen === r.gen && r.status.state === "probing") r.status = { ...r.status, state: "active" } }, 3000)
    } else {
      const m = makeMdns({ reuseAddr: true })
      r.responder = m
      m.on("error", (e: Error) => { if (gen === r.gen) r.status = { ...r.status, state: "error", error: e.message } })
      m.on("query", (query: { questions: { name: string; type: string }[] }) => {
        if (gen !== r.gen || !r.cfg) return
        const answers = query.questions.flatMap((q) => answersFor(r.cfg as MdnsConfig, q))
        if (answers.length) m.respond({ answers: answers as never })
      })
      // Announce (twice, per RFC 6762 §8.3), so caches update after an IP change.
      m.respond({ answers: allRecords(want) as never })
      setTimeout(() => { if (gen === r.gen) m.respond({ answers: allRecords(want) as never }) }, 1000)
      r.status = { ...r.status, state: "active" }
    }
    console.log(`[mdns] advertising ${mdnsHost(want.name)} → ${want.ip}, _rtmp._tcp port ${want.port} (${backend})`)
  } catch (e) {
    r.status = { ...r.status, state: "error", error: e instanceof Error ? e.message : String(e) }
  }
}
export function stopMdns() {
  const r = rt()
  teardown(r)
  r.cfg = null
  r.gen++
  r.status = offState(r.status.name)
}
