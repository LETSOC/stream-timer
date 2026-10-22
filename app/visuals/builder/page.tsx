import type { Metadata } from "next"
import { VisualsBuilder } from "@/components/visuals-builder"

export const metadata: Metadata = { title: "Visuals builder · Hyphen countdown" }

/** Desktop Visuals builder (assets + layout). Operator only (proxy.ts). */
export default function VisualsBuilderPage() {
  return <VisualsBuilder />
}
