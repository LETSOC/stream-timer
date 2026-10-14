import test from "node:test"
import assert from "node:assert/strict"
import { captureKeyAccepted, CAPTURE_HEADER } from "./capture-key.ts"

const KEY = "k".repeat(43)
const h = (o: Record<string, string>) => new Headers(o)

test("capture key: right key from loopback is accepted", () => {
  assert.equal(captureKeyAccepted(h({ [CAPTURE_HEADER]: KEY, host: "127.0.0.1:43211", "x-forwarded-for": "127.0.0.1" }), KEY), true)
  assert.equal(captureKeyAccepted(h({ [CAPTURE_HEADER]: KEY, host: "[::1]:43211", "x-forwarded-for": "::1" }), KEY), true)
  assert.equal(captureKeyAccepted(h({ [CAPTURE_HEADER]: KEY, host: "localhost:43211", "x-forwarded-for": "::ffff:127.0.0.1" }), KEY), true)
})

test("capture key: wrong/missing key, remote client or LAN host is refused", () => {
  assert.equal(captureKeyAccepted(h({ host: "127.0.0.1" }), KEY), false)
  assert.equal(captureKeyAccepted(h({ [CAPTURE_HEADER]: "x".repeat(43), host: "127.0.0.1" }), KEY), false)
  assert.equal(captureKeyAccepted(h({ [CAPTURE_HEADER]: KEY.slice(1), host: "127.0.0.1" }), KEY), false)
  assert.equal(captureKeyAccepted(h({ [CAPTURE_HEADER]: KEY, host: "127.0.0.1", "x-forwarded-for": "192.168.1.20" }), KEY), false)
  assert.equal(captureKeyAccepted(h({ [CAPTURE_HEADER]: KEY, host: "127.0.0.1", "x-forwarded-for": "127.0.0.1, 10.0.0.5" }), KEY), false)
  assert.equal(captureKeyAccepted(h({ [CAPTURE_HEADER]: KEY, host: "192.168.1.10:43211", "x-forwarded-for": "127.0.0.1" }), KEY), false)
  assert.equal(captureKeyAccepted(h({ [CAPTURE_HEADER]: KEY, host: "127.0.0.1" }), ""), false)
})
