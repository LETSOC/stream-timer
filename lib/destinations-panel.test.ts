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

test("forwardToggles: one switch per path, live state from /api/relay", async () => {
  const { forwardToggles } = await import("@/components/destinations-panel")
  const paths = {
    capture: { forwards: [{ destId: "yt", state: "forwarding" }] },
    slate: { forwards: [] },
    vertical: { forwards: [{ destId: "one", state: "retrying" }], available: [{ destId: "yt", reason: "Already used by /capture" }] },
  }
  const yt = forwardToggles("yt", paths)
  assert.deepEqual(yt.map((t) => t.path), ["capture", "slate", "vertical"])
  assert.deepEqual(yt[0], { path: "capture", label: "HD /capture", on: true, state: "forwarding", blocked: null, stats: null, error: null })
  assert.equal(yt[1].on, false)
  assert.equal(yt[2].blocked, "Already used by /capture")
  const one = forwardToggles("one", paths)
  assert.equal(one[2].on, true)
  assert.equal(one[2].state, "retrying")
})

test("forwardToggles: a ticked forward is never blocked from switching off; no relay state = all off", async () => {
  const { forwardToggles } = await import("@/components/destinations-panel")
  const paths = { vertical: { forwards: [{ destId: "a", state: "forwarding" }], available: [{ destId: "a", reason: "conflict" }] } }
  assert.equal(forwardToggles("a", paths)[2].blocked, null)
  assert.ok(forwardToggles("a", null).every((t) => !t.on && t.state === null && t.blocked === null))
})

test("forwardStats: compact fps/kbps/speed/reconnects for a live switch; retries when not live", async () => {
  const { forwardStats } = await import("@/components/destinations-panel")
  assert.equal(forwardStats({ destId: "a", state: "forwarding", health: { fps: 30, kbps: 2500, speed: 1 }, reconnects: 2 }), "30 fps · 2500k · 1.00x · 2↻")
  assert.equal(forwardStats({ destId: "a", state: "retrying", restarts: 3, health: { fps: 30, kbps: 2500 } }), "3 retries")
  assert.equal(forwardStats({ destId: "a", state: "connecting" }), null)
})

test("forwardToggles: error text only when not forwarding/waiting; stats attached", async () => {
  const { forwardToggles } = await import("@/components/destinations-panel")
  const paths = { capture: { forwards: [{ destId: "a", state: "retrying", error: "Key rejected", restarts: 1 }] }, slate: { forwards: [{ destId: "a", state: "waiting", error: "No source" }] } }
  const [cap, slate] = forwardToggles("a", paths)
  assert.equal(cap.error, "Key rejected")
  assert.equal(cap.stats, "1 retry")
  assert.equal(slate.error, null)
})

test("timerTag: shows path and time on the card", async () => {
  const { timerTag } = await import("@/components/destinations-panel")
  const when = () => "today 09:25"
  assert.equal(timerTag(1, "capture", when), "Timer · HD /capture · today 09:25")
  assert.equal(timerTag(1, "vertical", when), "Timer · 9:16 /vertical · today 09:25")
  assert.equal(timerTag(null, "slate", when), null)
})
