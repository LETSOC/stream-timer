import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { verticalHealth, verticalProgress, audioArgs, cleanBg, decideAudioCopy, legacyDestIds, parseVerticalSettings, resolveEncoder, verticalCommand, verticalEncoderNote, verticalFilter, videoArgs, VERTICAL_TAG_RE } from "@/lib/vertical"
import { buildMediamtxConfig, forwardConflict, friendlyForwardError, isVerticalTag, parseRelayLoops } from "@/lib/relay"

test("vertical filter fits 16:9 into 1080x1920, centred, configurable bars", () => {
  assert.equal(verticalFilter("#0000b6"), "scale=1080:-2:flags=bicubic,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0000B6,fps=30,format=yuv420p,setsar=1")
  assert.match(verticalFilter("nope"), /color=0x000000/)
  assert.equal(cleanBg(" #0000b6 "), "#0000B6")
})

test("video: CBR 4500k, 30fps, keyframe every 2s; audio copy or AAC 48k", () => {
  const x = videoArgs("libx264").join(" ")
  assert.match(x, /-b:v 4500k -minrate 4500k -maxrate 4500k -bufsize 9000k/)
  assert.match(x, /nal-hrd=cbr/)
  assert.match(x, /-g 60 -keyint_min 60 -sc_threshold 0/)
  assert.match(videoArgs("videotoolbox").join(" "), /h264_videotoolbox .*-g 60/)
  assert.deepEqual(audioArgs(true), ["-c:a", "copy"])
  assert.deepEqual(audioArgs(false), ["-af", "aresample=async=1:first_pts=0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"])
  assert.equal(decideAudioCopy("auto", ["H264", "MPEG-4 Audio"]), false) // re-encode so gaps realign
  assert.equal(decideAudioCopy("copy", ["H264", "MPEG-4 Audio"]), true)
  assert.equal(decideAudioCopy("auto", ["H264", "Opus"]), false)
  assert.equal(decideAudioCopy("aac", ["MPEG-4 Audio"]), false)
  assert.equal(decideAudioCopy("auto", []), false)
  for (const enc of ["libx264", "videotoolbox"] as const) assert.ok(videoArgs(enc).join(" ").includes("-force_key_frames expr:gte(t,n_forced*2)"), enc)
})

test("ffmpeg accepts the filter: 1920x1080 in → 1080x1920 out with the picture at y=656", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 }, () => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-f", "lavfi", "-i", "color=c=white:s=1920x1080:d=0.2:r=30", "-vf", `${verticalFilter("#0000B6")},cropdetect=limit=0.5:round=2:reset=1`, "-frames:v", "3", "-f", "null", "-"], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /1080x1920/)
})

test("progress: fps/speed from the last block; slow encoder warns", () => {
  const log = "frame=900\nfps=30.02\ntotal_size=N/A\nspeed=1.01x\nprogress=continue\nframe=1050\nfps=24.1\ndrop_frames=3\ndup_frames=1\nspeed=0.85x\nprogress=continue\n"
  const p = verticalProgress(log)
  assert.deepEqual(p, { fps: 24.1, speed: 0.85, frame: 1050, drop: 3, dup: 1 })
  const h = verticalHealth(p, 1000)
  assert.equal(h.level, "bad")
  assert.equal(h.kbps, 4500)
  assert.equal(verticalHealth(verticalProgress(""), null).level, "idle")
})

test("MediaMTX config: /vertical path with its own localhost-only vrt_ publisher", () => {
  const yml = buildMediamtxConfig({ host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds: { publishUser: "pub_a", publishPass: "p", readUser: "read_a", readPass: "r", verticalUser: "vrt_a", verticalPass: "v" } })
  assert.match(yml, /^ {2}vertical: \{\}$/m)
  assert.match(yml, /user: "vrt_a"\n {4}pass: "v"\n {4}ips: \['127\.0\.0\.1\/32', '::1\/128'\]\n {4}permissions: \[\{ action: publish, path: vertical \}\]/)
  // the channel publisher can't publish /vertical
  assert.match(yml, /user: "pub_a"[\s\S]*?permissions: \[\{ action: publish, path: slate \}, \{ action: publish, path: capture \}\]/)
})

