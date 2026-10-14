/**
 * Clipboard copy that works on plain-http LAN origins (http://192.168.x.x, http://0.0.0.0) where
 * navigator.clipboard is unavailable (not a secure context), on desktop Chrome and iOS Safari.
 *
 * Call it synchronously from the click handler, with the value already in hand: the
 * execCommand fallback only works inside the user gesture, so never await a fetch first.
 */
export type CopyResult = "copied" | "failed"

/** Hidden textarea + execCommand("copy"). iOS needs a real selection range, readonly (no keyboard), 16px (no zoom). */
export function legacyCopy(value: string): boolean {
  if (typeof document === "undefined") return false
  const el = document.createElement("textarea")
  el.value = value
  el.setAttribute("readonly", "")
  el.setAttribute("aria-hidden", "true")
  el.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;font-size:16px;"
  document.body.appendChild(el)
  const selection = document.getSelection()
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  let ok = false
  try {
    el.focus({ preventScroll: true })
    el.select()
    el.setSelectionRange(0, value.length)
    ok = document.execCommand("copy")
  } catch {
    ok = false
  } finally {
    el.remove()
    if (previous && selection) { selection.removeAllRanges(); selection.addRange(previous) }
  }
  return ok
}

/**
 * Secure context → navigator.clipboard (falls back to execCommand if it rejects).
 * Insecure context → execCommand immediately (still inside the gesture).
 */
export async function copyText(value: string): Promise<CopyResult> {
  const secure = typeof window !== "undefined" && window.isSecureContext && typeof navigator !== "undefined" && !!navigator.clipboard?.writeText
  if (!secure) return legacyCopy(value) ? "copied" : "failed"
  try {
    await navigator.clipboard.writeText(value)
    return "copied"
  } catch {
    return legacyCopy(value) ? "copied" : "failed"
  }
}
