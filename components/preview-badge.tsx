"use client"
/** "LIVE <1s" (WebRTC) vs "HLS ~3s" on operator previews. */
export function PreviewBadge({ mode }: { mode: "webrtc" | "hls" | null }) {
  if (!mode) return null
  return (
    <span data-testid="preview-badge" data-mode={mode} className={`pointer-events-none absolute top-1.5 left-1.5 z-10 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${mode === "webrtc" ? "bg-[#12b76a] text-black" : "bg-black/70 text-white/80"}`}>
      {mode === "webrtc" ? "LIVE <1s" : "HLS ~3s"}
    </span>
  )
}
