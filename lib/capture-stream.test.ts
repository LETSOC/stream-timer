import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { test } from "node:test"

const script = path.join(process.cwd(), "scripts", "capture-stream.mjs")

test("capture script refuses to run without its URLs", () => {
  const run = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 20000 })
  assert.equal(run.status, 2)
})

test("capture script exits non-zero (so the supervisor restarts it) and never prints the stream key", () => {
  const run = spawnSync(process.execPath, [script], {
    env: { ...process.env, CAPTURE_URL: "http://127.0.0.1:9/stream?k=VIEWKEYSECRET", RTMP_URL: "rtmp://127.0.0.1:9/live/STREAMKEYSECRET", ENCODER_TOKEN: "x" },
    encoding: "utf8",
    timeout: 60000,
  })
  assert.notEqual(run.status, 0)
  const out = `${run.stdout}${run.stderr}`
  assert.ok(!out.includes("STREAMKEYSECRET") && !out.includes("VIEWKEYSECRET"), out)
})

test("program audio delay may follow a player up to 10s behind (Backup latency ~6s was capped at 5s)", async () => {
  const src = (await import("node:fs")).readFileSync(script, "utf8")
  const body = src.slice(src.indexOf("function programTargetMs()"), src.indexOf("function readUrlFor("))
  assert.match(body, /Math\.max\(100, Math\.min\(10000, /)
})
