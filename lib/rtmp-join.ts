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
  return `${s.replace(/\/+$/, "")}/${k.replace(/^\/+/, "")}`
}
