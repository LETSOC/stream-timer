import test from "node:test"
import assert from "node:assert/strict"
import { localAccess } from "@/lib/local-access"

const ifaces = {
  lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
  utun3: [{ family: "IPv4", address: "10.8.0.2", internal: false }],
  en0: [{ family: "IPv6", address: "fe80::1", internal: false }, { family: "IPv4", address: "192.168.0.24", internal: false }],
}

test("local access prefers the Wi-Fi/LAN IPv4 and the real port 43211", () => {
  const a = localAccess(ifaces, { BIND_HOST: "0.0.0.0" })
  assert.deepEqual(a, { ip: "192.168.0.24", port: 43211, base: "http://192.168.0.24:43211", boundToLan: true })
  assert.equal(localAccess(ifaces, { BIND_HOST: "0.0.0.0", PORT: "5000" }).base, "http://192.168.0.24:5000")
})

test("local access flags a loopback-only server and honours a pinned BIND_HOST", () => {
  assert.equal(localAccess(ifaces, {}).boundToLan, false)
  assert.equal(localAccess(ifaces, { BIND_HOST: "10.0.0.5" }).ip, "10.0.0.5")
  assert.equal(localAccess({ lo0: ifaces.lo0 }, { BIND_HOST: "0.0.0.0" }).base, null)
})
