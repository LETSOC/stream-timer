/**
 * Per-channel stream audio for the RTMP channels (Slate, Browser capture):
 *   silent  – anullsrc (as before)
 *   tone    – sine at a frequency and peak level (aevalsrc, exact level)
 *   bed     – uploaded audio file(s), looped forever (-stream_loop -1, -re), volume, optional fade-in;
 *             several files play in order or shuffled (concat list).
 * Output is always AAC 128k, 48 kHz stereo; aresample=async keeps A/V locked to the realtime video.
 *
 * Settings: data/audio-settings.json (rev'd, synced to every desk). Library: data/audio/<id>.<ext>
 * + data/audio/index.json, files validated with ffprobe on upload.
 */
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export type AudioMode = "silent" | "tone" | "bed"
export type AudioConfig = { mode: AudioMode; toneHz: number; toneDb: number; files: string[]; order: "inOrder" | "shuffle"; volumeDb: number; fadeInSec: number; /** A/V offset trim, ms: + = audio later, - = audio earlier (live). */ avOffsetMs: number; /** A/V sync test: flash + beep every second (Browser capture). */ syncTest: boolean }
export type AudioChannel = "slate" | "capture"
export type AudioSettings = { rev: number; updatedAt: number; channels: Record<AudioChannel, AudioConfig> }
export type AudioFile = { id: string; name: string; ext: string; bytes: number; durationSec: number; codec: string; createdAt: number }

export const DEFAULT_AUDIO: AudioConfig = { mode: "silent", toneHz: 1000, toneDb: -20, files: [], order: "inOrder", volumeDb: 0, fadeInSec: 0, avOffsetMs: 0, syncTest: false }
export const MAX_AUDIO_BYTES = 50_000_000
export const AUDIO_EXTS = ["mp3", "m4a", "wav", "aac"] as const
const ID = /^[a-f0-9]{24}$/

const dataDir = () => process.env.STREAM_DATA_DIR || path.join(process.cwd(), "data")
export const audioDir = () => path.join(dataDir(), "audio")
const settingsFile = () => path.join(dataDir(), "audio-settings.json")
const indexFile = () => path.join(audioDir(), "index.json")

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** Pure: anything from the client or disk → a valid config. */
export function normalizeAudio(raw: unknown): AudioConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  return {
    mode: r.mode === "tone" || r.mode === "bed" ? r.mode : "silent",
    toneHz: Math.round(clamp(r.toneHz, 20, 20000, 1000)),
    toneDb: Math.round(clamp(r.toneDb, -60, 0, -20) * 10) / 10,
    files: Array.isArray(r.files) ? r.files.filter((id): id is string => typeof id === "string" && ID.test(id)).slice(0, 50) : [],
    order: r.order === "shuffle" ? "shuffle" : "inOrder",
    volumeDb: Math.round(clamp(r.volumeDb, -40, 12, 0) * 10) / 10,
    fadeInSec: Math.round(clamp(r.fadeInSec, 0, 30, 0) * 10) / 10,
    avOffsetMs: Math.round(clamp(r.avOffsetMs, -500, 500, 0)),
    syncTest: r.syncTest === true,
  }
}

export function readAudioSettings(): AudioSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8")) as Partial<AudioSettings>
    return { rev: Number(raw.rev) || 0, updatedAt: Number(raw.updatedAt) || 0, channels: { slate: normalizeAudio(raw.channels?.slate), capture: normalizeAudio(raw.channels?.capture) } }
  } catch {
    return { rev: 0, updatedAt: 0, channels: { slate: { ...DEFAULT_AUDIO }, capture: { ...DEFAULT_AUDIO } } }
  }
}

/** Save with optimistic concurrency: `baseRev` must match (another desk may have saved meanwhile). */
export function saveAudioSettings(channels: unknown, baseRev: unknown): { ok: true; settings: AudioSettings } | { ok: false; status: number; error: string; settings: AudioSettings } {
  const current = readAudioSettings()
  if (Number(baseRev) !== current.rev) return { ok: false, status: 409, error: "Another desk saved audio settings meanwhile. Load theirs or save again.", settings: current }
  const c = (channels && typeof channels === "object" ? channels : {}) as Record<string, unknown>
  const next: AudioSettings = { rev: current.rev + 1, updatedAt: Date.now(), channels: { slate: normalizeAudio(c.slate), capture: normalizeAudio(c.capture) } }
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(`${settingsFile()}.tmp`, JSON.stringify(next, null, 2))
  fs.renameSync(`${settingsFile()}.tmp`, settingsFile())
  return { ok: true, settings: next }
}

