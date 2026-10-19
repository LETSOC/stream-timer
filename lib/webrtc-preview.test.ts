import test from "node:test"
import assert from "node:assert/strict"
import { buildMediamtxConfig, webrtcIceHost } from "@/lib/relay"
import { rewriteWhepLocation, whepTarget } from "@/lib/whep-proxy"
import { whepPathFromHls } from "@/lib/whep-client"

const creds = { publishUser: "p", publishPass: "pp", readUser: "r", readPass: "rr", programUser: "obs", programPass: "op", backupUser: "bak", backupPass: "bp" }
const base = { host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds, programArmed: true }

test("WebRTC off: webrtc: no and no webrtc keys", () => {
  const yml = buildMediamtxConfig(base)
  assert.match(yml, /^webrtc: no$/m)
  assert.doesNotMatch(yml, /webrtcAddress|webrtcLocal/)
})

test("WebRTC on: signalling on 127.0.0.1 only, media on the LAN ICE port, LAN IP advertised; RTMP lines unchanged", () => {
  const off = buildMediamtxConfig(base)
  const on = buildMediamtxConfig({ ...base, webrtc: { httpPort: 18889, iceHost: "0.0.0.0", icePort: 8189, additionalHosts: ["192.168.0.24"] } })
  assert.match(on, /^webrtc: yes\nwebrtcAddress: 127\.0\.0\.1:18889$/m)
  assert.match(on, /^webrtcLocalUDPAddress: 0\.0\.0\.0:8189$/m)
  assert.match(on, /^webrtcLocalTCPAddress: 0\.0\.0\.0:8189$/m)
  assert.match(on, /^webrtcAdditionalHosts: \["192\.168\.0\.24"\]$/m)
  assert.match(on, /^webrtcEncryption: no$/m)
  for (const line of off.split("\n").filter((l) => /^(rtmp|srt|authInternalUsers|  - user|    (pass|ips|permissions))/.test(l))) assert.ok(on.includes(line), line)
  // No WebRTC publish permission is added for anyone.
  assert.equal((on.match(/action: publish/g) ?? []).length, (off.match(/action: publish/g) ?? []).length)
})

test("ICE host follows BIND_HOST (LAN desk → all interfaces; local desk → loopback)", () => {
  assert.equal(webrtcIceHost({ BIND_HOST: "0.0.0.0" }), "0.0.0.0")
  assert.equal(webrtcIceHost({}), "127.0.0.1")
  assert.equal(webrtcIceHost({ BIND_HOST: "127.0.0.1" }), "127.0.0.1")
  assert.equal(webrtcIceHost({ BIND_HOST: "192.168.0.24" }), "192.168.0.24")
})

test("WHEP proxy: read paths only, session ids validated, Location rewritten", () => {
  const allowed = ["slate", "capture", "vertical", "program", "program-backup"]
  assert.equal(whepTarget(["program"], "POST", allowed), "/program/whep")
  assert.equal(whepTarget(["program", "x"], "POST", allowed), null)
  assert.equal(whepTarget(["nope"], "POST", allowed), null)
  assert.equal(whepTarget(["capture", "3f0c2a1e-1111-2222-3333-444455556666"], "PATCH", allowed), "/capture/whep/3f0c2a1e-1111-2222-3333-444455556666")
  assert.equal(whepTarget(["capture", "../x"], "DELETE", allowed), null)
  assert.equal(rewriteWhepLocation("/program/whep/3f0c2a1e-1111-2222-3333-444455556666", "program"), "/api/relay/whep/program/3f0c2a1e-1111-2222-3333-444455556666")
  assert.equal(rewriteWhepLocation(null, "program"), null)
  assert.equal(whepPathFromHls("/api/relay/hls/program-backup/index.m3u8"), "program-backup")
  assert.equal(whepPathFromHls("/media/stream.m3u8"), null)
})

import { previewDisplay } from "@/lib/program-display"
test("preview: 'Waiting for OBS' only after 3s with no publisher; stalls/swaps show reconnecting, never standby", () => {
  const now = 100_000
  assert.equal(previewDisplay({ now, ready: true, notReadySince: null, lastFrameAt: now - 100 }), "video")
  assert.equal(previewDisplay({ now, ready: true, notReadySince: null, lastFrameAt: now - 8000 }), "reconnecting") // long player stall, OBS still there
  assert.equal(previewDisplay({ now, ready: true, notReadySince: null, lastFrameAt: null }), "connecting") // (re)loading / swapping
  assert.equal(previewDisplay({ now, ready: false, notReadySince: now - 2000, lastFrameAt: now - 2000 }), "reconnecting") // brief publisher gap
  assert.equal(previewDisplay({ now, ready: false, notReadySince: now - 3500, lastFrameAt: now - 3500 }), "standby")
  assert.equal(previewDisplay({ now, ready: false, notReadySince: now - 3500, lastFrameAt: null }), "standby")
})

test("WebRTC config caps UDP payload at 1200 (no fragmentation on Wi-Fi/VPN); off = no WebRTC keys", async () => {
  const { buildMediamtxConfig } = await import("@/lib/relay")
  const creds = { publishUser: "p", publishPass: "p", readUser: "r", readPass: "r", programUser: "o", programPass: "o", backupUser: "b", backupPass: "b", verticalUser: "v", verticalPass: "v" }
  const base = { host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds }
  const on = buildMediamtxConfig({ ...base, webrtc: { httpPort: 18889, iceHost: "127.0.0.1", icePort: 8189, additionalHosts: [] } })
  assert.match(on, /^udpMaxPayloadSize: 1200$/m)
  assert.match(on, /^webrtcLocalTCPAddress: /m)
  assert.doesNotMatch(buildMediamtxConfig(base), /udpMaxPayloadSize/)
  assert.match(on, /^hlsAlwaysRemux: no$/m)
})
