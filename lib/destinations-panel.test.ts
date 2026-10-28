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
  assert.deepEqual(destinationUses("b", paths, { slate: "b", capture: null, slateLive: true }).map((u) => u.kind), ["vertical", "channel"])
  assert.deepEqual(destinationUses("c", null, { slate: null, capture: null }), [])
})

test("destination tags follow the real route: a stale Slate-channel pick does not tag a /capture forward", async () => {
  const { destinationUses } = await import("@/components/destinations-panel")
  const capture = { capture: { forwards: [{ destId: "yt", state: "forwarding" }] }, slate: { forwards: [] }, vertical: { forwards: [] } }
  // The bug: saved selectedId = "yt" (Slate channel stopped) added "Slate channel" next to "HD /capture forward".
  assert.deepEqual(destinationUses("yt", capture, { slate: "yt", capture: null, slateLive: false, captureLive: false }).map((u) => u.label), ["HD /capture forward"])
  const slate = { capture: { forwards: [] }, slate: { forwards: [{ destId: "yt", state: "forwarding" }] }, vertical: { forwards: [] } }
  assert.deepEqual(destinationUses("yt", slate, { slate: null, capture: null }).map((u) => u.label), ["HD /slate forward"])
  const both = { capture: { forwards: [{ destId: "yt", state: "forwarding" }] }, slate: { forwards: [{ destId: "yt", state: "waiting" }] }, vertical: { forwards: [] } }
  assert.deepEqual(destinationUses("yt", both, { slate: null, capture: null }).map((u) => u.label), ["HD /capture forward", "HD /slate forward"])
  // A channel that is really streaming to it still shows.
  assert.deepEqual(destinationUses("yt", capture, { slate: "yt", capture: "yt", slateLive: true, captureLive: true }).map((u) => u.label), ["HD /capture forward", "Browser capture channel", "Slate channel"])
})

test("dropout log never carries a stream key from a forward error line", async () => {
  const { redact, dropoutLine } = await import("@/lib/dropout-log")
  const line = dropoutLine(Date.UTC(2026, 10, 4, 10), "!", "push", redact("FwdSink: rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop: I/O error ?password=pw-secret"))
  assert.ok(!/abcd-efgh|pw-secret/.test(line), line)
})

test("forwardStats: compact fps/kbps/speed/reconnects for a live switch; retries when not live", async () => {
  const { forwardStats } = await import("@/components/destinations-panel")
  assert.equal(forwardStats({ destId: "a", state: "forwarding", health: { fps: 30, kbps: 2500, speed: 1 }, reconnects: 2 }), "30 fps · 2500k · 1.00x · 2↻")
  assert.equal(forwardStats({ destId: "a", state: "retrying", restarts: 3, health: { fps: 30, kbps: 2500 } }), "3 retries")
  assert.equal(forwardStats({ destId: "a", state: "connecting" }), null)
})

test("timerTag: shows path and time on the card", async () => {
  const { timerTag } = await import("@/components/destinations-panel")
  const when = () => "today 09:25"
  assert.equal(timerTag(1, "capture", when), "Timer · HD /capture · today 09:25")
  assert.equal(timerTag(1, "vertical", when), "Timer · 9:16 /vertical · today 09:25")
  assert.equal(timerTag(null, "slate", when), null)
})

test("path panels: live forward needs two taps to untick; waiting/off does not", async () => {
  const { isLiveForward } = await import("@/components/path-panels")
  for (const st of ["forwarding", "connecting", "retrying", "stalled"]) assert.equal(isLiveForward(st), true)
  for (const st of ["waiting", "off", "blocked", null, undefined]) assert.equal(isLiveForward(st), false)
})

test("path panels: failed ticks always produce an error (unreachable, signed out, server error)", async () => {
  const { tickError } = await import("@/components/path-panels")
  assert.equal(tickError("YouTube", "capture", true, { ok: true, status: 200 }), null)
  assert.equal(tickError("YouTube", "capture", true, null), "YouTube: /capture not ticked: could not reach the server.")
  assert.equal(tickError("YouTube", "vertical", false, { ok: false, status: 401 }), "YouTube: /vertical not unticked: signed out. Sign in and try again.")
  assert.equal(tickError("YouTube", "slate", true, { ok: false, status: 409, error: "Already used" }), "YouTube: /slate not ticked: Already used.")
  assert.equal(tickError("YouTube", "slate", true, { ok: false, status: 500 }), "YouTube: /slate not ticked: server returned 500.")
})
