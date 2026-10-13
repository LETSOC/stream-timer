import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, beforeEach, test } from "node:test"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stream-timer-auth-"))
process.env.STREAM_DATA_DIR = tmp
let auth: typeof import("./auth.ts")
let rate: typeof import("./rate-limit.ts")
let view: typeof import("./view-key.ts")
before(async () => {
  auth = await import("./auth.ts")
  rate = await import("./rate-limit.ts")
  view = await import("./view-key.ts")
})

const ENV_KEYS = ["OPERATOR_PASSWORD", "OPERATOR_PASSWORD_HASH", "AUTH_MODE", "BIND_HOST", "SESSION_SECRET", "SESSION_VERSION", "VIEW_KEY", "REQUIRE_VIEW_KEY"]
beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  rate.resetRateLimit()
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const req = (url = "http://127.0.0.1:43211/", headers: Record<string, string> = {}) =>
  new Request(url, { headers: { host: new URL(url).host, ...headers } })

test("mode: local by default, password when a password or a non-loopback bind is set", () => {
  assert.equal(auth.authMode(), "local")
  process.env.OPERATOR_PASSWORD = "correct horse"
  assert.equal(auth.authMode(), "password")
  delete process.env.OPERATOR_PASSWORD
  process.env.BIND_HOST = "0.0.0.0"
  assert.equal(auth.authMode(), "password")
  process.env.BIND_HOST = "127.0.0.1"
  assert.equal(auth.authMode(), "local")
})

test("verifyPassword: scrypt hash and plain env, wrong input rejected", () => {
  process.env.OPERATOR_PASSWORD_HASH = auth.hashPassword("s3cret-pass")
  assert.equal(auth.verifyPassword("s3cret-pass"), true)
  assert.equal(auth.verifyPassword("s3cret-pasS"), false)
  delete process.env.OPERATOR_PASSWORD_HASH
  process.env.OPERATOR_PASSWORD = "plain-one"
  assert.equal(auth.verifyPassword("plain-one"), true)
  assert.equal(auth.verifyPassword(""), false)
  delete process.env.OPERATOR_PASSWORD
  assert.equal(auth.verifyPassword("anything"), false, "no password configured never matches")
})

test("session tokens: valid, tampered, expired, version-bumped", () => {
  process.env.SESSION_SECRET = "x".repeat(40)
  const now = 1_800_000_000
  const token = auth.createSessionToken("operator", now)
  assert.ok(auth.verifySessionToken(token, now + 60))
  const [body, mac] = token.split(".")
  const forged = Buffer.from(JSON.stringify({ v: 1, sub: "operator", iat: now, exp: now + 999999, ver: "1" })).toString("base64url")
  assert.equal(auth.verifySessionToken(`${forged}.${mac}`, now), null, "payload swap fails HMAC")
  assert.equal(auth.verifySessionToken(`${body}.${mac}x`, now), null)
  assert.equal(auth.verifySessionToken(token, now + 13 * 3600), null, "expired after 12h")
  process.env.SESSION_VERSION = "2"
  assert.equal(auth.verifySessionToken(token, now + 60), null, "bumping SESSION_VERSION logs everyone out")
  process.env.SESSION_SECRET = "y".repeat(40)
  delete process.env.SESSION_VERSION
  assert.equal(auth.verifySessionToken(token, now + 60), null, "rotating the secret logs everyone out")
})

test("isOperator: loopback in local mode; cookie required in password mode", () => {
  assert.equal(auth.isOperator(req()), true)
  assert.equal(auth.isOperator(req("http://evil.example/", {})), false, "DNS-rebinding Host is not local")
  process.env.OPERATOR_PASSWORD = "pw-1234567"
  assert.equal(auth.isOperator(req()), false)
  const cookie = `${auth.SESSION_COOKIE}=${auth.createSessionToken()}`
  assert.equal(auth.isOperator(req("http://127.0.0.1:43211/", { cookie })), true)
  assert.equal(auth.requireOperator(req())?.status, 401)
})

test("authorizeMutation: cross-origin refused even with a session", () => {
  process.env.OPERATOR_PASSWORD = "pw-1234567"
  const cookie = `${auth.SESSION_COOKIE}=${auth.createSessionToken()}`
  assert.equal(auth.authorizeMutation(req("http://127.0.0.1:43211/", { cookie, origin: "https://evil.example" }))?.status, 403)
  assert.equal(auth.authorizeMutation(req("http://127.0.0.1:43211/", { cookie, origin: "http://127.0.0.1:43211" })), null)
  assert.equal(auth.authorizeMutation(req("https://desk.example.com/", { cookie, origin: "https://desk.example.com" })), null, "same-origin cloud host")
  assert.equal(auth.authorizeMutation(req("http://127.0.0.1:43211/", { origin: "http://127.0.0.1:43211" }))?.status, 401)
})

test("safeNext only allows same-origin paths", () => {
  assert.equal(auth.safeNext("/"), "/")
  assert.equal(auth.safeNext("/?x=1"), "/?x=1")
  for (const bad of ["//evil.example", "https://evil.example", "/\\evil", "", null]) assert.equal(auth.safeNext(bad), "/")
})

test("rate limit: 5 free tries, then a lock that doubles, success resets", () => {
  const t = 1_000_000
  for (let i = 0; i < 4; i++) assert.equal(rate.recordFailure("k", t), 0)
  assert.equal(rate.recordFailure("k", t), 30_000)
  assert.equal(rate.lockedFor("k", t + 10_000), 20_000)
  assert.equal(rate.recordFailure("k", t + 31_000), 60_000)
  rate.recordSuccess("k")
  assert.equal(rate.lockedFor("k", t + 31_001), 0)
  for (let i = 0; i < 30; i++) rate.recordFailure("cap", t)
  assert.equal(rate.lockedFor("cap", t), 15 * 60_000, "capped at 15 min")
})

test("view key: optional in local mode, required in password mode, rotation invalidates", () => {
  assert.equal(view.canView(req("http://127.0.0.1:43211/api/public/state")), true)
  process.env.OPERATOR_PASSWORD = "pw-1234567"
  assert.equal(view.canView(req("http://127.0.0.1:43211/api/public/state")), false)
  const key = view.getViewKey()
  assert.ok(key.length >= 32)
  assert.equal(view.canView(req(`http://127.0.0.1:43211/api/public/state?k=${key}`)), true)
  assert.equal(view.canView(req("http://127.0.0.1:43211/api/public/state", { cookie: `${auth.VIEW_COOKIE}=${key}` })), true)
  const next = view.rotateViewKey()
  assert.notEqual(next, key)
  assert.equal(view.canView(req(`http://127.0.0.1:43211/api/public/state?k=${key}`)), false)
  assert.equal(fs.statSync(path.join(tmp, "view-key")).mode & 0o777, 0o600)
})

test("readCookie: malformed escape is ignored, not thrown (E)", async () => {
  const { readCookie } = await import("@/lib/auth")
  const request = new Request("http://127.0.0.1/", { headers: { cookie: "st_view=%E0%A4%A; other=1" } })
  assert.equal(readCookie(request, "st_view"), undefined)
  assert.equal(readCookie(request, "other"), "1")
})
