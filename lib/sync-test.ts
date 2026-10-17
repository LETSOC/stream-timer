/**
 * A/V sync test, page side (ported from agent-forge capture's syncTestOverlay, plus timecode).
 * The beep (scripts/audio-feeder.mjs syncBeep) is 1 kHz for the first 100ms of every wall-clock second;
 * the flash is held 200ms so a JPEG screencast / YouTube reliably catches at least one frame of it.
 * Frame 00 of each second is the beep frame.
 */
export const BEEP_MS = 100
export const FLASH_MS = 200
export const HEARTBEAT_STALE_MS = 1500

export function syncFlash(nowMs: number): boolean {
  return ((nowMs % 1000) + 1000) % 1000 < FLASH_MS
}

export function syncBeep(nowMs: number): boolean {
  return ((nowMs % 1000) + 1000) % 1000 < BEEP_MS
}

/** HH:MM:SS:FF of `nowMs` in `timeZone` (seconds tick exactly on the beep; FF counts frames since it). */
export function syncTimecode(nowMs: number, fps = 30, timeZone = "Europe/London"): string {
  const sec = Math.floor(nowMs / 1000)
  const ff = Math.min(fps - 1, Math.floor(((nowMs - sec * 1000) * fps) / 1000))
  let hms: string
  try {
    hms = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(sec * 1000))
  } catch {
    hms = new Date(sec * 1000).toISOString().slice(11, 19)
  }
  return `${hms}:${String(ff).padStart(2, "0")}`
}

/**
 * Should /stream draw the overlay? Only in Browser capture (URL ?capture=1 set by the encoder route, or a
 * headless/automated browser) and never in operator previews (?mute=1 deck iframe, embedded frames).
 * ?synctest=1 forces it for a manual check in a normal browser tab.
 */
export function syncTestContext(search: string, ua: string, webdriver: boolean, embedded: boolean): "capture" | "forced" | null {
  const p = new URLSearchParams(search)
  if (p.get("synctest") === "1") return "forced"
  if (embedded || p.get("mute") === "1") return null
  if (p.get("capture") === "1" || /HeadlessChrome/.test(ua) || webdriver) return "capture"
  return null
}
