import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { DEFAULT_AUDIO, liveAudioPlan, type AudioFile } from "@/lib/audio-bed"
// @ts-expect-error plain ESM script without types
import { createAudioFeeder, createDelayLine, sourceGain, sourceKey, syncBeep } from "../scripts/audio-feeder.mjs"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const peak = (a: Float32Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
const file = (id: string): AudioFile => ({ id, name: id, ext: "mp3", bytes: 1, durationSec: 1, codec: "mp3", createdAt: 0 })

test("liveAudioPlan: modes, missing files, shuffle flag", () => {
  assert.equal(liveAudioPlan(DEFAULT_AUDIO, [], "/a").mode, "silent")
  const t = liveAudioPlan({ ...DEFAULT_AUDIO, mode: "tone", toneHz: 440, toneDb: -12 }, [], "/a")
  assert.deepEqual([t.mode, t.toneHz, t.toneDb], ["tone", 440, -12])
  const b = liveAudioPlan({ ...DEFAULT_AUDIO, mode: "bed", files: ["x", "y"], order: "shuffle", volumeDb: -6 }, [file("x"), null], "/a")
  assert.deepEqual(b.files, ["/a/x.stream.flac"]); assert.equal(b.shuffle, true); assert.match(b.warning ?? "", /1 audio file/)
  assert.equal(liveAudioPlan({ ...DEFAULT_AUDIO, mode: "bed", files: ["x"] }, [null], "/a").mode, "silent")
  const o = liveAudioPlan({ ...DEFAULT_AUDIO, avOffsetMs: -40, syncTest: true }, [], "/a")
  assert.equal(o.avOffsetMs, -40); assert.equal(o.syncTest, true)
})

test("sourceKey: volume is not a source change; tone/files are", () => {
  const bed = { mode: "bed", files: ["/a"], shuffle: false, volumeDb: 0 }
  assert.equal(sourceKey(bed), sourceKey({ ...bed, volumeDb: -10 }))
  assert.notEqual(sourceKey(bed), sourceKey({ ...bed, files: ["/a", "/b"] }))
  assert.notEqual(sourceKey({ mode: "tone", toneHz: 440, toneDb: -20 }), sourceKey({ mode: "tone", toneHz: 880, toneDb: -20 }))
  assert.equal(sourceKey({ mode: "bed", files: [] }), "silent")
  assert.ok(Math.abs(sourceGain({ ...bed, volumeDb: -20 }) - 0.1) < 1e-9)
})

test("feeder hot-swaps silent → tone → bed → volume without a new process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feeder-"))
  const live = path.join(dir, "live.json")
  const applied = path.join(dir, "applied.json")
  const write = (cfg: object) => { fs.writeFileSync(`${live}.tmp`, JSON.stringify(cfg)); fs.renameSync(`${live}.tmp`, live) }
  write({ hash: "s", mode: "silent", files: [] })
  const feeder = createAudioFeeder({ liveFile: live, appliedFile: applied, pollMs: 50 })
  try {
  const pull = (sec: number) => feeder.readFloat(Math.round(sec * 48000)) as Float32Array
  assert.equal(peak(pull(0.2)), 0)
  write({ hash: "t", mode: "tone", toneHz: 1000, toneDb: -20, files: [] })
  await sleep(150)
  pull(0.5) // crossfade (300ms)
  assert.ok(Math.abs(peak(pull(0.1)) - 0.1) < 0.005, "tone at -20 dBFS")
  const wav = path.join(dir, "bed.wav")
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=2:sample_rate=48000", "-af", "volume=-6dB", "-ac", "2", "-y", wav])
  if (made.status === 0) {
    write({ hash: "b", mode: "bed", files: [wav], shuffle: false, volumeDb: 0, fadeInSec: 0 })
    for (let i = 0; i < 30 && feeder.status().hash !== "b"; i++) { await sleep(50); pull(0.05) }
    assert.equal(feeder.status().hash, "b")
    pull(0.4)
    const full = peak(pull(0.2))
    write({ hash: "b2", mode: "bed", files: [wav], shuffle: false, volumeDb: -12, fadeInSec: 0 })
    await sleep(150)
    pull(0.3) // 200ms gain ramp
    const quiet = peak(pull(0.2))
    assert.ok(full > 0.02 && Math.abs(20 * Math.log10(quiet / full) + 12) < 1, `volume -12 dB (${full} → ${quiet})`)
    assert.equal(feeder.status().voices, 1, "volume change ramps the same source")
  }
  } finally {
    feeder.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("delay line: exact delay, grow and shrink", () => {
  const line = createDelayLine()
  const ramp = (from: number, n: number) => Float32Array.from({ length: n * 2 }, (_, i) => from + Math.floor(i / 2) + 1)
  line.setDelayMs(1) // 48 frames
  const a = line.process(ramp(0, 32)) as Float32Array
  assert.equal(peak(a), 0, "first 32 frames: silence")
  const b = line.process(ramp(32, 32)) as Float32Array
  assert.equal(b[0], 0); assert.equal(b[2 * 16], 1, "frame 1 comes out 48 frames late")
  line.setDelayMs(0)
  const c = line.process(ramp(64, 8)) as Float32Array
  assert.equal(c[0], 65, "shrinking drops the queue")
})

test("sync beep: 100ms of 1 kHz at each wall second", () => {
  const b = syncBeep(48000, 999_000) as Float32Array
  const on = (ms: number) => Math.abs(b[Math.round((ms * 48)) * 2]) + Math.abs(b[(Math.round(ms * 48) + 6) * 2])
  assert.ok(on(1.2) > 0.01 && on(50) > 0.01)
  assert.equal(on(150), 0); assert.equal(on(900), 0)
})
