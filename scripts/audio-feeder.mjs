#!/usr/bin/env node
// Live stream audio feeder: silence / tone / audio bed (one file or a playlist), as raw PCM
// (s16le, 48 kHz, stereo), switchable while the channel is live.
//
// The video encoder reads this as a plain PCM input that never ends, so changing the audio never
// restarts ffmpeg or the RTMP connection. The server writes the wanted settings to AUDIO_LIVE_FILE
// (JSON, see lib/audio-bed.ts liveAudioPlan); this polls it every 250ms and crossfades (300ms, or
// the bed's fade-in) to the new source. Volume-only changes ramp the gain (200ms) on the playing
// source. Beds are decoded by short-lived ffmpeg children (one per file, so a playlist just moves on);
// a missing/broken file or a slow decoder plays silence instead of stalling the stream.
// What is on air goes to AUDIO_APPLIED_FILE (hash, mode, peak dBFS, underruns) once a second.
//
// Used two ways: imported by capture-stream.mjs (createAudioFeeder: it pulls blocks on its own
// wall-clock audio timer), and as a CLI for the Slate (stream-countdown.sh): writes wall-clock-paced
// PCM to stdout, which the script hands to ffmpeg as fd 3. Exits when the reader goes away.
import { spawn } from "node:child_process"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

export const RATE = 48000
const FRAME = 4 // bytes per stereo s16 frame
const XFADE_SEC = 0.3
const GAIN_RAMP_SEC = 0.2
const BED_AHEAD_SEC = 2
const dbToGain = (db) => Math.pow(10, db / 20)

/** Pure: which source a config plays. Same key = only the gain changed (no source switch). */
export function sourceKey(cfg) {
  if (!cfg || cfg.mode === "silent") return "silent"
  if (cfg.mode === "tone") return `tone:${cfg.toneHz}:${cfg.toneDb}`
  if (cfg.mode === "bed") return cfg.files?.length ? `bed:${cfg.shuffle ? "shuffle" : "order"}:${cfg.files.join("|")}` : "silent"
  return "silent"
}
/** Pure: the source's own gain (bed volume; tone level is in the generator). */
export function sourceGain(cfg) {
  return cfg?.mode === "bed" && cfg.files?.length ? dbToGain(Number(cfg.volumeDb) || 0) : 1
}

class Silence {
  constructor() { this.kind = "silent" }
  ready() { return true }
  read(n) { return new Float32Array(n * 2) }
  stop() {}
}

class Tone {
  constructor(hz, db) { this.kind = "tone"; this.step = (2 * Math.PI * hz) / RATE; this.amp = dbToGain(db); this.phase = 0 }
  ready() { return true }
  read(n) {
    const out = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      const v = this.amp * Math.sin(this.phase)
      this.phase += this.step
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI
      out[i * 2] = v
      out[i * 2 + 1] = v
    }
    return out
  }
  stop() {}
}

