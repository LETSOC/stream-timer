import { randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "@/lib/encoder"

/**
 * Internal credential for the headless browser capture (scripts/capture-stream.mjs), separate from
 * the OBS view key so rotating the view key never blanks a live capture. Lives in data/capture-key
 * (0600). The capture script reads it from that file and sends it as a request header only to this
 * server's loopback origin. It is never sent to clients, never in a URL, and is not ENCODER_TOKEN:
 * it only grants what the view key grants (viewing /stream and its public state/media).
 */
export const CAPTURE_HEADER = "x-stream-capture-key"

export function captureKeyFile() {
  return path.join(DATA_DIR, "capture-key")
}

export function getCaptureKey(): string {
  try {
    const existing = fs.readFileSync(captureKeyFile(), "utf8").trim()
    if (existing.length >= 32) return existing
  } catch {
    /* create below */
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const key = randomBytes(32).toString("base64url")
  fs.writeFileSync(captureKeyFile(), key, { mode: 0o600 })
  fs.chmodSync(captureKeyFile(), 0o600)
  return key
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|localhost)$/i

/** Pure: does this header set carry the capture key, and (defence in depth) look like a loopback request? */
export function captureKeyAccepted(headers: Pick<Headers, "get">, key: string): boolean {
  const candidate = headers.get(CAPTURE_HEADER)
  if (!candidate || !key) return false
  const a = Buffer.from(key)
  const b = Buffer.from(candidate)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  // Next fills x-forwarded-for from the socket when absent; a proxy in front sets it. Either way,
  // anything that isn't loopback is refused. (Not a guarantee on its own: the 256-bit key is.)
  const forwarded = headers.get("x-forwarded-for")
  if (forwarded && !forwarded.split(",").every((part) => LOOPBACK.test(part.trim()))) return false
  const host = (headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
  return host === "" || LOOPBACK.test(host)
}

export function isCaptureRequest(headers: Pick<Headers, "get">): boolean {
  if (!headers.get(CAPTURE_HEADER)) return false
  try {
    return captureKeyAccepted(headers, fs.readFileSync(captureKeyFile(), "utf8").trim())
  } catch {
    return false
  }
}
