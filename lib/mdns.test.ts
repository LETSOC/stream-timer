import assert from "node:assert/strict"
import test from "node:test"
import { allRecords, answersFor, cleanMdnsName, conflictFrom, instanceName, mdnsHost, serviceType } from "./mdns.ts"

const cfg = { name: "hyphen-stream", ip: "192.168.1.20", port: 19350 }

test("names: lowercase DNS label, .local stripped, junk rejected", () => {
  assert.equal(cleanMdnsName("Hyphen-Stream"), "hyphen-stream")
  assert.equal(cleanMdnsName("hyphen-stream.local"), "hyphen-stream")
  assert.equal(cleanMdnsName(" stage2 "), "stage2")
  for (const bad of ["", "-a", "a-", "a b", "a.b", "ü", "x".repeat(64), 5, null]) assert.equal(cleanMdnsName(bad), null, String(bad))
})

test("A record for <name>.local, service PTR/SRV/TXT on the ingest port", () => {
  assert.deepEqual(answersFor(cfg, { name: "hyphen-stream.local", type: "A" }).map((a) => [a.type, a.data]), [["A", "192.168.1.20"]])
  assert.deepEqual(answersFor(cfg, { name: "HYPHEN-STREAM.local", type: "A" }).length, 1)
  const svc = answersFor(cfg, { name: serviceType, type: "PTR" })
  assert.deepEqual(svc.map((a) => a.type), ["PTR", "SRV", "TXT", "A"])
  assert.equal(svc[0].data, instanceName("hyphen-stream"))
  assert.deepEqual(svc[1].data, { port: 19350, weight: 0, priority: 0, target: mdnsHost("hyphen-stream") })
  assert.equal(answersFor(cfg, { name: "other.local", type: "A" }).length, 0)
  assert.equal(answersFor(cfg, { name: "hyphen-stream.local", type: "AAAA" }).length, 0)
  assert.deepEqual(answersFor(cfg, { name: "_services._dns-sd._udp.local", type: "PTR" }).map((a) => a.data), [serviceType])
})

test("goodbye = same records with ttl 0", () => {
  assert.ok(allRecords(cfg, 0).every((a) => a.ttl === 0))
})

test("conflict: someone else answers for our name; our own IPs are not a conflict", () => {
  const ans = [{ name: "hyphen-stream.local", type: "A", data: "192.168.1.77" }]
  assert.equal(conflictFrom(ans, "hyphen-stream", ["192.168.1.20"]), "192.168.1.77")
  assert.equal(conflictFrom(ans, "hyphen-stream", ["192.168.1.77"]), null)
  assert.equal(conflictFrom([{ name: "other.local", type: "A", data: "1.2.3.4" }], "hyphen-stream", []), null)
})
