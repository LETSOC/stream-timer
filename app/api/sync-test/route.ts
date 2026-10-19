import { NextResponse } from "next/server"
import { readAudioSettings } from "@/lib/audio-bed"
import { isCaptureRequest } from "@/lib/capture-key"

export const dynamic = "force-dynamic"

/** Is the Browser capture A/V sync test on? Answered "on" only to the capture itself (internal capture key header). */
export function GET(request: Request) {
  const capture = isCaptureRequest(request.headers)
  const on = capture && readAudioSettings().channels.capture.syncTest === true
  return NextResponse.json({ on, capture }, { headers: { "cache-control": "no-store" } })
}
