import type { Platform } from "@/lib/visuals"

const BG: Record<Exclude<Platform, "none">, string> = {
  instagram: "linear-gradient(135deg,#f7d046,#e13b6b 55%,#7b3ff2)",
  x: "#000",
  linkedin: "#0a66c2",
  youtube: "#ff0033",
  tiktok: "#000",
  web: "#0000b6",
}

/** Round platform badge, sized by the parent's font-size (1em = badge). */
export function PlatformIcon({ platform, className, bg }: { platform: Platform; className?: string; /** badge colour override (default: the platform colour) */ bg?: string }) {
  if (platform === "none") return null
  return (
    <span className={className} data-platform={platform} style={{ display: "inline-flex", width: "1em", height: "1em", flex: "none", alignItems: "center", justifyContent: "center", borderRadius: "9999px", background: bg || BG[platform] }}>
      <svg viewBox="0 0 24 24" style={{ width: "0.56em", height: "0.56em" }} aria-hidden fill={platform === "instagram" || platform === "web" ? "none" : "white"} stroke={platform === "instagram" || platform === "web" ? "white" : "none"} strokeWidth="1.8">
        {platform === "x" ? <path d="M14.7 10.3 21.4 3h-1.6l-5.8 6.4L9.2 3H3.4l7 10-7 7.6h1.6l6.1-6.8 4.9 6.8h5.8l-7.1-9.3Zm-2.2 2.4-.7-1L5.6 4.2h2.4l4.5 6.2.7 1 5.9 8.1h-2.4l-4.8-6.8Z" /> : null}
        {platform === "linkedin" ? <path d="M6.7 9.2H4V20h2.7V9.2ZM5.3 4C4.4 4 3.7 4.7 3.7 5.6s.7 1.6 1.6 1.6 1.6-.7 1.6-1.6S6.2 4 5.3 4ZM20 20h-2.7v-5.6c0-1.6-.6-2.6-1.9-2.6-1 0-1.5.7-1.8 1.3-.1.2-.1.6-.1.9V20H11V9.2h2.6v1.5c.4-.7 1.3-1.8 3.2-1.8 2.3 0 4.2 1.5 4.2 4.8V20Z" /> : null}
        {platform === "youtube" ? <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31.5 31.5 0 0 0 0 12a31.5 31.5 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31.5 31.5 0 0 0 24 12a31.5 31.5 0 0 0-.5-5.8zM9.8 15.5v-7l6.2 3.5-6.2 3.5z" /> : null}
        {platform === "tiktok" ? <path d="M16.6 3c.3 2.3 1.6 3.8 3.9 4v2.6c-1.4.1-2.6-.3-3.9-1.1v5.9c0 7.4-8.1 9.7-11.3 4.4-2.1-3.4-.8-9.4 5.9-9.6v2.8c-.5.1-1 .2-1.5.4-1.5.5-2.4 1.5-2.1 3.2.5 3.3 6.6 4.3 6.1-2.2V3h2.9Z" /> : null}
        {platform === "instagram" ? <><rect x="5" y="5" width="14" height="14" rx="4" /><circle cx="12" cy="12" r="3.2" /><circle cx="16.4" cy="7.6" r="0.7" fill="white" stroke="none" /></> : null}
        {platform === "web" ? <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5Z" /></> : null}
      </svg>
    </span>
  )
}
