import type { Metadata, Viewport } from "next"
import { VisualsDeck } from "@/components/visuals-deck"

export const metadata: Metadata = { title: "Visuals deck · Hyphen countdown" }
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0b0b0f" }

/** Phone Visuals deck (name straps + socials overlay). Operator only (proxy.ts). */
export default function VisualsPage() {
  return <VisualsDeck />
}
