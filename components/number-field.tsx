"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { checkNumberDraft, commitNumberDraft, type NumberRule } from "@/lib/number-draft"

/**
 * Numeric desk input that never fights the keyboard: keeps the raw text while typing
 * (empty and partial values allowed), pushes the value live only when it's a valid
 * in-range number, and clamps / reports errors on blur or Enter. Text input, so the
 * scroll wheel can't change it by accident; iOS gets the number keypad.
 */
export function NumberField({ id, value, onChange, rule, unit }: { id: string; value: number; onChange: (value: number) => void; rule: NumberRule; unit?: string }) {
  const [draft, setDraft] = useState<string | null>(null) // null = not editing, show value
  const [note, setNote] = useState<{ tone: "error" | "info"; text: string } | null>(null)
  const text = draft ?? String(value)
  const errorId = `${id}-note`

  function commit() {
    if (draft === null) return
    const result = commitNumberDraft(draft, rule)
    if (!result.ok) {
      setNote({ tone: "error", text: result.error })
      return
    }
    onChange(result.value)
    setDraft(null)
    setNote(result.clamped ? { tone: "info", text: `Kept within ${rule.min}–${rule.max}${unit ? ` ${unit}` : ""}: set to ${result.value}.` } : null)
  }

  return (
    <div className="space-y-1">
      <Input
        id={id}
        type="text"
        inputMode={rule.min < 0 ? "text" : rule.integer ? "numeric" : "decimal"}
        autoComplete="off"
        enterKeyHint="done"
        aria-invalid={note?.tone === "error" || undefined}
        aria-describedby={note ? errorId : undefined}
        value={text}
        onFocus={() => setDraft(String(value))}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          const check = checkNumberDraft(next, rule)
          if (check.kind === "number" && check.inRange) {
            setNote(null)
            if (check.value !== value) onChange(check.value)
          } else if (check.kind === "invalid") setNote({ tone: "error", text: check.error })
          else setNote(null)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
          } else if (event.key === "Escape") {
            setDraft(null)
            setNote(null)
          }
        }}
      />
      {note ? (
        <p id={errorId} role={note.tone === "error" ? "alert" : "status"} data-testid={`${id}-note`} className={`font-mono text-[12px] ${note.tone === "error" ? "font-bold text-[#b42318]" : "text-black/70"}`}>
          {note.text}
        </p>
      ) : (
        <p className="font-mono text-[11px] text-black/50">{rule.min}–{rule.max}{unit ? ` ${unit}` : ""}</p>
      )}
    </div>
  )
}
