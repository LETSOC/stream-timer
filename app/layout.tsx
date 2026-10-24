import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono, Instrument_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
})

// Visuals layer fonts (Hyphen design): self-hosted by next/font at build time, no runtime CDN.
const instrumentSans = Instrument_Sans({ variable: "--font-instrument-sans", subsets: ["latin"], weight: ["400", "500", "600"] })
const jetbrainsMono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], weight: ["400", "500", "700"] })

export const metadata: Metadata = {
  title: "Hyphen Festival countdown",
  description:
    "16:9 live countdown player and FFmpeg RTMP helper for Hyphen Festival 2026.",
}

/** viewport-fit=cover so env(safe-area-inset-*) is non-zero on iPhone (notch, home bar, Safari toolbar). */
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" }

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} ${instrumentSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  )
}
