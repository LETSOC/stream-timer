import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import * as d from "@/lib/rtmp-destinations"
import { forwardCommand, friendlyForwardError } from "@/lib/relay"
import { redact } from "@/lib/encoder"
import { joinRtmpServerAndKey } from "@/lib/rtmp-join"
import { maskSrtUrl, maskStreamid, redactSrt, srtHostUrl, validateSrtUrl } from "@/lib/srt-destination"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-srt-dest-"))
process.env.STREAM_DATA_DIR = dir
// Test-only placeholders, not real credentials.
const SRT = "srt://203.0.113.7:8890?streamid=publish:program-backup:feeduser:FAKEPASSWD&latency=300000&pkt_size=1316&passphrase=FAKEPHRASE123"
const SRS = "srt://203.0.113.7:10080?streamid=#!::r=live/show,m=publish,s=FAKESIGN&latency=200000"

function withHosts<T>(value: string | undefined, fn: () => T): T {
  const old = process.env.RTMP_ALLOWED_HOSTS
  if (value === undefined) delete process.env.RTMP_ALLOWED_HOSTS
  else process.env.RTMP_ALLOWED_HOSTS = value
  try { return fn() } finally {
    if (old === undefined) delete process.env.RTMP_ALLOWED_HOSTS
    else process.env.RTMP_ALLOWED_HOSTS = old
  }
}

test("validateSrtUrl: accepts MediaMTX and SRS publish URLs", () => {
  for (const url of [SRT, SRS, "srt://[2001:db8::5]:8890?streamid=publish:program", "srt://relay.example.com:8890/?streamid=publish:slate:u:p&mode=caller&transtype=live"]) {
    const r = validateSrtUrl(`  ${url} `)
    assert.ok(r.ok, url)
    assert.equal(r.url, url)
  }
})

test("validateSrtUrl: refuses bad shapes, unknown options, read streamids, never echoes the URL", () => {
  const bad = [
    "", "srt://203.0.113.7?streamid=publish:x", "srt://203.0.113.7:0?streamid=publish:x", "srt://203.0.113.7:70000?streamid=publish:x",
    "srt://user@203.0.113.7:8890?streamid=publish:x", "srt://203.0.113.7:8890/live?streamid=publish:x", "srt://203.0.113.7:8890",
    "srt://203.0.113.7:8890?latency=200", "srt://203.0.113.7:8890?streamid=read:program:u:FAKEPASSWD", "srt://203.0.113.7:8890?streamid=#!::r=live,m=request",
    "srt://203.0.113.7:8890?streamid=publish:x&mode=listener", "srt://203.0.113.7:8890?streamid=publish:x&transtype=file",
    "srt://203.0.113.7:8890?streamid=publish:x&passphrase=short", "srt://203.0.113.7:8890?streamid=publish:x&latency=abc",
    "srt://203.0.113.7:8890?streamid=publish:x&evil=1", "srt://203.0.113.7:8890?streamid=publish:x&streamid=publish:y",
    "srt://203.0.113.7:8890?streamid=publish:x FAKEPASSWD", "srt://bad_host!:8890?streamid=publish:x",
  ]
  for (const url of bad) {
    const r = validateSrtUrl(url)
    assert.equal(r.ok, false, url)
    if (!r.ok) assert.ok(!r.error.includes("FAKEPASSWD") && !r.error.includes("203.0.113.7"), r.error)
  }
  assert.equal(srtHostUrl(SRT), "srt://203.0.113.7:8890")
})

test("masking: streamid credentials and passphrase hidden, latency visible", () => {
  assert.equal(maskStreamid("publish:program-backup:feeduser:FAKEPASSWD"), "publish:program-backup:••••")
  assert.equal(maskStreamid("#!::r=live/show,m=publish,s=FAKESIGN"), "#!::••••")
  assert.equal(maskStreamid("whatever"), "••••")
  const m = maskSrtUrl(SRT)
  assert.equal(m.host, "203.0.113.7:8890")
  assert.equal(m.masked, "srt://203.0.113.7:8890?streamid=publish:program-backup:••••&latency=300000&pkt_size=1316&passphrase=••••")
  assert.equal(m.display, "srt://••••••••?streamid=publish:program-backup:••••&latency=300000&pkt_size=1316&passphrase=••••")
})

test("redact: SRT URLs and bare secrets in logs; RTMP output unchanged", () => {
  const line = `Output #0, mpegts, to '${SRT}':`
  assert.equal(redact(line), "Output #0, mpegts, to 'srt://203.0.113.7:8890?••••':")
  assert.equal(redactSrt("opening streamid=publish:x:u:FAKEPASSWD passphrase=FAKEPHRASE123"), "opening streamid=•••• passphrase=••••")
  assert.equal(redact("Output #0, flv, to 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh':"), "Output #0, flv, to 'rtmp://a.rtmp.youtube.com/••••':")
  assert.equal(redact("rtmp://h/app?password=FAKEPASSWD x"), "rtmp://h/•••• x")
  assert.equal(redact("plain password=FAKEPASSWD"), "plain password=••••")
})