class Bed {
  constructor(files, shuffle, ffmpegBin, env, log) {
    this.kind = "bed"
    this.files = files
    this.shuffle = shuffle
    this.ffmpegBin = ffmpegBin
    this.env = env
    this.log = log
    this.order = this.makeOrder()
    this.index = 0
    this.chunks = []
    this.bytes = 0
    this.child = null
    this.stopped = false
    this.primed = false
    this.underruns = 0
    this.failures = 0
    this.retryAt = 0
    this.next()
  }
  makeOrder() {
    const order = this.files.map((_, i) => i)
    if (this.shuffle) for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
    return order
  }
  next() {
    if (this.stopped || this.child) return
    if (Date.now() < this.retryAt) { setTimeout(() => this.next(), this.retryAt - Date.now()); return }
    if (this.index >= this.order.length) { this.index = 0; this.order = this.makeOrder() }
    const file = this.files[this.order[this.index++]]
    if (!fs.existsSync(file)) { this.fail(`missing ${file.split("/").pop()}`); return }
    let got = 0
    const child = spawn(this.ffmpegBin, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "2", "-ar", String(RATE), "-f", "s16le", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"], env: this.env })
    this.child = child
    let carry = Buffer.alloc(0)
    child.stdout.on("data", (data) => {
      // Keep whole stereo frames only (pipe reads can split a sample).
      const all = carry.length ? Buffer.concat([carry, data]) : data
      const cut = all.length - (all.length % FRAME)
      carry = all.subarray(cut)
      const chunk = all.subarray(0, cut)
      if (!chunk.length) return
      got += chunk.length
      this.chunks.push(chunk)
      this.bytes += chunk.length
      // Decode ahead at most BED_AHEAD_SEC (backpressure through the pipe pauses ffmpeg).
      if (this.bytes > BED_AHEAD_SEC * RATE * FRAME) child.stdout.pause()
    })
    child.on("error", () => undefined)
    child.on("close", () => {
      if (this.child === child) this.child = null
      if (this.stopped) return
      if (got === 0) this.fail("could not decode a bed file")
      else { this.failures = 0; this.next() }
    })
  }
  fail(why) {
    this.failures += 1
    if (this.failures <= 3 || this.failures % 20 === 0) this.log?.(`[audio] ${why}; silence until the next file`)
    // Every file failing: try again in a second (silence meanwhile), never spin.
    if (this.failures >= this.files.length) this.retryAt = Date.now() + 1000
    this.next()
  }
  ready() { return this.bytes >= 0.2 * RATE * FRAME || this.failures >= this.files.length }
  read(n) {
    const out = new Float32Array(n * 2)
    const want = n * FRAME
    let at = 0
    while (at < want && this.chunks.length) {
      const head = this.chunks[0]
      const take = Math.min(head.length, want - at)
      for (let i = 0; i < take; i += 2) out[(at + i) / 2] = head.readInt16LE(i) / 32768
      at += take
      if (take === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
    }
    this.bytes -= at
    if (at > 0) this.primed = true
    if (at < want && this.primed) this.underruns += 1
    if (this.child && this.bytes < BED_AHEAD_SEC * RATE * FRAME * 0.5) this.child.stdout.resume()
    return out
  }
  stop() { this.stopped = true; try { this.child?.kill("SIGKILL") } catch { /* gone */ } this.child = null; this.chunks = []; this.bytes = 0 }
}

/**
 * A mixer of "voices" (sources with a ramped gain). A new config = a new voice that fades in
 * once it has audio (≤1.5s wait), while the old ones fade out. read(n) → Buffer (s16le stereo).
 */
export function createAudioFeeder({ liveFile, appliedFile, ffmpegBin = "ffmpeg", env = process.env, log = () => undefined, pollMs = 250 }) {
  const voices = [] // { src, gain, target, step, key, cfg }
  let pending = null // { voice, since }
  let wanted = null // cfg
  let applied = { hash: null, mode: "silent", at: 0, key: "silent", warning: null }
  let lastMtime = 0
  let peak = 0
  let underruns = 0
  let readerErrors = 0

  const makeSource = (cfg) => {
    if (!cfg || cfg.mode === "silent" || (cfg.mode === "bed" && !cfg.files?.length)) return new Silence()
    if (cfg.mode === "tone") return new Tone(cfg.toneHz, cfg.toneDb)
    return new Bed(cfg.files, cfg.shuffle === true, ffmpegBin, env, log)
  }
  const rampStep = (from, to, sec) => Math.abs(to - from) / Math.max(1, sec * RATE)

  function apply(cfg) {
    wanted = cfg
    const key = sourceKey(cfg)
    const current = pending?.voice ?? voices.find((v) => v.target > 0)
    if (current && current.key === key) {
      // Same source: volume (or fade setting) only. Ramp, no switch.
      current.target = sourceGain(cfg)
      current.step = rampStep(current.gain, current.target, GAIN_RAMP_SEC)
      current.cfg = cfg
      if (!pending) markApplied(cfg, key)
      return
    }
    if (pending) { pending.voice.src.stop() }
    pending = { voice: { src: makeSource(cfg), gain: 0, target: sourceGain(cfg), step: 0, key, cfg }, since: Date.now() }
    log(`[audio] switching to ${describe(cfg)}`)
  }
  function describe(cfg) {
    if (!cfg || cfg.mode === "silent") return "silence"
    if (cfg.mode === "tone") return `tone ${cfg.toneHz} Hz ${cfg.toneDb} dBFS`
    return cfg.files?.length ? `audio bed (${cfg.files.length} file${cfg.files.length === 1 ? "" : "s"}${cfg.shuffle ? ", shuffled" : ""}, ${cfg.volumeDb} dB)` : "silence (no bed file)"
  }
  function markApplied(cfg, key) {
    applied = { hash: cfg?.hash ?? null, mode: key === "silent" ? "silent" : cfg.mode, at: Date.now(), key, warning: cfg?.warning ?? null }
    writeApplied()
  }
  function startPending() {
    if (!pending) return
    const ready = pending.voice.src.ready()
    if (!ready && Date.now() - pending.since < 1500) return
    const v = pending.voice
    const fadeIn = v.cfg?.mode === "bed" && Number(v.cfg.fadeInSec) > 0 ? Number(v.cfg.fadeInSec) : XFADE_SEC
    v.step = rampStep(0, v.target, fadeIn)
    for (const old of voices) { old.target = 0; old.step = rampStep(old.gain, 0, XFADE_SEC) }
    voices.push(v)
    pending = null
    markApplied(v.cfg, v.key)
  }

  function poll() {
    if (!liveFile) return
    let st = null
    try { st = fs.statSync(liveFile) } catch { return }
    if (st.mtimeMs === lastMtime) return
    lastMtime = st.mtimeMs
    try {
      const cfg = JSON.parse(fs.readFileSync(liveFile, "utf8"))
      if (!wanted || cfg.hash !== wanted.hash || sourceKey(cfg) !== sourceKey(wanted) || sourceGain(cfg) !== sourceGain(wanted)) apply(cfg)
    } catch { readerErrors += 1 }
  }

  function writeApplied() {
    if (!appliedFile) return
    const out = { ...applied, peakDb: peak > 0 ? +(20 * Math.log10(peak)).toFixed(1) : null, underruns, readErrors: readerErrors, pending: pending ? describe(pending.voice.cfg) : null, updatedAt: Date.now() }
    try { fs.writeFileSync(`${appliedFile}.tmp`, JSON.stringify(out), { mode: 0o600 }); fs.renameSync(`${appliedFile}.tmp`, appliedFile) } catch { /* data dir gone */ }
  }

  poll()
  if (!wanted) apply({ mode: "silent", hash: null })
  startPending()
  const pollTimer = setInterval(() => { poll(); startPending() }, pollMs)
  const statTimer = setInterval(() => { underruns = voices.reduce((s, v) => s + (v.src.underruns ?? 0), 0); writeApplied(); peak = 0 }, 1000)
  pollTimer.unref?.(); statTimer.unref?.()

  /**
   * n frames of the mix as float stereo (for callers that mix more in, e.g. program audio).
   * wallMs = the wall-clock time the first frame stands for (A/V sync test: beeps on each second).
   */
  function readFloat(n, wallMs = Date.now()) {
    startPending()
    if (wanted?.syncTest) return syncBeep(n, wallMs)
    const mix = new Float32Array(n * 2)
    for (const v of voices) {
      const data = v.src.read(n)
      let g = v.gain
      for (let i = 0; i < n; i++) {
        if (g < v.target) g = Math.min(v.target, g + v.step)
        else if (g > v.target) g = Math.max(v.target, g - v.step)
        mix[i * 2] += data[i * 2] * g
        mix[i * 2 + 1] += data[i * 2 + 1] * g
      }
      v.gain = g
    }
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].gain === 0 && voices[i].target === 0) { voices[i].src.stop(); voices.splice(i, 1) }
    for (let i = 0; i < mix.length; i++) { const a = Math.abs(mix[i]); if (a > peak) peak = a }
    return mix
  }
  function read(n, wallMs) { return toS16(readFloat(n, wallMs)) }
  function stop() { clearInterval(pollTimer); clearInterval(statTimer); for (const v of voices) v.src.stop(); pending?.voice.src.stop() }
  /** Live sync settings from the desk: A/V offset trim (ms, + = audio later) and the sync test switch. */
  const sync = () => ({ avOffsetMs: Math.max(-500, Math.min(500, Number(wanted?.avOffsetMs) || 0)), syncTest: wanted?.syncTest === true })
  return { read, readFloat, stop, sync, status: () => ({ ...applied, ...sync(), voices: voices.length, pending: pending !== null }) }
}

