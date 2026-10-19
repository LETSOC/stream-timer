import os from "node:os"
import { connection } from "next/server"
import { requireOperator } from "@/lib/auth"
import { localAccess } from "@/lib/local-access"

/** LAN address phones on the same Wi-Fi can open (desk/deck Local Access pill). Operator-only. */
export async function GET(request: Request) {
  await connection()
  const denied = requireOperator(request)
  if (denied) return denied
  return Response.json(localAccess(os.networkInterfaces(), process.env), { headers: { "cache-control": "no-store" } })
}
