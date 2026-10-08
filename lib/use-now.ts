"use client"

import { useSyncExternalStore } from "react"

const listeners = new Set<() => void>()
let timer: number | null = null

function emit() {
  listeners.forEach((listener) => listener())
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange)
  if (listeners.size === 1 && typeof window !== "undefined") {
    timer = window.setInterval(emit, 250)
  }
  return () => {
    listeners.delete(onStoreChange)
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}

function getClientSnapshot(): number {
  return Math.floor(Date.now() / 250)
}

function getServerSnapshot(): number {
  return 0
}

export function useNow(): Date | null {
  const bucket = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot)
  if (bucket === 0) return null
  return new Date(bucket * 250)
}
