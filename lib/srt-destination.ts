/**
 * SRT forward destinations (relay forwards only; the direct Slate/Capture encoders publish RTMP).
 *
 *   srt://<host>:<port>?streamid=publish:<path>:<user>:<pass>&latency=<µs>&pkt_size=1316[&passphrase=…]
 *
 * The secret lives in streamid (user/pass) and passphrase. Both are masked everywhere except an
 * explicit operator Reveal; errors never echo the URL. Parsed by hand (not WHATWG URL): SRS-style
 * streamids start with "#!::", which URL would treat as a fragment.
 */

/** SRT socket options ffmpeg's libsrt takes in the URL that make sense for a caller pushing live. */
export const SRT_OPTIONS = ["streamid", "latency", "rcvlatency", "peerlatency", "pkt_size", "payload_size", "passphrase", "pbkeylen", "mode", "connect_timeout", "timeout", "maxbw", "oheadbw", "inputbw", "tlpktdrop", "transtype", "send_buffer_size", "linger"] as const
const INT_OPTIONS = new Set(["latency", "rcvlatency", "peerlatency", "pkt_size", "payload_size", "pbkeylen", "connect_timeout", "timeout", "maxbw", "oheadbw", "inputbw", "send_buffer_size", "linger"])
const DOTS = "••••"

export function isSrtUrl(url: string): boolean {
  return /^\s*srt:\/\//i.test(url)
}

type Parsed = { authority: string; hostname: string; port: number; params: [string, string][] }

/** Pure: split an srt:// URL into authority and query pairs, or null if the shape is wrong. */
function parse(raw: string): Parsed | null {
  const m = /^srt:\/\/([^/?\s]+)\/?(?:\?(.*))?$/i.exec(raw)
  if (!m) return null
  const authority = m[1]
  const hp = /^(\[[0-9a-f:.]+\]|[^:[\]@]+):(\d{1,5})$/i.exec(authority)
  if (!hp) return null
  const params = (m[2] ?? "").split("&").filter(Boolean).map((pair): [string, string] => {
    const at = pair.indexOf("=")
    return at < 0 ? [pair.toLowerCase(), ""] : [pair.slice(0, at).toLowerCase(), pair.slice(at + 1)]
  })
  return { authority, hostname: hp[1], port: Number(hp[2]), params }
}

export type SrtUrlCheck = { ok: true; url: string } | { ok: false; error: string }

/**
 * Pure: a pushable SRT URL. srt:// only, real host and an explicit port, no user@, only known libsrt
 * options, each once, mode caller, a publish streamid, passphrase 10–79 characters. Never echoes the URL.
 */
export function validateSrtUrl(raw: string): SrtUrlCheck {
  const value = raw.trim()
  if (!value) return { ok: false, error: "Paste the SRT URL." }
  if (/\s/.test(value)) return { ok: false, error: "The SRT URL must not contain spaces." }
  if (!isSrtUrl(value)) return { ok: false, error: "Use an srt:// URL." }
  const p = parse(value)
  if (!p) return { ok: false, error: "SRT URL: use srt://host:port?streamid=…&latency=…&pkt_size=1316 (the port is required; no user@ or path)." }
  const host = p.hostname
  const ipv6 = host.startsWith("[") && host.endsWith("]")
  if (!ipv6 && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host)) return { ok: false, error: "The SRT URL needs a valid host name." }
  if (p.port < 1 || p.port > 65535) return { ok: false, error: "The SRT port must be 1-65535." }
  const seen = new Set<string>()
  for (const [key, val] of p.params) {
    if (!(SRT_OPTIONS as readonly string[]).includes(key)) return { ok: false, error: `SRT option "${key.slice(0, 20)}" is not allowed. Use: ${SRT_OPTIONS.join(", ")}.` }
    if (seen.has(key)) return { ok: false, error: `SRT option "${key}" is given twice.` }
    seen.add(key)
    if (INT_OPTIONS.has(key) && !/^\d{1,12}$/.test(val)) return { ok: false, error: `SRT option "${key}" must be a whole number.` }
    if (key === "mode" && val.toLowerCase() !== "caller") return { ok: false, error: "SRT forwards connect out: mode must be caller (or left out)." }
    if (key === "transtype" && val.toLowerCase() !== "live") return { ok: false, error: "SRT forwards are live streams: transtype must be live (or left out)." }
    if (key === "passphrase" && (val.length < 10 || val.length > 79)) return { ok: false, error: "SRT passphrase: 10 to 79 characters." }
  }
  const streamid = p.params.find(([k]) => k === "streamid")?.[1] ?? ""
  if (!streamid) return { ok: false, error: "The SRT URL needs a streamid (e.g. streamid=publish:program-backup:user:pass)." }
  if (/^read:/i.test(streamid) || /(^|,)m=request(,|$)/i.test(streamid)) return { ok: false, error: "That streamid reads a stream; a forward must publish (publish:… or m=publish)." }
  return { ok: true, url: value }
}

/** The host part an allow-list checks ("srt://host:port", nothing secret). */
export function srtHostUrl(url: string): string | null {
  const p = parse(url.trim())
  return p ? `srt://${p.authority}` : null
}

/** "publish:program-backup:user:pass" → "publish:program-backup:••••"; SRS "#!::r=…" → "#!::••••"; else "••••". */
export function maskStreamid(streamid: string): string {
  const mtx = /^(publish|read):([^:]+):/i.exec(streamid)
  if (mtx) return `${mtx[1]}:${mtx[2]}:${DOTS}`
  if (streamid.startsWith("#!::")) return `#!::${DOTS}`
  return streamid ? DOTS : ""
}

function maskedQuery(params: [string, string][]): string {
  const q = params.map(([k, v]) => `${k}=${k === "streamid" ? maskStreamid(v) : k === "passphrase" ? DOTS : v}`).join("&")
  return q ? `?${q}` : ""
}

/**
 * Pure: masked forms of a saved SRT URL. `masked` keeps the host ("srt://host:8890?streamid=publish:program-backup:••••&…"),
 * `display` hides it too, like RTMP. Latency/pkt_size stay visible; streamid credentials and passphrase never do.
 */
export function maskSrtUrl(url: string): { host: string; masked: string; display: string } {
  const p = parse(url.trim())
  if (!p) return { host: "?", masked: DOTS, display: "srt://••••••••" }
  const q = maskedQuery(p.params)
  return { host: p.authority, masked: `srt://${p.authority}${q}`, display: `srt://••••••••${q}` }
}

/** Log/status redaction: everything after the host:port of any srt:// URL, plus bare passphrase=/streamid= values. */
export function redactSrt(text: string): string {
  return text
    .replace(/(srt:\/\/[^\s/'"?]+)[^\s'"]*/gi, "$1?••••")
    .replace(/\b(passphrase|streamid)=[^\s&'"]+/gi, "$1=••••")
}
