/**
 * Upload feedback shared by every file upload on the desk and the visuals builder:
 * a progress state machine, the text the operator sees, and an XHR upload that reports bytes sent.
 * (fetch() has no upload progress in browsers, so uploads go through XMLHttpRequest.)
 */

export type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; tag: string; name: string; loaded: number; total: number }
  | { phase: "processing"; tag: string; name: string }
  | { phase: "done"; tag: string; name: string }
  | { phase: "failed"; tag: string; name: string; reason: string }

export type UploadResult = { status: number; body: Record<string, unknown> | null }

/** Long enough for a 100 MB video on a slow uplink; a stalled upload still ends with a reason. */
export const UPLOAD_TIMEOUT_MS = 15 * 60_000

/** Whole percent 0..100; unknown total counts as 0. */
export function uploadPercent(loaded: number, total: number): number {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.floor((loaded / total) * 100)))
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B"
  if (n < 1000) return `${Math.round(n)} B`
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)} KB`
  return `${(n / 1_000_000).toFixed(1)} MB`
}

/** One line of text for the state, e.g. "Uploading show.mp4… 42% (12.0 MB of 28.5 MB)". */
export function uploadLabel(state: UploadState): string {
  switch (state.phase) {
    case "idle": return ""
    case "uploading": return `Uploading ${state.name}… ${uploadPercent(state.loaded, state.total)}% (${formatBytes(state.loaded)} of ${formatBytes(state.total)})`
    case "processing": return `Uploading ${state.name}… 100%, saving on the server…`
    case "done": return `Done: ${state.name} uploaded.`
    case "failed": return `Failed: ${state.reason}`
  }
}

/** Why an upload failed, from the server's JSON error when it sent one. */
export function failureReason(status: number, body: Record<string, unknown> | null): string {
  const err = body && typeof body.error === "string" ? body.error.trim() : ""
  if (err) return err
  if (status === 0) return "could not reach the server (network dropped?)."
  if (status === 401) return "signed out, please log in again."
  if (status === 413) return "file is too large for the server."
  return `server returned ${status}.`
}

export function parseBody(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** POST the raw file body (the upload routes read the request body as the file) and report progress. */
export function xhrUpload(url: string, file: Blob, onProgress: (loaded: number, total: number) => void, timeoutMs = UPLOAD_TIMEOUT_MS): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", url)
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream")
    xhr.timeout = timeoutMs
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size)
    xhr.onload = () => resolve({ status: xhr.status, body: parseBody(xhr.responseText) })
    xhr.onerror = () => resolve({ status: 0, body: null })
    xhr.onabort = () => resolve({ status: 0, body: { error: "upload was cancelled." } })
    xhr.ontimeout = () => resolve({ status: 0, body: { error: "upload timed out." } })
    xhr.send(file)
  })
}
