/**
 * Program source (Main = OBS on /program, Backup = /program-backup: a second computer or a pulled URL)
 * and the auto-failover rule. Pure, safe to import from client components.
 */
export type ProgramSource = "main" | "backup"
export const PROGRAM_SOURCES: readonly ProgramSource[] = ["main", "backup"]
export const SOURCE_PATH: Record<ProgramSource, string> = { main: "program", backup: "program-backup" }
export const SOURCE_LABEL: Record<ProgramSource, string> = { main: "Main", backup: "Backup" }

export type FailoverSettings = {
  /** Switch Main → Backup by itself when Main stalls. Default off. */
  auto: boolean
  /** Main counts as stalled after this many seconds without new data (or not publishing). */
  stallSec: number
  /** After failover, go back to Main once it has been healthy this long (when autoReturn). */
  returnSec: number
  /** false = stay on Backup until the operator switches back. */
  autoReturn: boolean
  /** Main↔Backup switch buffer, ms: the incoming input plays this long (hidden) before it goes on air. */
  switchBufferMs: number
}
export const DEFAULT_FAILOVER: FailoverSettings = { auto: false, stallSec: 3, returnSec: 10, autoReturn: true, switchBufferMs: 1000 }

export function parseFailover(raw: unknown): FailoverSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)
  return {
    auto: r.auto === true,
    stallSec: num(r.stallSec, 1, 60, DEFAULT_FAILOVER.stallSec),
    returnSec: num(r.returnSec, 2, 600, DEFAULT_FAILOVER.returnSec),
    autoReturn: r.autoReturn !== false,
    switchBufferMs: num(r.switchBufferMs, 0, 5000, DEFAULT_FAILOVER.switchBufferMs),
  }
}

/** One input as the server sees it. `dataAgeMs` = time since MediaMTX last received bytes (≈ last frame age). */
export type SourceHealth = { ready: boolean; kbps: number | null; dataAgeMs: number | null }
export const EMPTY_SOURCE: SourceHealth = { ready: false, kbps: null, dataAgeMs: null }

/** Publishing and data arriving within `stallMs`. */
export function healthy(h: SourceHealth, stallMs: number): boolean {
  return h.ready && h.dataAgeMs !== null && h.dataAgeMs < stallMs
}

/** What the monitor remembers between ticks. */
export type FailoverMemory = { mainBadSince: number | null; mainGoodSince: number | null; backupBadSince?: number | null; /** we switched to backup by ourselves (auto-return only undoes our own switch) */ failedOver: boolean }
export const FRESH_MEMORY: FailoverMemory = { mainBadSince: null, mainGoodSince: null, failedOver: false }

export type FailoverStep = { memory: FailoverMemory; switchTo: ProgramSource | null; reason: string | null }

/**
 * One tick. Main is "bad" while not healthy; after stallSec bad (and Backup healthy) → Backup.
 * After an automatic failover, Main healthy for returnSec → back to Main (if autoReturn).
 * An operator's manual choice is never overridden except by a new stall of Main while on Main.
 */
export function failoverStep(input: { active: ProgramSource; main: SourceHealth; backup: SourceHealth; settings: FailoverSettings; memory: FailoverMemory; now: number }): FailoverStep {
  const { active, main, backup, settings, now } = input
  const tickMs = 1000 // health granularity: data age under a second counts as "flowing"
  const mainOk = healthy(main, Math.max(tickMs, 1500))
  const backupOk = healthy(backup, 1500)
  const memory: FailoverMemory = {
    mainBadSince: mainOk ? null : (input.memory.mainBadSince ?? now),
    mainGoodSince: mainOk ? (input.memory.mainGoodSince ?? now) : null,
    failedOver: active === "backup" ? input.memory.failedOver : false,
    backupBadSince: backupOk ? null : (input.memory.backupBadSince ?? now),
  }
  if (!settings.auto) return { memory: { ...memory, failedOver: false }, switchTo: null, reason: null }
  if (active === "main" && memory.mainBadSince !== null && now - memory.mainBadSince >= settings.stallSec * 1000 && backupOk) {
    return { memory: { ...memory, failedOver: true }, switchTo: "backup", reason: `Main stalled ${Math.round((now - memory.mainBadSince) / 1000)}s` }
  }
  // On Backup (by hand or by us) and Backup dies while Main is fine: don't sit on a dead input.
  if (active === "backup" && memory.backupBadSince != null && now - memory.backupBadSince >= settings.stallSec * 1000 && mainOk) {
    return { memory: { ...memory, failedOver: false }, switchTo: "main", reason: `Backup stalled ${Math.round((now - memory.backupBadSince) / 1000)}s` }
  }
  if (active === "backup" && memory.failedOver && settings.autoReturn && memory.mainGoodSince !== null && now - memory.mainGoodSince >= settings.returnSec * 1000) {
    return { memory: { ...memory, failedOver: false }, switchTo: "main", reason: `Main healthy ${settings.returnSec}s` }
  }
  return { memory, switchTo: null, reason: null }
}

export type FailoverEvent = { at: number; from: ProgramSource; to: ProgramSource; reason: string; auto: boolean }

const WEB_PAGE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|twitch\.tv|facebook\.com|fb\.watch|vimeo\.com|ustream\.tv|video\.ibm\.com|kick\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|dailymotion\.com)$/i
/** Why a backup pull URL can't be used (null = fine; "" = off). MediaMTX pulls streams, not web pages. */
export function pullUrlError(url: string): string | null {
  if (url === "") return null
  if (url.length > 2000) return "Pull URL is too long."
  if (/[\s'"`\\<>{}|^]/.test(url) || /[\u0000-\u001f]/.test(url)) return "Pull URL has spaces or characters a stream URL can't contain."
  let u: URL
  try { u = new URL(url) } catch { return "Not a URL. Use rtmp://, rtsp://, srt:// or an HLS https://…/….m3u8 address." }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase()
  if (!u.hostname) return "Pull URL has no host."
  if (["rtmp", "rtmps", "rtsp", "rtsps", "srt"].includes(scheme)) return null
  if (scheme === "http" || scheme === "https") {
    if (WEB_PAGE_HOSTS.test(u.hostname)) return `${u.hostname} is a web page, not a stream URL. Pull needs the stream itself: rtmp://, rtsp://, srt:// or an HLS .m3u8 link (YouTube/Twitch watch pages can't be pulled).`
    if (/\.m3u8$/i.test(u.pathname)) return null
    return "http(s) pull must be an HLS playlist ending in .m3u8 (web pages can't be pulled). Otherwise use rtmp://, rtsp:// or srt://."
  }
  return `${scheme}:// isn't supported. Use rtmp://, rtsp://, srt:// or an HLS .m3u8 link.`
}
