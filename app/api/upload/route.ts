import { connection } from "next/server"
import { authorizeMutation } from "@/lib/auth"
import { MAX_UPLOAD_BYTES, saveUpload } from "@/lib/uploads"

/** Operator-only image upload for break/hold cards. Body = raw image bytes. */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request)
  if (denied) return denied
  if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) return Response.json({ error: "Image is over 5 MB." }, { status: 413 })
  const bytes = new Uint8Array(await request.arrayBuffer())
  // ?kind=logo also takes SVG (sanitised); card images stay raster-only.
  const kind = new URL(request.url).searchParams.get("kind")
  const result = saveUpload(bytes, { svg: kind === "logo" })
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status })
  return Response.json({ url: result.url })
}
