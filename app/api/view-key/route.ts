import { connection } from "next/server"
import { authorizeMutation, requireOperator } from "@/lib/auth"
import { getViewKey, rotateViewKey, viewKeyFromEnv, viewKeyRequired } from "@/lib/view-key"

export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  return Response.json({ key: getViewKey(), required: viewKeyRequired(), fromEnv: viewKeyFromEnv() })
}

/** Rotate: every OBS URL with the old key stops working. */
export async function POST(request: Request) {
  await connection()
  const denied = authorizeMutation(request)
  if (denied) return denied
  if (viewKeyFromEnv()) return Response.json({ error: "VIEW_KEY is set in the environment; change it there." }, { status: 409 })
  return Response.json({ key: rotateViewKey(), required: viewKeyRequired(), fromEnv: false })
}
