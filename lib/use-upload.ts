"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { failureReason, xhrUpload, type UploadResult, type UploadState } from "@/lib/upload-progress"

/** How long "Done" stays on screen. Failures stay until the next upload. */
const DONE_MS = 5000

/**
 * One upload at a time with live progress. `start` returns null (and does nothing) while another
 * upload from this hook is running, so a double pick can't send twice. Leaving the page mid-upload asks first.
 */
export function useUpload() {
  const [state, setState] = useState<UploadState>({ phase: "idle" })
  const running = useRef(false)
  const doneTimer = useRef<number | null>(null)
  const busy = state.phase === "uploading" || state.phase === "processing"

  useEffect(() => {
    if (!busy) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = "" }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [busy])
  useEffect(() => () => { if (doneTimer.current) window.clearTimeout(doneTimer.current) }, [])

  /** Successful response (2xx) or null; failures are shown in `state` as "Failed: reason". */
  const start = useCallback(async (url: string, file: File, tag = "default"): Promise<UploadResult | null> => {
    if (running.current) return null
    running.current = true
    if (doneTimer.current) { window.clearTimeout(doneTimer.current); doneTimer.current = null }
    const name = file.name || "file"
    setState({ phase: "uploading", tag, name, loaded: 0, total: file.size })
    const result = await xhrUpload(url, file, (loaded, total) => {
      setState(loaded >= total && total > 0 ? { phase: "processing", tag, name } : { phase: "uploading", tag, name, loaded, total })
    })
    running.current = false
    if (result.status >= 200 && result.status < 300) {
      setState({ phase: "done", tag, name })
      doneTimer.current = window.setTimeout(() => setState((s) => (s.phase === "done" ? { phase: "idle" } : s)), DONE_MS)
      return result
    }
    setState({ phase: "failed", tag, name, reason: failureReason(result.status, result.body) })
    return result.status === 401 ? result : null
  }, [])

  /** Show a failure found before sending (e.g. file too big). */
  const fail = useCallback((tag: string, name: string, reason: string) => setState({ phase: "failed", tag, name, reason }), [])

  return { state, busy, start, fail }
}
