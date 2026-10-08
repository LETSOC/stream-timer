import assert from "node:assert/strict"
import test from "node:test"
import { parseStartInput } from "./encoder.ts"

test("parseStartInput defaults refresh to 10 minutes", () => {
  const input = parseStartInput({ eventName: "Hyphen", dateLine: "4 November", targetUnix: 1793784600 })
  assert.equal(input?.refreshSeconds, 600)
})

test("parseStartInput rejects newlines and accepts refresh off", () => {
  assert.equal(parseStartInput({ eventName: "Hyphen\n", dateLine: "4 November", targetUnix: 1 }), null)
  assert.equal(parseStartInput({ eventName: "Hyphen", dateLine: "4 November", targetUnix: 1, refreshSeconds: 0 })?.refreshSeconds, 0)
})
