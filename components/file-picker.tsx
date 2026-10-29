"use client"
import { useId, useState } from "react"
import { Upload } from "lucide-react"

/** Dark builder look: lime outline pill that fills on hover (matches the builder chips). */
const DARK = "rounded-full border border-[#D9FF43]/70 px-3 py-1.5 font-mono text-[11px] font-bold tracking-wide text-[#D9FF43] uppercase hover:bg-[#D9FF43] hover:text-[#0a0a0a] peer-focus-visible:ring-[#D9FF43] peer-focus-visible:ring-offset-[#0a0a0a]"

/**
 * A real button for picking a file: the native input stays in the DOM (visually hidden, still focusable
 * and keyboard-operable), its label is the styled button, and the chosen file name shows beside it.
 * `buttonClass` swaps the look (e.g. the desk's pillClass); default is the dark builder style.
 */
export function FilePicker({ label, accept, onFile, disabled = false, busy = false, testId, buttonClass = DARK, muted = "text-white/50" }: {
  label: string
  accept: string
  onFile: (file: File) => void
  disabled?: boolean
  /** Upload running: button reads "Uploading…" and is disabled. */
  busy?: boolean
  testId?: string
  buttonClass?: string
  muted?: string
}) {
  const id = useId()
  const [name, setName] = useState<string | null>(null)
  const off = disabled || busy
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <input
        id={id}
        type="file"
        data-testid={testId}
        accept={accept}
        disabled={off}
        className="peer sr-only"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { setName(f.name); onFile(f) } }}
      />
      <label
        htmlFor={id}
        aria-disabled={off || undefined}
        className={`${buttonClass} inline-flex cursor-pointer items-center gap-1.5 transition-colors select-none peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-disabled:pointer-events-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50`}
      >
        <Upload aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
        {busy ? "Uploading…" : label}
      </label>
      <span className={`min-w-0 truncate font-mono text-[12px] ${muted}`} title={name ?? undefined}>{name ?? "No file selected"}</span>
    </div>
  )
}
