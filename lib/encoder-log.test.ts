import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { readTail } from "./encoder.ts"

function tempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-tail-"))
  const file = path.join(dir, "log.txt")
  fs.writeFileSync(file, content)
  return file
}

test("a small file comes back whole", () => {
  assert.equal(readTail(tempFile("one\ntwo\n")), "one\ntwo\n")
})

test("a large file returns only the end, never more than maxBytes", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")
  const tail = readTail(tempFile(lines), 200)
  assert.ok(tail.length <= 200)
  assert.ok(tail.endsWith("line 4999"))
  assert.ok(!tail.includes("line 0\n"))
})

test("carriage-return progress lines are kept as written", () => {
  assert.equal(readTail(tempFile("frame=1\rframe=2\rframe=3"), 100), "frame=1\rframe=2\rframe=3")
})

test("a missing or empty file gives an empty string instead of throwing", () => {
  assert.equal(readTail("/nonexistent/log.txt"), "")
  assert.equal(readTail(tempFile("")), "")
})
