import assert from "node:assert/strict"
import { test } from "node:test"
import { logState, parsePingMs, pingArgs, rttLabel, rttLevel, rttStats } from "@/lib/rtt"

test("parse ping output (macOS, Linux, <1ms, timeout)", () => {
  assert.equal(parsePingMs("64 bytes from 192.168.1.20: icmp_seq=0 ttl=64 time=7.123 ms"), 7.123)
  assert.equal(parsePingMs("64 bytes from 10.0.0.2: icmp_seq=1 ttl=63 time=23.4 ms"), 23.4)
  assert.equal(parsePingMs("reply from 10.0.0.2: time<1 ms"), 0.5)
  assert.equal(parsePingMs("Request timeout for icmp_seq 0\n1 packets transmitted, 0 received"), null)
  assert.deepEqual(pingArgs("h", "darwin"), ["-n", "-c", "1", "-W", "1000", "h"])
  assert.deepEqual(pingArgs("h", "linux"), ["-n", "-c", "1", "-W", "1", "h"])
})

test("RTT stats, levels and labels", () => {
  const now = 100_000
  const s = [{ at: 30_000, ms: 999, method: "icmp" as const }, { at: 50_000, ms: 6, method: "icmp" as const }, { at: 55_000, ms: null, method: null }, { at: 60_000, ms: 8, method: "icmp" as const }]
  const st = rttStats(s, now)
  assert.equal(st.recent.length, 3)
  assert.equal(st.lossPct, 33)
  assert.equal(st.avgMs, 7)
  assert.equal(rttLevel(8, 7, 0, 3), "ok")
  assert.equal(rttLevel(60, 40, 0, 3), "high")
  assert.equal(rttLevel(8, 7, 5, 12), "high")
  assert.equal(rttLevel(200, 180, 0, 3), "bad")
  assert.equal(rttLevel(8, 7, 33, 3), "bad")
  assert.equal(rttLevel(null, null, 100, 3), "lost")
  assert.equal(rttLevel(null, null, 0, 0), null)
  assert.equal(logState("bad"), "high")
  assert.equal(rttLabel(null), "—")
  assert.equal(rttLabel({ host: "h", via: "push", method: "icmp", lastMs: 7.2, avgMs: 7, maxMs: 9, lossPct: 0, samples: 3, level: "ok" }), "ping 7.2ms")
  assert.equal(rttLabel({ host: "h", via: "pull", method: "tcp", lastMs: 23, avgMs: 22, maxMs: 30, lossPct: 8, samples: 12, level: "high" }), "tcp 23ms · 8% loss")
})
