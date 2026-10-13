import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { allowedRtmpHost, DATA_DIR, validateRtmpUrl } from "@/lib/encoder"

/**
 * Named RTMP destinations, stored server-side in data/rtmp-destinations.json (0600, gitignored with /data/).
 * The full URL (server + key) never leaves this module except via reveal()/resolve():
 * not in public state, /stream, logs or event.json.
 */
export type Destination = { id: string; name: string; url: string; createdAt: number }
export type MaskedDestination = { id: string; name: string; host: string; masked: string; createdAt: number }
type Store = { selectedId: string | null; items: Destination[] }

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
    const selectedId = typeof parsed.selectedId === "string" && items.some((item) => item.id === parsed.selectedId) ? parsed.selectedId : null
    return { selectedId, items }
  } catch {
    return { selectedId: null, items: [] }
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
  return { id: item.id, name: item.name, createdAt: item.createdAt, ...maskRtmpUrl(item.url) }
}

export function listDestinations(): { selectedId: string | null; items: MaskedDestination[] } {
  const store = read()
  return { selectedId: store.selectedId, items: store.items.map(mask) }
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
  const checked = validateRtmpUrl(typeof rawUrl === "string" ? rawUrl : "")
  if (!checked.ok) return { ok: false, error: checked.error, status: 400 }
  if (!allowedRtmpHost(checked.url)) return { ok: false, error: "That RTMP host is not in RTMP_ALLOWED_HOSTS.", status: 400 }
  const store = read()
  const item: Destination = { id: crypto.randomUUID(), name, url: checked.url, createdAt: now }
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

export function deleteDestination(id: unknown): Result<null> {
  const store = read()
  const before = store.items.length
  store.items = store.items.filter((entry) => entry.id !== id)
  if (store.items.length === before) return { ok: false, error: "No such destination.", status: 404 }
  if (store.selectedId === id) store.selectedId = store.items[0]?.id ?? null
  write(store)
  return { ok: true, value: null }
}

export function selectDestination(id: unknown): Result<null> {
  const store = read()
  if (id !== null && !store.items.some((entry) => entry.id === id)) return { ok: false, error: "No such destination.", status: 404 }
  store.selectedId = id as string | null
  write(store)
  return { ok: true, value: null }
}

/** Full URL for an explicit operator Reveal, or for the encoder to start. */
export function resolveDestination(id: unknown): Destination | null {
  return read().items.find((entry) => entry.id === id) ?? null
}