/** A/V sync test: a 1 kHz beep (-12 dBFS) for the first 100ms of every wall-clock second, silence otherwise. */
export function syncBeep(n, wallMs) {
  const out = new Float32Array(n * 2)
  const amp = dbToGain(-12)
  for (let i = 0; i < n; i++) {
    const t = wallMs + (i * 1000) / RATE
    const ms = ((t % 1000) + 1000) % 1000
    if (ms < 100) {
      const v = amp * Math.sin((2 * Math.PI * 1000 * t) / 1000)
      out[i * 2] = v
      out[i * 2 + 1] = v
    }
  }
  return out
}

/**
 * Fixed audio delay (float stereo). setDelay jumps (rare, manual trims). Used for the A/V offset trim
 * and Browser capture's screencast-lag compensation.
 */
export function createDelayLine() {
  let buf = new Float32Array(0) // queued frames (interleaved)
  let delay = 0 // frames
  return {
    setDelayMs(ms) { delay = Math.max(0, Math.round((ms * RATE) / 1000)) },
    delayMs() { return (delay * 1000) / RATE },
    process(input) {
      const n = input.length / 2
      if (delay === 0 && buf.length === 0) return input
      const joined = new Float32Array(buf.length + input.length)
      joined.set(buf); joined.set(input, buf.length)
      const total = joined.length / 2
      const need = n + delay
      let out
      if (total >= need) {
        // Enough: output the oldest n frames beyond the delay, keep `delay` frames queued (drops any surplus after a shorter delay).
        const start = total - need
        out = joined.subarray(start * 2, (start + n) * 2)
        buf = joined.slice((start + n) * 2)
      } else {
        // Delay grew: pad with silence first.
        const pad = need - total
        out = new Float32Array(n * 2)
        if (pad >= n) buf = joined
        else {
          const take = n - pad
          out.set(joined.subarray(0, take * 2), pad * 2)
          buf = joined.slice(take * 2)
        }
      }
      return out
    },
  }
}

