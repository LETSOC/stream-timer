import fs from "node:fs"
import path from "node:path"
import { connection } from "next/server"
import { CONTENT_TYPES, UPLOAD_NAME, uploadsDir } from "@/lib/uploads"

/**
 * Uploaded card images. Public on purpose: they only ever appear on the public /stream picture,
 * OBS must load them on first paint (before the view cookie exists), and names are 128-bit hashes.
 */
export async function GET(request: Request, context: RouteContext<"/uploads/[file]">) {
  await connection()
  const { file } = await context.params
  if (!UPLOAD_NAME.test(file)) return new Response("Not found", { status: 404 })
  // Content-addressed name = the ETag: a revalidating browser gets a 304 without the bytes.
  const etag = `"${file.split(".")[0]}"`
  const cache = { "Cache-Control": "public, max-age=31536000, immutable", ETag: etag }
  if (request.headers.get("if-none-match") === etag && fs.existsSync(path.join(uploadsDir(), file))) return new Response(null, { status: 304, headers: cache })
  try {
    const data = new Uint8Array(fs.readFileSync(path.join(uploadsDir(), file)))
    const ext = file.split(".").pop() as keyof typeof CONTENT_TYPES
    return new Response(data, { headers: { "Content-Type": CONTENT_TYPES[ext], ...cache, "X-Content-Type-Options": "nosniff" } })
  } catch {
    return new Response("Not found", { status: 404 })
  }
}
