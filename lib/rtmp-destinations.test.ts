import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import * as d from "@/lib/rtmp-destinations"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-dest-"))
process.env.STREAM_DATA_DIR = dir
const URL1 = "rtmp://live.restream.io/live/re_SECRETKEY_9f3a"

test("add, list masked, file is 0600 and never lists the key", () => {
  const added = d.addDestination("Restream main", URL1)
  assert.ok(added.ok)
  const list = d.listDestinations()
  assert.equal(list.items.length, 1)
  assert.equal(list.selectedId, list.items[0].id, "first destination is selected")
  assert.equal(list.items[0].host, "live.restream.io")
  assert.ok(list.items[0].masked.endsWith("9f3a"))
  assert.ok(!JSON.stringify(list).includes("SECRETKEY"))
  const mode = fs.statSync(path.join(dir, "rtmp-destinations.json")).mode & 0o777
  assert.equal(mode, 0o600)
})

test("validation, allow-list, rename, select, delete, resolve", () => {
  assert.equal(d.addDestination("", URL1).ok, false)
  assert.equal(d.addDestination("Bad", "http://x/y").ok, false)
  process.env.RTMP_ALLOWED_HOSTS = "uk.castr.io"
  const blocked = d.addDestination("Not allowed", URL1)
  assert.ok(!blocked.ok && blocked.error.includes("RTMP_ALLOWED_HOSTS"))
  const castr = d.addDestination("Castr", "rtmp://uk.castr.io/static/live_abcd?password=pw12")
  assert.ok(castr.ok)
  delete process.env.RTMP_ALLOWED_HOSTS
  if (!castr.ok) return
  assert.ok(d.renameDestination(castr.value.id, "Castr backup").ok)
  assert.ok(d.selectDestination(castr.value.id).ok)
  assert.equal(d.listDestinations().selectedId, castr.value.id)
  assert.equal(d.resolveDestination(castr.value.id)?.url, "rtmp://uk.castr.io/static/live_abcd?password=pw12")
  assert.ok(d.deleteDestination(castr.value.id).ok)
  const after = d.listDestinations()
  assert.equal(after.items.length, 1)
  assert.equal(after.selectedId, after.items[0].id, "deleting the selected one falls back to another")
  assert.equal(d.selectDestination("nope").ok, false)
})

test("RTMP allow-list defaults: LAN/private + common providers; env overrides; * = any", async () => {
  const { allowedRtmpHost } = await import("@/lib/encoder")
  delete process.env.RTMP_ALLOWED_HOSTS
  for (const ok of ["rtmp://a.rtmp.youtube.com/live2/k", "rtmp://live.restream.io/live/k", "rtmps://uk.castr.io/static/k", "rtmp://live-lhr.twitch.tv/app/k", "rtmps://live-api-s.facebook.com:443/rtmp/k", "rtmp://192.168.1.20/live/k", "rtmp://10.0.0.5/live/k", "rtmp://127.0.0.1:19350/x", "rtmp://studio.local/live/k"]) assert.equal(allowedRtmpHost(ok), true, ok)
  for (const no of ["rtmp://evil.example/live/k", "rtmp://8.8.8.8/live/k", "rtmp://youtube.com.evil.example/x"]) assert.equal(allowedRtmpHost(no), false, no)
  process.env.RTMP_ALLOWED_HOSTS = "my.host"
  assert.equal(allowedRtmpHost("rtmp://a.rtmp.youtube.com/live2/k"), false); assert.equal(allowedRtmpHost("rtmp://x.my.host/a/b"), true)
  process.env.RTMP_ALLOWED_HOSTS = "*"
  assert.equal(allowedRtmpHost("rtmp://evil.example/live/k"), true)
  delete process.env.RTMP_ALLOWED_HOSTS
})