export function toS16(mix) {
  const out = Buffer.allocUnsafe(mix.length * 2)
  for (let i = 0; i < mix.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[i] * 32767))), i * 2)
  return out
}

// ---------- CLI (Slate): paced PCM on stdout ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const env = { ...process.env }
  for (const k of ["RTMP_URL", "ENCODER_TOKEN", "CAPTURE_URL", "CAPTURE_KEY_FILE", "PROGRAM_READ_FILE"]) delete env[k]
  const log = (msg) => process.stderr.write(`${msg}\n`)
  const feeder = createAudioFeeder({ liveFile: process.env.AUDIO_LIVE_FILE, appliedFile: process.env.AUDIO_APPLIED_FILE, ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg", env, log })
  const out = process.stdout
  const done = () => { feeder.stop(); process.exit(0) }
  out.on("error", done)
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, done)
  const startedAt = Date.now()
  let written = 0
  const line = createDelayLine()
  // 100ms head start so ffmpeg never waits on audio at the start; then exactly wall-clock rate.
  const LEAD = Math.round(0.1 * RATE)
  setInterval(() => {
    const due = Math.floor(((Date.now() - startedAt) * RATE) / 1000) + LEAD - written
    if (due <= 0) return
    const n = Math.min(due, RATE)
    // Slate: + trim delays the audio; the video is ffmpeg's own, so a negative trim can't move audio earlier.
    line.setDelayMs(Math.max(0, feeder.sync().avOffsetMs))
    if (!out.write(toS16(line.process(feeder.readFloat(n, startedAt + (written * 1000) / RATE))))) { /* ffmpeg is behind: it will drain; keep pace by wall clock */ }
    written += due
  }, 20)
}
