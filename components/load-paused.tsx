"use client"

/** Small note in place of a preview hidden by the Mac load alert, with a manual "show anyway". */
export function LoadPaused({ reason, onShow, className = "" }: { reason: string; onShow: () => void; className?: string }) {
  return (
    <div data-testid="load-paused" className={`flex flex-col items-center justify-center gap-1.5 bg-black p-2 text-center font-mono text-[10px] text-amber-300 ${className}`}>
      <span>Mac busy{reason ? ` (${reason})` : ""}: previews paused to protect the stream</span>
      <button type="button" data-testid="load-paused-show" onClick={(e) => { e.stopPropagation(); onShow() }} className="pointer-events-auto rounded-full border border-amber-300/50 px-2.5 py-0.5 text-amber-200 hover:bg-amber-300/10">Show anyway</button>
    </div>
  )
}
