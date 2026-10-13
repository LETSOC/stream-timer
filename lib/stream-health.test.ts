import assert from "node:assert/strict"
import { test } from "node:test"
import { captureSourceHealth, diagnose, EMPTY_HEALTH, healthFromSamples, parseProgressBlocks, parseStatsLines, type HealthStats } from "./stream-health.ts"

const block = (frame: number, bytes: number, outSec: number, extra = "") => `frame=${frame}\nfps=30.00\nbitrate=2600.0kbits/s\ntotal_size=${bytes}\nout_time_us=${outSec * 1e6}\ndup_frames=0\ndrop_frames=0\nspeed=1.00x\n${extra}progress=continue\n`
// 5s periods, 30 fps, 2628 kbps → 1,642,500 bytes per period
const steady = (n: number, perBytes = 1642500, perFrames = 150, perOut = 5) => Array.from({ length: n }, (_, i) => block(i * perFrames, i * perBytes, i * perOut)).join("")

test("progress blocks parse and give instantaneous rates", () => {
  const samples = parseProgressBlocks(steady(6))
  assert.equal(samples.length, 6)
  const h = healthFromSamples(samples, 5, 1000, { fps: 30, kbps: 2628 })
  assert.equal(h.level, "ok")
  assert.equal(h.fps, 30)
  assert.equal(h.kbps, 2628)
  assert.equal(h.speed, 1)
})

test("slow forward: speed, fps and bitrate falling are flagged", () => {
  const fast = parseProgressBlocks(steady(8))
  const last = fast[fast.length - 1]
  // two slow periods: half the frames, half the bytes, half the media time
  const slow = [1, 2].map((i) => ({ ...last, frame: last.frame + i * 75, bytes: last.bytes + i * 821250, outUs: last.outUs + i * 2.5e6 }))
  const h = healthFromSamples([...fast, ...slow], 5, 1000, { fps: 30, kbps: 2628 })
  assert.equal(h.level, "bad")
  assert.ok(h.warnings.some((w) => w.startsWith("speed 0.50x")))
  assert.ok(h.warnings.some((w) => w.includes("fps")))
  assert.ok(h.warnings.some((w) => w.startsWith("bitrate falling")))
})

test("slight slowdown is amber", () => {
  const s = parseProgressBlocks(steady(4, 1642500, 145, 4.8))
  const h = healthFromSamples(s, 5, 1000, { fps: 30, kbps: null })
  assert.equal(h.level, "warn")
  assert.equal(h.speed, 0.96)
})

test("stale report is red; restart resets counters", () => {
  assert.equal(healthFromSamples(parseProgressBlocks(steady(3)), 5, 60_000, { fps: 30, kbps: null }).level, "bad")
  const restarted = parseProgressBlocks(steady(5) + steady(2))
  const h = healthFromSamples(restarted, 5, 1000, { fps: 30, kbps: null })
  assert.equal(h.fps, 30)
})

test("ffmpeg stats lines parse", () => {
  const lines = [0, 1, 2].map((i) => `frame= ${i * 150} fps= 30 q=23.0 size= ${i * 1604}KiB time=00:00:${String(i * 5).padStart(2, "0")}.00 bitrate=2628.0kbits/s dup=0 drop=${i} speed=1.0x`).join("\r")
  const h = healthFromSamples(parseStatsLines(lines), 5, 500, { fps: 30, kbps: 2628 })
  assert.equal(h.fps, 30)
  assert.equal(h.drop, 2)
  assert.ok(Math.abs((h.kbps ?? 0) - 2628) < 5)
})

const ok: HealthStats = { ...EMPTY_HEALTH, fps: 30, kbps: 2600, speed: 1, level: "ok" }
const slow: HealthStats = { ...ok, speed: 0.8, level: "bad", warnings: ["speed 0.80x"] }
const cap = { at: Date.now(), screencastFps: 2, writtenFps: 30, repeatPct: 93, backpressurePct: 0, maxLagMs: 20, fps: 30, encoder: "libx264", bitrateK: 2500, size: "1280x720" }

test("capture: repeats are normal, backlog/lag/no repaint are not", () => {
  assert.equal(captureSourceHealth(ok, cap).level, "ok")
  assert.equal(captureSourceHealth(ok, { ...cap, backpressurePct: 15 }).level, "bad")
  assert.equal(captureSourceHealth(ok, { ...cap, maxLagMs: 400 }).level, "warn")
  assert.equal(captureSourceHealth(ok, { ...cap, screencastFps: 0.1 }).level, "bad")
})

test("diagnosis", () => {
  const f = (name: string, health: HealthStats) => ({ name, health })
  assert.match(diagnose({ source: null, forwards: [f("A", slow), f("B", slow), f("C", slow)], totalKbps: 13000 }).text, /All 3 forwards slow at once → upload bandwidth.*13\.0 Mbps/)
  assert.match(diagnose({ source: null, forwards: [f("A", slow), f("B", slow)], totalKbps: 3000, needKbps: 5256 }).text, /Sending ≈ 3\.0 of ≈ 5\.3 Mbps needed/)
  assert.match(diagnose({ source: null, forwards: [f("YouTube", slow), f("B", ok)], totalKbps: null }).text, /Only YouTube is slow .*that destination/)
  assert.match(diagnose({ source: { label: "Browser capture", health: captureSourceHealth(ok, { ...cap, backpressurePct: 20 }) }, forwards: [f("A", slow), f("B", slow)], totalKbps: null }).text, /encoder can't keep up → CPU/)
  assert.match(diagnose({ source: { label: "Browser capture", health: captureSourceHealth(ok, { ...cap, screencastFps: 0.1 }) }, forwards: [], totalKbps: null }).text, /Chrome isn't repainting/)
  assert.equal(diagnose({ source: { label: "Slate", health: ok }, forwards: [f("A", ok), f("B", ok)], totalKbps: 5200 }).text, "Healthy. Total out ≈ 5.2 Mbps.")
})
