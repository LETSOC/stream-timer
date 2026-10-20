import assert from "node:assert/strict"
import { test } from "node:test"

test("edit form preview: typed key masked unless the eye is on; blank = saved key (masked or revealed)", async () => {
  const { joinedPreview } = await import("@/components/destinations-panel")
  const base = { mode: "edit" as const, server: "rtmp://live.example.com/live", key: "", showKey: false, keyTail: "o5p4", keyKind: "path" as const, savedKey: null }
  assert.equal(joinedPreview(base), "rtmp://live.example.com/live/••••••••o5p4")
  assert.equal(joinedPreview({ ...base, savedKey: "a1b2c3o5p4" }), "rtmp://live.example.com/live/a1b2c3o5p4")
  assert.equal(joinedPreview({ ...base, key: "new-key" }), "rtmp://live.example.com/live/••••••••")
  assert.equal(joinedPreview({ ...base, key: "new-key", showKey: true }), "rtmp://live.example.com/live/new-key")
  assert.equal(joinedPreview({ ...base, keyKind: "query" }), "rtmp://live.example.com/live?••••••••o5p4")
  assert.equal(joinedPreview({ ...base, mode: "add" }), "rtmp://live.example.com/live")
  assert.equal(joinedPreview({ ...base, server: " " }), "")
})

test("destination tags: HD forwards, Vertical forwards and direct channels stay distinguishable", async () => {
  const { destinationUses } = await import("@/components/destinations-panel")
  const paths = { capture: { forwards: [{ destId: "a", state: "forwarding" }] }, slate: { forwards: [] }, vertical: { forwards: [{ destId: "b", state: "waiting" }] } }
  assert.deepEqual(destinationUses("a", paths, { slate: null, capture: null }).map((u) => [u.kind, u.label, u.state]), [["hd", "HD /capture forward", "forwarding"]])
  assert.deepEqual(destinationUses("b", paths, { slate: "b", capture: null }).map((u) => u.kind), ["vertical", "channel"])
  assert.deepEqual(destinationUses("c", null, { slate: null, capture: null }), [])
})

test("dropout log never carries a stream key from a forward error line", async () => {
  const { redact, dropoutLine } = await import("@/lib/dropout-log")
  const line = dropoutLine(Date.UTC(2026, 10, 4, 10), "!", "push", redact("FwdSink: rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop: I/O error ?password=pw-secret"))
  assert.ok(!/abcd-efgh|pw-secret/.test(line), line)
})
