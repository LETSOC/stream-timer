"use client"

import { useEffect, useState, type ButtonHTMLAttributes } from "react"

/** Two-step button: first click arms it ("Confirm?"), second click within 3s runs the action. */
export function ConfirmButton({
  onConfirm,
  confirmLabel = "Click again to confirm",
  children,
  className = "",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & { onConfirm: () => void; confirmLabel?: string }) {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const id = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(id)
  }, [armed])

  return (
    <button
      type="button"
      {...props}
      aria-live="polite"
      className={`${className} ${armed ? "ring-2 ring-[#ff3c00] ring-offset-2" : ""}`}
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
