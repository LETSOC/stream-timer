import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { parseOwnSupervisorList, parseStrayPublishers, sameDestinationConflict, destinationFingerprint } from "./encoder.ts"
import * as d from "./rtmp-destinations.ts"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-chan-"))
process.env.STREAM_DATA_DIR = dir

const SUP = "/app/scripts/rtmp-supervisor.sh"

test("supervisor list tags each supervisor with its channel (no argument = slate)", () => {
  const ps = [`  10  10 bash ${SUP}`, `  20  20 bash ${SUP} capture`, `  30  30 bash ${SUP} slate`, `  40  40 bash /other/thing.sh capture`].join("\n")
  const found = parseOwnSupervisorList(ps, SUP)
  assert.deepEqual(found.map((s) => [s.pid, s.channel]), [[10, "slate"], [20, "capture"], [30, "slate"]])
})

test("supervisor argv carries the destination fingerprint for adoption", () => {
  const [one] = parseOwnSupervisorList(`  20  20 bash ${SUP} capture dest=0123456789abcdef`, SUP)
  assert.deepEqual(one, { pid: 20, channel: "capture", dest: "0123456789abcdef" })
})

test("stray scan skips both channels' process groups", () => {
  const ps = ["  11  10 ffmpeg -f flv rtmp://a/x", "  21  20 ffmpeg -f flv rtmp://b/y", "  99  99 ffmpeg -f flv rtmp://c/z"].join("\n")
  assert.deepEqual(parseStrayPublishers(ps, [10, 20], 1).map((s) => s.pid), [99])
})

test("same destination on the other running channel is a conflict; stopped or different is not", () => {
  const fp = destinationFingerprint("rtmp://ingest/live/KEY")
  assert.equal(fp, destinationFingerprint(" rtmp://ingest/live/KEY "))
  assert.ok(!fp.includes("KEY"))
  assert.equal(sameDestinationConflict(fp, [{ channel: "slate", running: true, dest: fp }]), "slate")
  assert.equal(sameDestinationConflict(fp, [{ channel: "slate", running: false, dest: fp }]), null)
  assert.equal(sameDestinationConflict(fp, [{ channel: "slate", running: true, dest: destinationFingerprint("rtmp://ingest/live/OTHER") }]), null)
})

test("each channel keeps its own selected destination", () => {
  process.env.RTMP_ALLOWED_HOSTS = "*" // example hosts
  const a = d.addDestination("A", "rtmp://a.example/live/k1")
  const b = d.addDestination("B", "rtmp://b.example/live/k2")
  assert.ok(a.ok && b.ok)
  const [ia, ib] = d.listDestinations().items
  assert.ok(d.selectDestination(ib.id, "capture").ok)
  let list = d.listDestinations()
  assert.equal(list.selectedId, ia.id)
  assert.equal(list.selectedCaptureId, ib.id)
  d.deleteDestination(ib.id)
  list = d.listDestinations()
  assert.equal(list.selectedCaptureId, null)
  fs.rmSync(dir, { recursive: true, force: true })
})
