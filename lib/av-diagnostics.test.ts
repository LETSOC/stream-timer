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
