import { connection } from "next/server"
import { authorizeMutation } from "@/lib/auth"
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, saveUpload } from "@/lib/uploads"

/** Operator-only upload for card images, logos, and showreel video. Body = raw bytes. */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request)
  if (denied) return denied
  const kind = new URL(request.url).searchParams.get("kind")
  const limit = kind === "video" ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES
  if (Number(request.headers.get("content-length") ?? 0) > limit) return Response.json({ error: kind === "video" ? "Video is over 100 MB." : "Image is over 5 MB." }, { status: 413 })
  const bytes = new Uint8Array(await request.arrayBuffer())
  // ?kind=logo also takes SVG (sanitised); ?kind=video takes MP4; card images stay raster-only.
  const result = saveUpload(bytes, { svg: kind === "logo", video: kind === "video" })
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status })
  return Response.json({ url: result.url })
}