test("drawtext detection from ffmpeg -filters", async () => {
  const { hasDrawtextFilter } = await import("@/lib/encoder")
  assert.equal(hasDrawtextFilter(" ... drawbox           V->V       Draw a box\n T.C drawtext          V->V       Draw text on top of video frames using libfreetype library.\n"), true)
  assert.equal(hasDrawtextFilter(" ... drawbox           V->V       Draw a box\n ... drawgrid          V->V       Draw a grid\n"), false)
})

test("edit: new key, keep key when blank, rename only, validation, duplicates, display masking", () => {
  const a = d.addDestination("YouTube HD", "rtmp://a.rtmp.youtube.com/live2/old-key-1234")
  const b = d.addDestination("Restream", "rtmp://live.restream.io/live/re_other_5678")
  assert.ok(a.ok && b.ok)
  if (!a.ok || !b.ok) return
  assert.equal(a.value.display, "rtmp://••••••••/live2/••••••••1234")
  assert.ok(!JSON.stringify(d.listDestinations()).includes("old-key"))
  const info = d.destinationEditInfo(a.value.id)
  assert.deepEqual(info, { id: a.value.id, name: "YouTube HD", server: "rtmp://a.rtmp.youtube.com/live2", keyTail: "1234", keyKind: "path" })
  // new key only
  const k = d.updateDestination(a.value.id, { name: "YouTube HD", server: "rtmp://a.rtmp.youtube.com/live2", key: " new-key-9999 " })
  assert.ok(k.ok && k.changed)
  assert.equal(d.resolveDestination(a.value.id)?.url, "rtmp://a.rtmp.youtube.com/live2/new-key-9999")
  // blank key keeps it; server change applies; rename only → changed false
  const s = d.updateDestination(a.value.id, { name: "YouTube HD", server: "rtmps://a.rtmps.youtube.com/live2", key: "" })
  assert.ok(s.ok && s.changed)
  assert.equal(d.resolveDestination(a.value.id)?.url, "rtmps://a.rtmps.youtube.com/live2/new-key-9999")
  const r = d.updateDestination(a.value.id, { name: "YouTube main", server: "", key: "" })
  assert.ok(r.ok && !r.changed && r.value.name === "YouTube main")
  // bad inputs
  for (const server of ["javascript:alert(1)", "http://a.rtmp.youtube.com/live2", "file:///etc/passwd", "srt://a.example:9000"]) {
    const bad = d.updateDestination(a.value.id, { name: "x", server, key: "k" })
    assert.equal(bad.ok, false, server)
  }
  const srt = d.updateDestination(a.value.id, { name: "x", server: "srt://host:9000", key: "" })
  assert.ok(!srt.ok && /SRT/.test(srt.error))
  assert.equal(d.updateDestination(a.value.id, { name: "", server: "", key: "" }).ok, false)
  assert.equal(d.updateDestination(a.value.id, { name: "x", key: "has space" }).ok, false)
  assert.equal(d.updateDestination("nope", { name: "x" }).ok, false)
  const dup = d.updateDestination(a.value.id, { name: "x", server: "rtmp://live.restream.io/live", key: "re_other_5678" })
  assert.ok(!dup.ok && dup.status === 409)
  assert.equal(d.resolveDestination(a.value.id)?.url, "rtmps://a.rtmps.youtube.com/live2/new-key-9999", "failed edits change nothing")
  // ?password= keys
  const c = d.addDestination("Castr pw", "rtmp://uk.castr.io/static?password=pw-secret-77")
  assert.ok(c.ok)
  if (!c.ok) return
  assert.equal(d.destinationEditInfo(c.value.id)?.keyKind, "query")
  assert.equal(c.value.display, "rtmp://••••••••/static?••••••••t-77")
  assert.ok(d.updateDestination(c.value.id, { name: "Castr pw", key: "?password=pw-new-88" }).ok)
  assert.equal(d.resolveDestination(c.value.id)?.url, "rtmp://uk.castr.io/static?password=pw-new-88")
  for (const id of [a.value.id, b.value.id, c.value.id]) d.deleteDestination(id)
})
