import assert from "node:assert/strict"
import { test } from "node:test"
import { changeLogger, programLine } from "@/lib/program-log"

test("program log lines: local HH:MM:SS + [program]", () => {
  assert.equal(programLine("Main FAILED", new Date(2026, 9, 15, 9, 5, 7)), "09:05:07 [program] Main FAILED")
})

test("changeLogger logs on change only, quiet initial off/0", () => {
  const c = changeLogger()
  assert.equal(c("hold", "off", "hold end"), null)
  assert.equal(c("hold", "on", "hold start"), "hold start")
  assert.equal(c("hold", "on", "hold start"), null)
  assert.equal(c("hold", "off", "hold end"), "hold end")
  assert.equal(c("main:state", "healthy", "Main HEALTHY"), "Main HEALTHY")
  assert.equal(c("main:state", "healthy", "Main HEALTHY"), null)
})
