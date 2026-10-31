import assert from "node:assert/strict"
import test from "node:test"
import { buildStreamShellCommand, pickCommandDestination } from "@/lib/ffmpeg-command"

const items = [{ id: "a" }, { id: "b" }, { id: "c" }]

test("command destination: operator's pick wins", () => assert.equal(pickCommandDestination(items, "c", "a")?.id, "c"))
test("command destination: falls back to the slate destination", () => assert.equal(pickCommandDestination(items, null, "b")?.id, "b"))
test("command destination: falls back when the pick was deleted", () => assert.equal(pickCommandDestination(items, "gone", "b")?.id, "b"))
test("command destination: falls back to the first saved one", () => assert.equal(pickCommandDestination(items, null, null)?.id, "a"))
test("command destination: null with nothing saved", () => assert.equal(pickCommandDestination([], "a", "b"), null))
test("stream command puts the chosen URL in RTMP_URL", () => {
  const cmd = buildStreamShellCommand({ eventName: "Hyphen", dateLine: "Wed", targetUnix: 1, rtmpUrl: "rtmp://x.example/live/••••" })
  assert.ok(cmd.includes("RTMP_URL='rtmp://x.example/live/••••'"))
})
