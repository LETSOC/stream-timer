"use client"
import type { ProgramSourcesView } from "@/lib/transport"

/** Operator-only (desk / deck previews, never /stream): which program inputs are connected, with live dots. */
export function FeedStatus({ view, className = "" }: { view: ProgramSourcesView | null | undefined; className?: string }) {
  if (!view) return null
  const item = (key: "main" | "backup", label: string) => {
    const on = view[key]?.ready === true
    return (
      <span data-testid={`feed-status-${key}`} data-connected={on ? "1" : "0"} className="flex items-center gap-1">
        <span className={`size-1.5 rounded-full ${on ? "animate-pulse bg-[#12b76a]" : "bg-white/35"}`} />
        {label} {on ? "connected" : "not connected"}
      </span>
    )
  }
  return (
    <div data-testid="feed-status" className={`pointer-events-none flex items-center gap-2.5 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white/85 ${className}`}>
      {item("main", "Main")}
      {item("backup", "Backup")}
    </div>
  )
}
