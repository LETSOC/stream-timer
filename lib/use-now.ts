"use client"

import { useEffect, useState } from "react"

export function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    const tick = () => setNow(new Date())
    const timeout = window.setTimeout(tick, 0)
    const id = window.setInterval(tick, 250)
    return () => {
      window.clearTimeout(timeout)
      window.clearInterval(id)
    }
  }, [])

  return now
}