export function listAudioFiles(): AudioFile[] {
  try {
    const list = JSON.parse(fs.readFileSync(indexFile(), "utf8")) as AudioFile[]
    return Array.isArray(list) ? list.filter((item) => ID.test(item.id)) : []
  } catch {
    return []
  }
}
function writeIndex(list: AudioFile[]) {
  fs.mkdirSync(audioDir(), { recursive: true })
  fs.writeFileSync(`${indexFile()}.tmp`, JSON.stringify(list, null, 2))
  fs.renameSync(`${indexFile()}.tmp`, indexFile())
}
export function audioFilePath(file: Pick<AudioFile, "id" | "ext">) {
  return path.join(audioDir(), `${file.id}.${file.ext}`)
}
/** The normalized copy ffmpeg streams from (made at upload). */
export function streamFilePath(file: Pick<AudioFile, "id">) {
  return path.join(audioDir(), `${file.id}.stream.flac`)
}

/** Pure: ffprobe JSON → our extension, or why not. */
export function classifyProbe(probe: { streams?: { codec_type?: string; codec_name?: string }[]; format?: { format_name?: string; duration?: string } } | null): { ok: true; ext: (typeof AUDIO_EXTS)[number]; codec: string; durationSec: number } | { ok: false; error: string } {
  const audio = probe?.streams?.find((s) => s.codec_type === "audio")
  if (!probe || !audio) return { ok: false, error: "No audio stream found. Use MP3, M4A, WAV or AAC." }
  if (probe.streams?.some((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png")) return { ok: false, error: "That file has video. Upload audio only." }
  const format = probe.format?.format_name ?? ""
  const durationSec = Number(probe.format?.duration)
  if (!Number.isFinite(durationSec) || durationSec < 0.5) return { ok: false, error: "The audio is shorter than half a second." }
  let ext: (typeof AUDIO_EXTS)[number] | null = null
  if (format === "mp3") ext = "mp3"
  else if (format.split(",").includes("mp4") || format.split(",").includes("m4a") || format.includes("mov")) ext = "m4a"
  else if (format === "wav") ext = "wav"
  else if (format === "aac") ext = "aac"
  if (!ext) return { ok: false, error: `Unsupported format (${format || "unknown"}). Use MP3, M4A, WAV or AAC.` }
  return { ok: true, ext, codec: audio.codec_name ?? "?", durationSec: Math.round(durationSec * 100) / 100 }
}

export function saveAudioUpload(bytes: Uint8Array, rawName: unknown): { ok: true; file: AudioFile } | { ok: false; status: number; error: string } {
  if (bytes.length === 0) return { ok: false, status: 400, error: "Empty file." }
  if (bytes.length > MAX_AUDIO_BYTES) return { ok: false, status: 413, error: `Audio is over ${MAX_AUDIO_BYTES / 1e6} MB.` }
  fs.mkdirSync(audioDir(), { recursive: true })
  const id = crypto.randomBytes(12).toString("hex")
  const tmp = path.join(audioDir(), `${id}.upload`)
  fs.writeFileSync(tmp, bytes)
  const result = spawnSync(/* turbopackIgnore: true */ process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name:format=format_name,duration", "-of", "json", /* turbopackIgnore: true */ tmp], { encoding: "utf8", timeout: 15000 })
  let probe = null
  try { probe = JSON.parse(result.stdout) } catch { /* not media */ }
  const verdict = result.status === 0 ? classifyProbe(probe) : { ok: false as const, error: result.error ? "ffprobe is not installed." : "Not a readable audio file." }
  if (!verdict.ok) {
    fs.rmSync(tmp, { force: true })
    return { ok: false, status: 415, error: verdict.error }
  }
  const name = (typeof rawName === "string" ? rawName : "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120) || `audio.${verdict.ext}`
  const file: AudioFile = { id, name, ext: verdict.ext, bytes: bytes.length, durationSec: verdict.durationSec, codec: verdict.codec, createdAt: Date.now() }
  fs.renameSync(tmp, audioFilePath(file))
  // Streaming copy: FLAC 48 kHz stereo, so playlists mixing MP3/M4A/WAV/AAC concat cleanly (the concat demuxer needs one codec) and loops are gapless.
  const norm = spawnSync(/* turbopackIgnore: true */ process.env.FFMPEG_BIN || "ffmpeg", ["-nostdin", "-v", "error", "-y", "-i", /* turbopackIgnore: true */ audioFilePath(file), "-vn", "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-sample_fmt", "s16", "-c:a", "flac", /* turbopackIgnore: true */ streamFilePath(file)], { timeout: 180000 })
  if (norm.status !== 0) {
    fs.rmSync(audioFilePath(file), { force: true })
    fs.rmSync(streamFilePath(file), { force: true })
    return { ok: false, status: 415, error: "Could not decode that audio file." }
  }
  writeIndex([...listAudioFiles(), file])
  return { ok: true, file }
}

export function deleteAudioFile(id: unknown): boolean {
  const list = listAudioFiles()
  const file = list.find((item) => item.id === id)
  if (!file) return false
  fs.rmSync(audioFilePath(file), { force: true })
  fs.rmSync(streamFilePath(file), { force: true })
  writeIndex(list.filter((item) => item.id !== id))
  return true
}

/** Pure: same config → same hash (shown as "restart to apply" when the live channel differs). */
export function audioHash(config: AudioConfig): string {
  return crypto.createHash("sha256").update(JSON.stringify(normalizeAudio(config))).digest("hex").slice(0, 12)
}

const AUDIO_OUT = "aresample=48000:async=1000:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
export const SILENT_ARGS = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]

export type AudioPlan = { mode: AudioMode; args: string[]; filter: string; requires: string[]; warning: string | null; concatList: string | null }

/**
 * Pure: the ffmpeg audio input (one input, mapped as the 2nd input) and its filter.
 * `files` = resolved library entries for config.files (missing ones = null).
 */
export function planAudio(config: AudioConfig, files: (AudioFile | null)[], opts: { dir: string; concatPath: string; random?: () => number }): AudioPlan {
  if (config.mode === "tone") {
    const amp = Math.pow(10, config.toneDb / 20).toFixed(6)
    const expr = `${amp}*sin(2*PI*${config.toneHz}*t)`
    return { mode: "tone", args: ["-f", "lavfi", "-i", `aevalsrc=exprs=${expr}|${expr}:sample_rate=48000:channel_layout=stereo`], filter: AUDIO_OUT, requires: [], warning: null, concatList: null }
  }
  if (config.mode === "bed") {
    const present = files.filter((item): item is AudioFile => item !== null)
    const missing = files.length - present.length
    if (present.length === 0) {
      return { mode: "silent", args: SILENT_ARGS, filter: AUDIO_OUT, requires: [], warning: files.length ? "Audio bed file is missing; streaming silence." : "No audio bed file chosen; streaming silence.", concatList: null }
    }
    const order = config.order === "shuffle" ? shuffle(present, opts.random ?? Math.random) : present
    const paths = order.map((file) => path.join(opts.dir, `${file.id}.stream.flac`))
    const filters = [`volume=${config.volumeDb}dB`, AUDIO_OUT]
    if (config.fadeInSec > 0) filters.push(`afade=t=in:st=0:d=${config.fadeInSec}`)
    const warning = missing ? `${missing} audio file(s) missing; playing the rest.` : null
    if (paths.length === 1) {
      return { mode: "bed", args: ["-re", "-stream_loop", "-1", "-i", paths[0]], filter: filters.join(","), requires: paths, warning, concatList: null }
    }
    // Several files: concat demuxer playlist, looped as a whole.
    const list = paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n"
    return { mode: "bed", args: ["-re", "-stream_loop", "-1", "-f", "concat", "-safe", "0", "-i", opts.concatPath], filter: filters.join(","), requires: [...paths, opts.concatPath], warning, concatList: list }
  }
  return { mode: "silent", args: SILENT_ARGS, filter: AUDIO_OUT, requires: [], warning: null, concatList: null }
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Pure: the args file scripts read (one arg per line, @requires / @filter lines). */
export function serializePlan(plan: AudioPlan): string {
  return [...plan.requires.map((p) => `@requires ${p}`), `@filter ${plan.filter}`, ...plan.args].join("\n") + "\n"
}

/** Writes data/rtmp-audio-<channel>.args (+ playlist) for a channel start. Returns what will play. */
export function prepareChannelAudio(channel: AudioChannel): { argsFile: string; plan: AudioPlan; hash: string; liveFile: string; appliedFile: string; live: LiveAudio } {
  const config = readAudioSettings().channels[channel]
  const library = new Map(listAudioFiles().map((item) => [item.id, item]))
  const resolved = config.files.map((id) => {
    const file = library.get(id)
    return file && fs.existsSync(streamFilePath(file)) ? file : null
  })
  const concatPath = path.join(dataDir(), `rtmp-audio-${channel}.txt`)
  const plan = planAudio(config, resolved, { dir: audioDir(), concatPath })
  if (plan.concatList) fs.writeFileSync(concatPath, plan.concatList)
  const argsFile = path.join(dataDir(), `rtmp-audio-${channel}.args`)
  fs.writeFileSync(argsFile, serializePlan(plan))
  fs.rmSync(appliedAudioFile(channel), { force: true })
  const live = writeLiveAudio(channel)
  return { argsFile, plan, hash: audioHash(config), liveFile: liveAudioFile(channel), appliedFile: appliedAudioFile(channel), live }
}

// ---------- live (hot-swapped) audio: scripts/audio-feeder.mjs ----------

/** What the feeder plays. Files are absolute paths to the normalized stream copies. */
export type LiveAudio = { hash: string; avOffsetMs: number; syncTest: boolean; mode: AudioMode; toneHz: number; toneDb: number; volumeDb: number; fadeInSec: number; files: string[]; shuffle: boolean; warning: string | null }
/** What the feeder says is on air (written by it about once a second). */
export type AppliedAudio = { hash: string | null; mode: AudioMode; at: number; warning: string | null; peakDb: number | null; underruns: number; pending: string | null; updatedAt: number }

/** Pure: saved config + resolved library entries → the feeder's live plan. Missing files are skipped. */
export function liveAudioPlan(config: AudioConfig, files: (AudioFile | null)[], dir: string): LiveAudio {
  const present = files.filter((item): item is AudioFile => item !== null)
  const missing = files.length - present.length
  const base = { hash: audioHash(config), avOffsetMs: config.avOffsetMs, syncTest: config.syncTest, toneHz: config.toneHz, toneDb: config.toneDb, volumeDb: config.volumeDb, fadeInSec: config.fadeInSec, shuffle: config.order === "shuffle" }
  if (config.mode === "tone") return { ...base, mode: "tone", files: [], warning: null }
  if (config.mode === "bed") {
    if (present.length === 0) return { ...base, mode: "silent", files: [], warning: files.length ? "Audio bed file is missing; streaming silence." : "No audio bed file chosen; streaming silence." }
    return { ...base, mode: "bed", files: present.map((file) => path.join(dir, `${file.id}.stream.flac`)), warning: missing ? `${missing} audio file(s) missing; playing the rest.` : null }
  }
  return { ...base, mode: "silent", files: [], warning: null }
}

export const liveAudioFile = (channel: AudioChannel) => path.join(dataDir(), `rtmp-audio-${channel}.live.json`)
export const appliedAudioFile = (channel: AudioChannel) => path.join(dataDir(), `rtmp-audio-${channel}.applied.json`)

/** Writes what a channel's feeder should play now (atomic; the feeder picks it up within ~250ms). */
export function writeLiveAudio(channel: AudioChannel): LiveAudio {
  const config = readAudioSettings().channels[channel]
  const library = new Map(listAudioFiles().map((item) => [item.id, item]))
  const resolved = config.files.map((id) => {
    const file = library.get(id)
    return file && fs.existsSync(streamFilePath(file)) ? file : null
  })
  const plan = liveAudioPlan(config, resolved, audioDir())
  fs.mkdirSync(dataDir(), { recursive: true })
  const file = liveAudioFile(channel)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(plan), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
  return plan
}

export function readAppliedAudio(channel: AudioChannel): AppliedAudio | null {
  try {
    const raw = JSON.parse(fs.readFileSync(appliedAudioFile(channel), "utf8")) as AppliedAudio
    return raw && typeof raw === "object" ? raw : null
  } catch {
    return null
  }
}
