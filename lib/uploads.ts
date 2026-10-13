import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DATA_DIR } from "@/lib/encoder"

/** Card images uploaded from the desk: data/uploads/<sha256>.<ext>, served at /uploads/<name>. */
export function uploadsDir() {
  return path.join(process.env.STREAM_DATA_DIR || DATA_DIR, "uploads")
}

export const MAX_UPLOAD_BYTES = 5_000_000
export const UPLOAD_NAME = /^[a-f0-9]{32}\.(png|jpg|webp|gif)$/

/** Type from magic bytes, not the client's say-so. */
export function sniffImage(bytes: Uint8Array): "png" | "jpg" | "webp" | "gif" | null {
  const b = bytes
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png"
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg"
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp"
  if (b.length > 6 && String.fromCharCode(...b.slice(0, 4)) === "GIF8") return "gif"
  return null
}

export function saveUpload(bytes: Uint8Array): { ok: true; url: string } | { ok: false; error: string; status: number } {
  if (bytes.length === 0) return { ok: false, error: "Empty file.", status: 400 }
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, error: "Image is over 5 MB.", status: 413 }
  const ext = sniffImage(bytes)
  if (!ext) return { ok: false, error: "Only PNG, JPEG, WebP or GIF images.", status: 415 }
  // Content-addressed and unguessable (128 bits), so the same image is stored once.
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`
  fs.mkdirSync(uploadsDir(), { recursive: true })
  const file = path.join(uploadsDir(), name)
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes)
  return { ok: true, url: `/uploads/${name}` }
}

export const CONTENT_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const
