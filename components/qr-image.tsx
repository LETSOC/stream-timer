"use client"

import QRCode from "qrcode"

/** Module cache so remounts (and /stream reload) paint the same QR instantly. */
const cache = new Map<string, string>()

/** Sync SVG data-URL from the matrix — no blank frame waiting on async toDataURL. */
export function qrDataUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  const hit = cache.get(trimmed)
  if (hit) return hit
  try {
    const qr = QRCode.create(trimmed, { errorCorrectionLevel: "M" })
    const size = qr.modules.size
    const margin = 1
    const cells = size + margin * 2
    let path = ""
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (qr.modules.get(x, y)) path += `M${x + margin} ${y + margin}h1v1h-1z`
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cells} ${cells}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><path fill="#000000" d="${path}"/></svg>`
    const data = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    cache.set(trimmed, data)
    return data
  } catch {
    return null
  }
}

/** Client-side QR so the desk RSVP URL always matches the on-stage code. */
export function QrImage({
  url,
  className,
  alt = "",
}: {
  url: string
  className?: string
  alt?: string
}) {
  const trimmed = url.trim()
  const src = trimmed ? qrDataUrl(trimmed) : null

  if (!trimmed) {
    return <div className={className} style={{ background: "#fff" }} aria-hidden />
  }

  if (!src) {
    return (
      <img
        src="/brand/rsvp-qr.png"
        alt={alt}
        className={className}
        draggable={false}
      />
    )
  }

  return <img src={src} alt={alt} className={className} draggable={false} />
}
