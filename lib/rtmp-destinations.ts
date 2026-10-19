import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { allowedRtmpHost, DATA_DIR, validateRtmpUrl } from "@/lib/encoder"
import { joinRtmpServerAndKey, maskRtmpDisplay, splitRtmpUrl } from "@/lib/rtmp-join"

/**
 * Named RTMP destinations, stored server-side in data/rtmp-destinations.json (0600, gitignored with /data/).
 * The full URL (server + key) never leaves this module except via reveal()/resolve():
 * not in public state, /stream, logs or event.json.
 */
/** Pseudo-destination a channel can select: publish to the local MediaMTX relay path instead. */
export const RELAY_TARGET = "relay"

export type Destination = { id: string; name: string; url: string; createdAt: number; updatedAt?: number }
/** `display` = "rtmp://••••••••/live2/••••a1b2" (host and key hidden), `masked` = "rtmp://host/••••a1b2". */
export type MaskedDestination = { id: string; name: string; host: string; masked: string; display: string; createdAt: number; updatedAt: number | null }
/** selectedId = Slate channel (kept for compatibility), selectedCaptureId = Browser capture channel. */
type Store = { selectedId: string | null; selectedCaptureId: string | null; items: Destination[] }

const NAME_MAX = 60

function file() {
  return path.join(process.env.STREAM_DATA_DIR || DATA_DIR, "rtmp-destinations.json")
}

function read(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<Store>
    const items = Array.isArray(parsed.items)
      ? parsed.items.filter((item): item is Destination => Boolean(item && typeof item.id === "string" && typeof item.name === "string" && typeof item.url === "string"))
      : []
    const valid = (id: unknown) => (typeof id === "string" && (id === RELAY_TARGET || items.some((item) => item.id === id)) ? id : null)
    return { selectedId: valid(parsed.selectedId), selectedCaptureId: valid(parsed.selectedCaptureId), items }
  } catch {
    return { selectedId: null, selectedCaptureId: null, items: [] }
  }
}

function write(store: Store) {
  const target = file()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
}

/** "uk.castr.io · …a1b2": host plus the last 4 characters of the key (path + query). */
export function maskRtmpUrl(url: string): { host: string; masked: string } {
  try {
    const parsed = new URL(url)
    const secret = `${parsed.pathname}${parsed.search}`.replace(/\/+$/, "")
    const tail = secret.length > 4 ? secret.slice(-4) : ""
    return { host: parsed.host, masked: `${parsed.protocol}//${parsed.host}/••••${tail}` }
  } catch {
    return { host: "?", masked: "••••" }
  }
}

function mask(item: Destination): MaskedDestination {
  return { id: item.id, name: item.name, createdAt: item.createdAt, updatedAt: item.updatedAt ?? null, display: maskRtmpDisplay(item.url), ...maskRtmpUrl(item.url) }
}

export function listDestinations(): { selectedId: string | null; selectedCaptureId: string | null; items: MaskedDestination[] } {
  const store = read()
  return { selectedId: store.selectedId, selectedCaptureId: store.selectedCaptureId, items: store.items.map(mask) }
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string; status: number }

function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const name = raw.replace(/[\r\n\t]+/g, " ").trim().slice(0, NAME_MAX)
  return name || null
}

export function addDestination(rawName: unknown, rawUrl: unknown, now = Date.now()): Result<MaskedDestination> {
  const name = cleanName(rawName)
  if (!name) return { ok: false, error: "Give the destination a name.", status: 400 }
  const checked = checkUrl(typeof rawUrl === "string" ? rawUrl : "")
  if (!checked.ok) return checked
  const store = read()
  const item: Destination = { id: crypto.randomUUID(), name, url: checked.value, createdAt: now }
  store.items.push(item)
  if (!store.selectedId) store.selectedId = item.id
  write(store)
  return { ok: true, value: mask(item) }
}

export function renameDestination(id: unknown, rawName: unknown): Result<MaskedDestination> {
  const name = cleanName(rawName)
  if (!name) return { ok: false, error: "Give the destination a name.", status: 400 }
  const store = read()
  const item = store.items.find((entry) => entry.id === id)
  if (!item) return { ok: false, error: "No such destination.", status: 404 }
  item.name = name
  write(store)
  return { ok: true, value: mask(item) }
}

