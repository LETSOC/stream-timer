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