test("settings parse; legacy direct ticks are read for migration; Auto = VideoToolbox on macOS only", () => {
  assert.deepEqual(parseVerticalSettings({ destIds: ["a"], bg: "red", encoder: "x", audio: "aac", relay: false }), { bg: "#000000", encoder: "auto", audio: "aac" })
  assert.deepEqual(legacyDestIds({ destIds: ["a", "a", "b", 3, "bad id!"] }), ["a", "b"])
  assert.deepEqual(legacyDestIds({}), [])
  assert.equal(resolveEncoder("auto", "darwin"), "videotoolbox")
  assert.equal(resolveEncoder("auto", "linux"), "libx264")
  assert.equal(resolveEncoder("libx264", "darwin"), "libx264")
})

test("encoder publishes ONLY to relay /vertical (one flv output, no tee)", () => {
  const cmd = verticalCommand({ readUrl: "rtmp://127.0.0.1:19350/capture?user=r&pass=p", publishUrl: "rtmp://127.0.0.1:19350/vertical?user=vrt_a&pass=v", bg: "#000000", encoder: "videotoolbox", audioCopy: true })
  assert.equal(cmd[cmd.indexOf("-i") + 1], "rtmp://127.0.0.1:19350/capture?user=r&pass=p")
  assert.equal(cmd.at(-1), "rtmp://127.0.0.1:19350/vertical?user=vrt_a&pass=v")
  assert.ok(!cmd.includes("tee"))
  assert.equal(cmd.filter((a) => a === "-f").length, 1)
  assert.ok(cmd.includes("h264_videotoolbox"))
  assert.ok(VERTICAL_TAG_RE.test("vertical:dest=relay"))
  assert.ok(isVerticalTag("vertical:dest=relay"))
  assert.ok(!isVerticalTag("forward:vertical:id:dest=0123456789abcdef"))
  assert.deepEqual(parseRelayLoops("  42 42 bash /x/scripts/relay-loop.sh vertical:dest=relay -- ffmpeg\n", "/x/scripts/relay-loop.sh"), [{ pid: 42, tag: "vertical:dest=relay" }])
})

test("same-key guard: /vertical forward refused where another path forwards or a channel publishes", () => {
  assert.match(forwardConflict({ path: "vertical", dest: "f1" }, [{ path: "capture", dest: "f1" }], []) ?? "", /Relay \/capture already forwards/)
  assert.match(forwardConflict({ path: "vertical", dest: "f1" }, [], [{ channel: "slate", running: true, dest: "f1" }]) ?? "", /Slate/)
  assert.equal(forwardConflict({ path: "vertical", dest: "f1" }, [{ path: "vertical", dest: "f1" }], []), null)
})

test("forward errors become operator hints (EOF = platform hung up: key/URL/rtmps)", () => {
  const eof = friendlyForwardError("[out#0/flv] Error opening output rtmp://live.tiktok.com/[redacted]: End of file", "rtmp://live.tiktok.com/x/y")
  assert.match(eof, /Platform closed the connection — check the stream URL\/key/)
  assert.match(eof, /TikTok\/Instagram keys expire each session/)
  assert.match(eof, /rtmps:\/\//)
  assert.doesNotMatch(friendlyForwardError("Error opening output files: End of file", "rtmps://a/b"), /use that/)
  assert.match(friendlyForwardError("Error opening output files: Connection refused"), /Connection refused — wrong server/)
  assert.equal(friendlyForwardError("something odd"), "something odd")
})

test("relay-loop backs off past LOOP_MAX_DELAY after LOOP_SLOW_AFTER quick failures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-"))
  const state = path.join(dir, "s.json")
  const r = spawnSync("bash", ["-c", `LOOP_STATE_FILE=${state} LOOP_MAX_DELAY=1 LOOP_SLOW_AFTER=2 LOOP_SLOW_MAX=4 timeout 5 bash scripts/relay-loop.sh t -- false`], { encoding: "utf8" })
  const delays = [...r.stdout.matchAll(/restarting in (\d+)s/g)].map((m) => Number(m[1]))
  assert.deepEqual(delays.slice(0, 3), [1, 1, 2])
  assert.ok(fs.readFileSync(state, "utf8").includes('"nextDelay":'))
})

test("vertical start line names its encoder", () => {
  assert.equal(verticalEncoderNote("videotoolbox", true), "encoder (vertical): h264_videotoolbox (rate-capped), 1080x1920@30, 4500k, audio copy")
  assert.equal(verticalEncoderNote("libx264", false), "encoder (vertical): libx264 (constant bitrate), 1080x1920@30, 4500k, audio AAC")
})