test("relay-loop.sh redacts SRT secrets from ffmpeg output", { skip: spawnSync("perl", ["-v"]).status !== 0 }, () => {
  const out = spawnSync("bash", [path.join(process.cwd(), "scripts/relay-loop.sh"), "t", "--", "bash", "-c", `echo "Output #0, mpegts, to '${SRT}':"; echo "x passphrase=FAKEPHRASE123"; sleep 1`],
    { env: { ...process.env, LOOP_REDACT: "1", LOOP_MAX_DELAY: "1" }, timeout: 1500, encoding: "utf8" })
  const text = `${out.stdout}${out.stderr}`
  assert.ok(text.includes("srt://203.0.113.7:8890?[redacted]"), text)
  assert.ok(text.includes("passphrase=[redacted]"), text)
  assert.ok(!text.includes("FAKEPASSWD") && !text.includes("FAKEPHRASE123"), text)
})

test("forwardCommand: RTMP args byte-identical, SRT uses MPEG-TS", () => {
  const rtmp = forwardCommand("capture", "rtmp://a.rtmp.youtube.com/live2/k")
  const input = rtmp[rtmp.indexOf("-i") + 1]
  const bin = process.env.FFMPEG_BIN || "ffmpeg"
  assert.deepEqual(rtmp, [bin, "-nostdin", "-hide_banner", "-loglevel", "info", "-nostats", "-progress", "pipe:1", "-stats_period", "5",
    "-rw_timeout", "10000000", "-i", input, "-map", "0", "-c", "copy", "-f", "flv", "-rw_timeout", "15000000", "rtmp://a.rtmp.youtube.com/live2/k"])
  assert.deepEqual(forwardCommand("capture", "rtmps://a.rtmps.youtube.com/live2/k").slice(0, -1), rtmp.slice(0, -1))
  const srt = forwardCommand("capture", SRT)
  assert.deepEqual(srt, [...rtmp.slice(0, rtmp.indexOf("flv")), "mpegts", "-rw_timeout", "15000000", SRT])
})

test("friendlyForwardError: SRT hints", () => {
  assert.match(friendlyForwardError("Connection setup failure: connection rejected", SRT), /streamid/)
  assert.match(friendlyForwardError("Operation timed out", SRT), /UDP/)
  assert.match(friendlyForwardError("End of file", "rtmp://x/app/k"), /rtmps/)
})

test("destinations: SRT add obeys RTMP_ALLOWED_HOSTS, list/editInfo masked, file keeps URL, relay-only", () => {
  withHosts(undefined, () => {
    const pub = d.addDestination("Hetzner backup", SRT)
    assert.ok(!pub.ok && /RTMP_ALLOWED_HOSTS/.test(pub.error) && !pub.error.includes("FAKEPASSWD"))
    assert.ok(d.addDestination("LAN SRT", "srt://192.168.1.20:8890?streamid=publish:program:u:FAKEPASSWD").ok, "private host allowed when unset")
  })
  withHosts("203.0.113.7", () => assert.ok(d.addDestination("Listed", SRS).ok))
  const added = withHosts("*", () => d.addDestination("Hetzner backup", SRT))
  assert.ok(added.ok)
  const list = d.listDestinations()
  assert.equal(list.selectedId, null, "SRT is never auto-picked for a direct channel")
  const json = JSON.stringify(list)
  for (const secret of ["FAKEPASSWD", "FAKEPHRASE123", "FAKESIGN", "feeduser"]) assert.ok(!json.includes(secret), secret)
  const item = list.items.find((entry) => entry.id === added.value.id)!
  assert.equal(item.host, "203.0.113.7:8890")
  assert.ok(item.masked.includes("latency=300000"))
  const info = d.destinationEditInfo(added.value.id)!
  assert.equal(info.server, "srt://203.0.113.7:8890")
  assert.equal(info.keyTail, "")
  assert.equal(info.keyKind, "query")
  assert.ok(!JSON.stringify(info).includes("FAKE"))
  assert.equal(d.resolveDestination(added.value.id)?.url, SRT, "full URL stays in the 0600 store for ffmpeg / Reveal")
  assert.equal(fs.statSync(path.join(dir, "rtmp-destinations.json")).mode & 0o777, 0o600)
  const sel = d.selectDestination(added.value.id, "capture")
  assert.ok(!sel.ok && sel.status === 400 && /relay/i.test(sel.error))
  const rtmp = withHosts("*", () => d.addDestination("YT", "rtmp://a.rtmp.youtube.com/live2/k-1234"))
  assert.ok(rtmp.ok)
  assert.equal(d.listDestinations().selectedId, rtmp.value.id)
  // edit: new streamid/passphrase in the key field (with or without "?"), server kept
  withHosts("*", () => {
    const next = "streamid=publish:program:feeduser:FAKEPASSWD2&latency=300000&pkt_size=1316"
    const r = d.updateDestination(added.value.id, { name: "Hetzner main", server: "", key: next })
    assert.ok(r.ok && r.changed)
    assert.equal(d.resolveDestination(added.value.id)?.url, `srt://203.0.113.7:8890?${next}`)
    assert.ok(d.updateDestination(added.value.id, { name: "Hetzner main", server: "", key: `?${next}&latency=1` }).ok === false, "duplicate option refused")
  })
  assert.equal(joinRtmpServerAndKey("srt://h:8890/", "streamid=publish:x"), "srt://h:8890?streamid=publish:x")
  assert.equal(joinRtmpServerAndKey("rtmp://h/live2", "k"), "rtmp://h/live2/k")
})
