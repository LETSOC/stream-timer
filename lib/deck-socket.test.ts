import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, beforeEach, test } from "node:test"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deck-socket-"))
process.env.STREAM_DATA_DIR = tmp
let sock: typeof import("./deck-socket.ts")
let auth: typeof import("./auth.ts")
let client: typeof import("./use-deck-socket.ts")
before(async () => {
  sock = await import("./deck-socket.ts")
  auth = await import("./auth.ts")
  client = await import("./use-deck-socket.ts")
})
const deckUpgradeDenied = (r: Request) => sock.deckUpgradeDenied(r)
const createSessionToken = () => auth.createSessionToken()
const SESSION_COOKIE = "st_session"
const backoffMs = (a: number, r: number) => client.backoffMs(a, r)

beforeEach(() => {
  for (const key of ["OPERATOR_PASSWORD", "OPERATOR_PASSWORD_HASH", "AUTH_MODE", "BIND_HOST"]) delete process.env[key]
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const up = (headers: Record<string, string>, remote = "127.0.0.1") => sock.upgradeRequest({ headers, url: "/api/deck/ws" }, remote)
const LOCAL = { host: "127.0.0.1:43211", origin: "http://127.0.0.1:43211" }

test("socket address is always appended to X-Forwarded-For", () => {
  assert.equal(up(LOCAL, "::ffff:127.0.0.1").headers.get("x-forwarded-for"), "127.0.0.1")
  assert.equal(up({ ...LOCAL, "x-forwarded-for": "127.0.0.1" }, "192.168.1.9").headers.get("x-forwarded-for"), "127.0.0.1, 192.168.1.9")
})

test("local mode: loopback socket allowed; LAN socket or spoofed XFF is not", () => {
  assert.equal(deckUpgradeDenied(up(LOCAL)), null)
  assert.equal(deckUpgradeDenied(up({ ...LOCAL, "x-forwarded-for": "127.0.0.1" }, "192.168.1.9")), 401)
})

test("Origin is required and must be same-origin", () => {
  assert.equal(deckUpgradeDenied(up({ host: LOCAL.host })), 403)
  assert.equal(deckUpgradeDenied(up({ ...LOCAL, origin: "https://evil.example" })), 403)
  assert.equal(deckUpgradeDenied(up({ ...LOCAL, origin: "null" })), 403)
})

test("password mode: needs a valid session cookie (no encoder token)", () => {
  process.env.OPERATOR_PASSWORD = "pw-for-tests-123"
  const lan = { host: "192.168.1.5:43211", origin: "http://192.168.1.5:43211" }
  assert.equal(deckUpgradeDenied(up(lan, "192.168.1.9")), 401)
  assert.equal(deckUpgradeDenied(up({ ...lan, authorization: "Bearer whatever" }, "192.168.1.9")), 401)
  assert.equal(deckUpgradeDenied(up({ ...lan, cookie: `${SESSION_COOKIE}=forged.sig` }, "192.168.1.9")), 401)
  assert.equal(deckUpgradeDenied(up({ ...lan, cookie: `${SESSION_COOKIE}=${createSessionToken()}` }, "192.168.1.9")), null)
  assert.equal(deckUpgradeDenied(up({ ...lan, origin: "http://evil.lan", cookie: `${SESSION_COOKIE}=${createSessionToken()}` }, "192.168.1.9")), 403)
})

test("reconnect backoff grows and caps at ~10s", () => {
  assert.equal(backoffMs(0, 0.5), 500)
  assert.equal(backoffMs(3, 0.5), 4000)
  assert.ok(backoffMs(20, 1) <= 12_000)
})
