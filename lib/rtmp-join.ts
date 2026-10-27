/**
 * Destination form: visible Server + Stream key fields, joined into the one ingest URL the API keeps.
 * Trims both, exactly one "/" between them, and a key starting with "?" is appended as a query
 * (e.g. Castr/MediaMTX "?password=…"). An empty key = the server field is the whole URL (paste compat).
 */
export function joinRtmpServerAndKey(server: string, key: string): string {
  const s = server.trim()
  const k = key.trim()
  if (!k) return s
  if (k.startsWith("?")) return `${s.replace(/\/+$/, "")}${k}`
  // SRT: the "key" is the query (streamid=…&latency=…), never a path segment.
  if (/^srt:/i.test(s)) return `${s.replace(/\/+$/, "")}?${k.replace(/^[/?]+/, "")}`
  return `${s.replace(/\/+$/, "")}/${k.replace(/^\/+/, "")}`
}

/**
 * The inverse of joinRtmpServerAndKey for an edit form: the stream key is the last path segment
 * plus any query ("rtmp://a.rtmp.youtube.com/live2" + "abcd-1234"); with a one-segment path the
 * query alone is the key ("rtmp://host/app" + "?password=…"). join(split(url)) gives the url back.
 */
export function splitRtmpUrl(url: string): { server: string; key: string } {
  const value = url.trim()
  const qi = value.indexOf("?")
  const base = qi >= 0 ? value.slice(0, qi) : value
  const query = qi >= 0 ? value.slice(qi) : ""
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(\/[^?#]*)?$/i.exec(base)
  if (!m) return { server: value, key: "" }
  const segs = (m[2] ?? "").split("/").filter(Boolean)
  if (segs.length >= 2) return { server: `${m[1]}/${segs.slice(0, -1).join("/")}`, key: `${segs.at(-1)}${query}` }
  return { server: `${m[1]}${segs.length ? `/${segs[0]}` : ""}`, key: query }
}

/** "rtmp://••••••••/live2/••••a1b2": scheme and app path, host and key hidden (last 4 of the key kept). */
export function maskRtmpDisplay(url: string): string {
  const { server, key } = splitRtmpUrl(url)
  const m = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]+(.*)$/i.exec(server)
  if (!m) return "••••••••"
  const tail = key.length > 6 ? key.slice(-4) : ""
  const keyPart = key ? `${key.startsWith("?") ? "?" : "/"}••••••••${tail}` : ""
  return `${m[1]}••••••••${m[2]}${keyPart}`
}
