import assert from "node:assert/strict"
import test from "node:test"
import { parseStrayPublishers } from "./encoder.ts"

const ps = [
  // This app's own supervisor group (pgid 500): script + ffmpeg publishing to Castr.
  "  500   500 bash /app/scripts/rtmp-supervisor.sh",
  "  501   500 bash /app/scripts/stream-countdown.sh",
  "  502   500 ffmpeg -hide_banner -re -loop 1 -i slate.png -f flv rtmp://uk.castr.io/static/live_x?password=secret",
  // A publisher left running in a Terminal tab.
  "  900   900 /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -re -f lavfi -i color=c=0x111111 -c:a aac -f flv rtmp://uk.castr.io/static/live_x?password=secret",
  // Things that must not count.
  "  910   910 ffmpeg -hide_banner -re -i slate.png -f hls -hls_time 2 data/hls/stream.m3u8",
  "  911   911 ffmpeg -hide_banner -re -i slate.png -t 6 -f mp4 test.mp4",
  "  912   912 ffmpeg -hide_banner -re -i slate.png -f flv -",
  "  913   913 grep -f flv rtmp://example.com",
  "  914   914 node server.js",
].join("\n")

test("flags an ffmpeg publisher that is outside this app's supervisor group", () => {
  const strays = parseStrayPublishers(ps, 500, 1)
  assert.deepEqual(strays.map((s) => s.pid), [900])
})

test("never leaks the stream password", () => {
  const [stray] = parseStrayPublishers(ps, 500, 1)
  assert.ok(!stray.command.includes("secret"))
  assert.ok(stray.command.includes("password=••••"))
})

test("with no supervisor running, every publisher is a stray", () => {
  const strays = parseStrayPublishers(ps, null, 1)
  assert.deepEqual(strays.map((s) => s.pid), [502, 900])
})

test("ignores the HLS preview, file renders, previews and unrelated processes", () => {
  const strays = parseStrayPublishers(ps, null, 1)
  assert.ok(!strays.some((s) => [910, 911, 912, 913, 914].includes(s.pid)))
})

test("skips its own pid", () => {
  assert.deepEqual(parseStrayPublishers(ps, 500, 900), [])
})
