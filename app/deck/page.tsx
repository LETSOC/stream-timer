import type { Metadata, Viewport } from "next"
import { StreamDeck } from "@/components/stream-deck"

export const metadata: Metadata = { title: "Stream Deck · Hyphen countdown" }
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0b0b0f" }

/** Phone Stream Deck. Operator only (proxy.ts sends others to /login). */
export default function DeckPage() {
  return <StreamDeck />
}
