"use client"
import { uploadLabel, uploadPercent, type UploadState } from "@/lib/upload-progress"

/** Progress bar + "Uploading… 42%" / "Done" / "Failed: reason" for one upload slot (`tag`). Uses the text colour of its parent. */
export function UploadProgress({ state, tag = "default", className = "" }: { state: UploadState; tag?: string; className?: string }) {
  if (state.phase === "idle" || state.tag !== tag) return null
  const pct = state.phase === "uploading" ? uploadPercent(state.loaded, state.total) : state.phase === "failed" ? 0 : 100
  const tone = state.phase === "failed" ? "#E5484D" : state.phase === "done" ? "#30A46C" : "currentColor"
  return (
    <div data-testid={`upload-progress-${tag}`} data-phase={state.phase} role="status" aria-live="polite" className={`w-full min-w-[180px] font-mono text-[12px] ${className}`}>
      {state.phase === "failed" ? null : (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, currentColor 15%, transparent)" }}>
          <div className={`h-full rounded-full transition-[width] duration-200 ${state.phase === "processing" ? "animate-pulse" : ""}`} style={{ width: `${pct}%`, background: tone }} />
        </div>
      )}
      <p className="mt-1" style={state.phase === "uploading" || state.phase === "processing" ? undefined : { color: tone }}>{uploadLabel(state)}</p>
    </div>
  )
}
