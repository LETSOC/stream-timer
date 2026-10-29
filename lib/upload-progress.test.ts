import { test } from "node:test"
import assert from "node:assert/strict"
import { failureReason, formatBytes, parseBody, uploadLabel, uploadPercent } from "./upload-progress"

test("uploadPercent clamps and floors", () => {
  assert.equal(uploadPercent(0, 100), 0)
  assert.equal(uploadPercent(499, 1000), 49)
  assert.equal(uploadPercent(2000, 1000), 100)
  assert.equal(uploadPercent(5, 0), 0)
  assert.equal(uploadPercent(Number.NaN, 10), 0)
})

test("formatBytes", () => {
  assert.equal(formatBytes(512), "512 B")
  assert.equal(formatBytes(12_000), "12 KB")
  assert.equal(formatBytes(28_500_000), "28.5 MB")
})

test("labels for each phase", () => {
  assert.equal(uploadLabel({ phase: "idle" }), "")
  assert.equal(uploadLabel({ phase: "uploading", tag: "t", name: "a.mp4", loaded: 12_000_000, total: 28_500_000 }), "Uploading a.mp4… 42% (12.0 MB of 28.5 MB)")
  assert.match(uploadLabel({ phase: "processing", tag: "t", name: "a.mp3" }), /100%/)
  assert.equal(uploadLabel({ phase: "done", tag: "t", name: "a.mp3" }), "Done: a.mp3 uploaded.")
  assert.equal(uploadLabel({ phase: "failed", tag: "t", name: "a.mp3", reason: "nope" }), "Failed: nope")
})

test("failureReason prefers the server's error", () => {
  assert.equal(failureReason(400, { error: "Not an audio file." }), "Not an audio file.")
  assert.match(failureReason(0, null), /could not reach/)
  assert.match(failureReason(413, null), /too large/)
  assert.equal(failureReason(500, {}), "server returned 500.")
})

test("parseBody tolerates junk", () => {
  assert.deepEqual(parseBody('{"url":"/u/a.png"}'), { url: "/u/a.png" })
  assert.equal(parseBody("<html>"), null)
  assert.equal(parseBody("[1]"), null)
})

test("every file input goes through the shared FilePicker", async () => {
  const { readFileSync, readdirSync } = await import("node:fs")
  const dir = new URL("../components/", import.meta.url)
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".tsx") || f === "file-picker.tsx") continue
    assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /type="file"/, f)
  }
  const picker = readFileSync(new URL("file-picker.tsx", dir), "utf8")
  assert.match(picker, /sr-only/)
  assert.match(picker, /htmlFor=\{id\}/)
  assert.match(picker, /No file selected/)
})
