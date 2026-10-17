import assert from "node:assert/strict"
import { test } from "node:test"
import { frameTimecode, liveFromStatus, makeSample, parseFps, parseJsonl, samplesToCsv } from "@/lib/av-diagnostics"
import { applyTransport, parseAction } from "@/lib/transport"
import { DEFAULT_EVENT } from "@/lib/event"
import { DEFAULT_STAGE, LIVE_VISUAL_KEYS, parseStage } from "@/lib/stage"

test("frame timecode HH:MM:SS:FF", () => {
  const t = Date.UTC(2026, 9, 17, 13, 4, 5, 999)
  assert.equal(frameTimecode(t, 30), "13:04:05:29")
  assert.equal(frameTimecode(t, 25), "13:04:05:24")
  assert.equal(frameTimecode(t - 999, 60), "13:04:05:00")
  assert.equal(frameTimecode(t, 30, 60), "14:04:05:29")
  assert.equal(frameTimecode(Date.UTC(2026, 0, 1, 0, 0, 0, 500), 50, -60), "23:00:00:25")
  assert.equal(parseFps("60"), 60)
  assert.equal(parseFps("24"), 30)
})

test("samples, CSV and JSONL", () => {
  const live = liveFromStatus({ playerLatencyMs: 812.4, delayMs: 900, offsetMs: { main: 40 }, mixing: true, source: "main", jitterMs: 12 }, { avOffsetMs: -20, programOffsetMs: { main: 10, backup: 0 } }, "backup")
  assert.deepEqual(live, { playerLatencyMs: 812, audioDelayMs: 900, autoOffsetMs: 40, avOffsetMs: -20, programOffsetMs: 10, source: "main", mixing: true, jitterMs: 12 })
  const s = makeSample(live, { readingMs: "433", note: "=cmd\nx, y" }, 1000)
  assert.equal(s.readingMs, 433)
  const csv = samplesToCsv([s])
  assert.match(csv, /^iso,at,/)
  assert.match(csv, /"'=cmd x, y"/)
  assert.equal(parseJsonl(`${JSON.stringify(s)}\n{torn\n`).length, 1)
  assert.equal(makeSample(liveFromStatus(null, { avOffsetMs: 0, programOffsetMs: { main: 0, backup: 0 } }, "main"), {}).playerLatencyMs, null)
})

test("STREAM timecode switch: off by default, live, preserved", () => {
  assert.equal(DEFAULT_STAGE.streamTimecode, false)
  assert.ok((LIVE_VISUAL_KEYS as readonly string[]).includes("streamTimecode"))
  assert.deepEqual(parseAction({ type: "timecode", show: true, fps: 25 }), { type: "timecode", show: true, fps: 25 })
  assert.equal(parseAction({ type: "timecode", fps: 24 }), null)
  const r = applyTransport({ event: { ...DEFAULT_EVENT }, testUntil: null, pausedAt: null, stage: parseStage({}) }, { type: "timecode", show: true, fps: 60 }, 1)
  assert.ok(r.ok && r.next.stage.streamTimecode && r.next.stage.streamTimecodeFps === 60)
})

import { beepTimes, ctxTimeFor, flashOn, parseBeepEvery, parseVol } from "@/lib/av-diagnostics"

test("TC1 beep schedule: whole seconds, minute flag, every N, local tz", () => {
  const base = Date.UTC(2026, 9, 17, 13, 0, 58, 700)
  const b = beepTimes(base, base + 2500, 1)
  assert.deepEqual(b.map((x) => new Date(x.at).getUTCSeconds()), [59, 0, 1])
  assert.deepEqual(b.map((x) => x.minute), [false, true, false])
  assert.deepEqual(beepTimes(base, base + 12_000, 5).map((x) => new Date(x.at).getUTCSeconds()), [0, 5, 10])
  assert.equal(beepTimes(base, base + 200, 1).length, 0)
  // (from, to]: no double schedule across ticks
  const t = Date.UTC(2026, 0, 1, 0, 0, 1, 0)
  assert.equal(beepTimes(t - 100, t, 1).length + beepTimes(t, t + 100, 1).length, 1)
  assert.equal(ctxTimeFor(10_500, { wallMs: 10_000, ctxTime: 2 }, 0.02), 2.48)
  assert.equal(flashOn(t + 50, 1), true)
  assert.equal(flashOn(t + 150, 1), false)
  assert.equal(parseBeepEvery("10"), 10)
  assert.equal(parseBeepEvery("3"), 1)
  assert.equal(parseVol("2"), 1)
  assert.equal(parseVol(null), 0.5)
})

test("audio offset column", () => {
  const live = liveFromStatus(null, { avOffsetMs: 0, programOffsetMs: { main: 0, backup: 0 } }, "main")
  const s = makeSample(live, { audioOffsetMs: "-35" }, 1)
  assert.equal(s.audioOffsetMs, -35)
  assert.match(samplesToCsv([s]).split("\n")[0], /readingMs,audioOffsetMs,note$/)
})
