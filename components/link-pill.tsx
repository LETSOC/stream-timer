import type { DeckLink } from "@/lib/use-deck-socket"

const LINK_LABEL: Record<DeckLink, string> = { connecting: "Connecting…", live: "Live sync", polling: "Polling", offline: "Offline" }
const LINK_TONE: Record<DeckLink, string> = { connecting: "bg-white/40", live: "bg-[#12b76a]", polling: "bg-[#f79009]", offline: "bg-[#f04438]" }

/** Deck socket state pill, right-hand side of the top nav (Visuals and Visuals builder). */
export function LinkPill({ link, testId }: { link: DeckLink; testId?: string }) {
  return (
    <span data-testid={testId} data-link={link} className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 font-mono text-[12px] text-white/70">
      <span aria-hidden className={`size-2 rounded-full ${LINK_TONE[link]} ${link === "connecting" ? "animate-pulse" : ""}`} />
      {LINK_LABEL[link]}
    </span>
  )
}