/** Shared by add/update: rtmp:// or rtmps:// only (javascript:, http:, file: … refused), allow-listed host. */
function checkUrl(raw: string): Result<string> {
  if (/^\s*srt:/i.test(raw)) return { ok: false, error: "SRT destinations aren't supported: forwards publish RTMP. Use the service's rtmp:// or rtmps:// ingest.", status: 400 }
  const checked = validateRtmpUrl(raw)
  if (!checked.ok) return { ok: false, error: checked.error, status: 400 }
  if (!allowedRtmpHost(checked.url)) return { ok: false, error: "That RTMP host is not in RTMP_ALLOWED_HOSTS.", status: 400 }
  return { ok: true, value: checked.url }
}

/**
 * Edit name / server / stream key (keys rotate). An empty key keeps the saved one; an empty server
 * keeps the saved server. `changed` = the URL changed (a ticked relay forward must restart with it).
 */
export function updateDestination(id: unknown, input: { name?: unknown; server?: unknown; key?: unknown }, now = Date.now()): Result<MaskedDestination> & { changed?: boolean } {
  const store = read()
  const item = store.items.find((entry) => entry.id === id)
  if (!item) return { ok: false, error: "No such destination.", status: 404 }
  const name = cleanName(input.name)
  if (!name) return { ok: false, error: "Give the destination a name.", status: 400 }
  const current = splitRtmpUrl(item.url)
  const server = typeof input.server === "string" && input.server.trim() ? input.server.trim() : current.server
  const key = typeof input.key === "string" && input.key.trim() ? input.key.trim() : current.key
  if (/\s/.test(key)) return { ok: false, error: "The stream key must not contain spaces.", status: 400 }
  const checked = checkUrl(joinRtmpServerAndKey(server, key))
  if (!checked.ok) return checked
  if (store.items.some((entry) => entry.id !== item.id && entry.url === checked.value)) return { ok: false, error: "Another saved destination already uses this server and stream key.", status: 409 }
  const changed = checked.value !== item.url
  if (!changed && name === item.name) return { ok: true, value: mask(item), changed: false }
  item.name = name
  item.url = checked.value
  item.updatedAt = now
  write(store)
  return { ok: true, value: mask(item), changed }
}

/** Edit form prefill: the server part (no key) and the key's last 4. Operator only (API). */
export function destinationEditInfo(id: unknown): { id: string; name: string; server: string; keyTail: string; keyKind: "path" | "query" | "none" } | null {
  const item = read().items.find((entry) => entry.id === id)
  if (!item) return null
  const { server, key } = splitRtmpUrl(item.url)
  return { id: item.id, name: item.name, server, keyTail: key.length > 6 ? key.slice(-4) : "", keyKind: !key ? "none" : key.startsWith("?") ? "query" : "path" }
}

export function deleteDestination(id: unknown): Result<null> {
  const store = read()
  const before = store.items.length
  store.items = store.items.filter((entry) => entry.id !== id)
  if (store.items.length === before) return { ok: false, error: "No such destination.", status: 404 }
  if (store.selectedId === id) store.selectedId = store.items[0]?.id ?? null
  if (store.selectedCaptureId === id) store.selectedCaptureId = null
  write(store)
  return { ok: true, value: null }
}

export function selectDestination(id: unknown, channel: "slate" | "capture" = "slate"): Result<null> {
  const store = read()
  if (id !== null && id !== RELAY_TARGET && !store.items.some((entry) => entry.id === id)) return { ok: false, error: "No such destination.", status: 404 }
  if (channel === "capture") store.selectedCaptureId = id as string | null
  else store.selectedId = id as string | null
  write(store)
  return { ok: true, value: null }
}

/** Full URL for an explicit operator Reveal, or for the encoder to start. */
export function resolveDestination(id: unknown): Destination | null {
  return read().items.find((entry) => entry.id === id) ?? null
}
