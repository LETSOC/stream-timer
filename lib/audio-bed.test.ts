import test from "node:test"
import assert from "node:assert/strict"
import { audioHash, classifyProbe, DEFAULT_AUDIO, normalizeAudio, planAudio, serializePlan, type AudioFile } from "@/lib/audio-bed"

const f = (id: string, ext = "mp3"): AudioFile => ({ id: id.padEnd(24, "0"), name: `${id}.${ext}`, ext, bytes: 1, durationSec: 10, codec: "mp3", createdAt: 0 })
const opts = { dir: "/d", concatPath: "/d/list.txt" }

test("normalizeAudio clamps and defaults", () => {
  assert.deepEqual(normalizeAudio(null), DEFAULT_AUDIO)
  const n = normalizeAudio({ mode: "tone", toneHz: 99999, toneDb: 5, files: ["x", "a".repeat(24)], order: "shuffle", volumeDb: -100, fadeInSec: 2.25 })
  assert.equal(n.mode, "tone"); assert.equal(n.toneHz, 20000); assert.equal(n.toneDb, 0)
  assert.deepEqual(n.files, ["a".repeat(24)]); assert.equal(n.order, "shuffle"); assert.equal(n.volumeDb, -40); assert.equal(n.fadeInSec, 2.3)
  assert.equal(normalizeAudio({ mode: "evil" }).mode, "silent")
})

test("classifyProbe maps formats and rejects junk", () => {
  const a = (format_name: string, codec = "mp3") => classifyProbe({ streams: [{ codec_type: "audio", codec_name: codec }], format: { format_name, duration: "12.3" } })
  assert.deepEqual(a("mp3"), { ok: true, ext: "mp3", codec: "mp3", durationSec: 12.3 })
  assert.equal((a("mov,mp4,m4a,3gp,3g2,mj2", "aac") as { ext: string }).ext, "m4a")
  assert.equal((a("wav", "pcm_s16le") as { ext: string }).ext, "wav")
  assert.equal((a("aac", "aac") as { ext: string }).ext, "aac")
  assert.equal(a("ogg").ok, false)
  assert.equal(classifyProbe({ streams: [{ codec_type: "video", codec_name: "h264" }], format: { format_name: "mp4", duration: "3" } }).ok, false)
  assert.equal(classifyProbe({ streams: [{ codec_type: "audio" }, { codec_type: "video", codec_name: "h264" }], format: { format_name: "mp4", duration: "3" } }).ok, false)
  assert.equal(classifyProbe({ streams: [{ codec_type: "audio" }, { codec_type: "video", codec_name: "mjpeg" }], format: { format_name: "mp3", duration: "3" } }).ok, true)
  assert.equal(classifyProbe(null).ok, false)
})

test("planAudio: silent, tone", () => {
  const s = planAudio(DEFAULT_AUDIO, [], opts)
  assert.equal(s.mode, "silent"); assert.match(s.args.join(" "), /anullsrc=.*48000/)
  const t = planAudio({ ...DEFAULT_AUDIO, mode: "tone", toneHz: 1000, toneDb: -20 }, [], opts)
  assert.match(t.args[3], /^aevalsrc=exprs=0\.100000\*sin\(2\*PI\*1000\*t\)\|0\.100000/)
  assert.match(t.filter, /aresample=48000:async=1000/)
})

test("planAudio: single bed loops with -re, volume + fade", () => {
  const p = planAudio({ ...DEFAULT_AUDIO, mode: "bed", files: [f("a").id], volumeDb: -6, fadeInSec: 3 }, [f("a")], opts)
  assert.deepEqual(p.args, ["-re", "-stream_loop", "-1", "-i", `/d/${f("a").id}.stream.flac`])
  assert.match(p.filter, /^volume=-6dB,aresample.*,afade=t=in:st=0:d=3$/)
  assert.deepEqual(p.requires, [`/d/${f("a").id}.stream.flac`]); assert.equal(p.warning, null)
})

test("planAudio: missing → silent + warning; partial → plays rest", () => {
  const m = planAudio({ ...DEFAULT_AUDIO, mode: "bed", files: [f("a").id] }, [null], opts)
  assert.equal(m.mode, "silent"); assert.match(m.warning ?? "", /missing/)
  assert.match(planAudio({ ...DEFAULT_AUDIO, mode: "bed" }, [], opts).warning ?? "", /No audio bed/)
  const p = planAudio({ ...DEFAULT_AUDIO, mode: "bed" }, [null, f("b")], opts)
  assert.equal(p.mode, "bed"); assert.match(p.warning ?? "", /1 audio file/)
})

test("planAudio: playlist in order and shuffle via concat", () => {
  const files = [f("a"), f("b", "wav"), f("c")]
  const p = planAudio({ ...DEFAULT_AUDIO, mode: "bed", order: "inOrder" }, files, opts)
  assert.deepEqual(p.args.slice(-6), ["-f", "concat", "-safe", "0", "-i", "/d/list.txt"])
  assert.deepEqual(p.concatList?.trim().split("\n").map((l) => l.slice(9, 10)), ["a", "b", "c"])
  const s = planAudio({ ...DEFAULT_AUDIO, mode: "bed", order: "shuffle" }, files, { ...opts, random: () => 0 })
  assert.deepEqual(s.concatList?.trim().split("\n").map((l) => l.slice(9, 10)), ["b", "c", "a"])
  assert.ok(s.requires.includes("/d/list.txt"))
})

test("serializePlan + audioHash", () => {
  const p = planAudio({ ...DEFAULT_AUDIO, mode: "bed" }, [f("a")], opts)
  const lines = serializePlan(p).trim().split("\n")
  assert.equal(lines[0], `@requires /d/${f("a").id}.stream.flac`); assert.ok(lines[1].startsWith("@filter volume=0dB")); assert.deepEqual(lines.slice(2), p.args)
  assert.equal(audioHash(DEFAULT_AUDIO), audioHash({ ...DEFAULT_AUDIO }))
  assert.notEqual(audioHash(DEFAULT_AUDIO), audioHash({ ...DEFAULT_AUDIO, mode: "tone" }))
})

test("chromeRefreshHours: default 3, 0 = off, clamped to 24", () => {
  assert.equal(normalizeAudio({}).chromeRefreshHours, 3)
  assert.equal(normalizeAudio({ chromeRefreshHours: 0 }).chromeRefreshHours, 0)
  assert.equal(normalizeAudio({ chromeRefreshHours: 99 }).chromeRefreshHours, 24)
  assert.equal(normalizeAudio({ chromeRefreshHours: -2 }).chromeRefreshHours, 0)
})
