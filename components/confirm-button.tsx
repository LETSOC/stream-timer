"use client"

import { useEffect, useRef, useState, type ComponentProps } from "react"

/** Two-step button, or hold-to-confirm when holdMs is set (a press shorter than that does nothing). */
export function ConfirmButton({
  onConfirm,
  confirmLabel = "Click again to confirm",
  holdMs,
  children,
  className = "",
  ...props
}: Omit<ComponentProps<"button">, "onClick"> & { onConfirm: () => void; confirmLabel?: string; /** Hold this long to run. A short tap does nothing. */ holdMs?: number }) {
  const [armed, setArmed] = useState(false)
  const [pct, setPct] = useState(0)
  const start = useRef(0)
  const frame = useRef(0)

  useEffect(() => {
    if (!armed) return
    const id = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(id)
  }, [armed])

  if (holdMs) {
    const stop = () => { cancelAnimationFrame(frame.current); setPct(0) }
    const begin = () => {
      if (props.disabled) return
      start.current = performance.now()
      const tick = () => {
        const p = Math.min(1, (performance.now() - start.current) / holdMs)
        setPct(p)
        if (p >= 1) { stop(); onConfirm(); return }
        frame.current = requestAnimationFrame(tick)
      }
      frame.current = requestAnimationFrame(tick)
    }
    return (
      <button
        type="button"
        {...props}
        aria-live="polite"
        className={`relative overflow-hidden ${className}`}
        onPointerDown={begin}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
      >
        <span aria-hidden className="absolute inset-y-0 left-0 bg-current/15" style={{ width: `${pct * 100}%` }} />
        <span className="relative">{pct > 0 ? `Hold ${Math.ceil((1 - pct) * holdMs / 1000)}s` : children}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      {...props}
      aria-live="polite"
      className={`${className} ${armed ? "ring-2 ring-[#b42318] ring-offset-2" : ""}`}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onConfirm()
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}
