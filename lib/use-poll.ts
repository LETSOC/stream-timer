"use client"

import { useEffect, useRef } from "react"
import { startPoll } from "@/lib/poll"

/** React wrapper for startPoll: `tick` may change every render; the loop restarts only when `ms` or `enabled` change. */
export function usePoll(tick: () => Promise<unknown> | unknown, ms: number, enabled = true) {
  const tickRef = useRef(tick)
  useEffect(() => {
    tickRef.current = tick
  })
  useEffect(() => {
    if (!enabled) return
    return startPoll(() => tickRef.current(), ms)
  }, [ms, enabled])
}
