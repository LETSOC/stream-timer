"use client"

import { useEffect, useRef, useSyncExternalStore } from "react"
import { copyText, type CopyResult } from "@/lib/copy-text"

/** Last-resort copy: a dialog with the value pre-selected and how to copy it by hand. */
let pending: { label: string; value: string } | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((fn) => fn())

export function showCopyDialog(label: string, value: string) {
  pending = { label, value }
  emit()
}

/** Copy, or open the manual-copy dialog if the browser refuses. Call synchronously from the click. */
export async function copyOrShow(label: string, value: string): Promise<CopyResult> {
  const result = await copyText(value)
  if (result === "failed") showCopyDialog(label, value)
  return result
}

export function CopyFallbackHost() {
  const current = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    () => pending,
    () => null,
  )
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
    el.setSelectionRange(0, el.value.length)
  }, [current])
  if (!current) return null
  const close = () => { pending = null; emit() }
  return (
    <div role="dialog" aria-modal="true" aria-label={`Copy ${current.label}`} data-testid="copy-dialog" className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={close}>
      <div className="w-full max-w-lg space-y-3 rounded-2xl bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <p className="text-[13px] font-black tracking-[0.12em] uppercase">Copy {current.label}</p>
        <p className="font-mono text-[12px] text-black/70">This browser blocked automatic copy (plain http). The text is selected: press ⌘C / Ctrl+C, or on iPhone tap and hold → Copy.</p>
        <textarea ref={ref} readOnly data-testid="copy-dialog-text" value={current.value} rows={4} onFocus={(e) => e.currentTarget.select()} className="w-full rounded-xl border border-black/10 bg-[#F6F6F3] p-2 font-mono text-[16px] break-all sm:text-[12px]" />
        <div className="flex justify-end">
          <button type="button" data-testid="copy-dialog-close" className="rounded-full bg-black px-4 py-2 font-mono text-[12px] font-bold text-white" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  )
}
