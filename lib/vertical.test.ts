import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { verticalHealth, verticalProgress, audioArgs, cleanBg, combinedFingerprint, decideAudioCopy, parseVerticalSettings, resolveEncoder, teeSafeUrl, teeTarget, verticalCommand, verticalConflict, verticalFilter, videoArgs } from "@/lib/vertical"
import { buildMediamtxConfig, isVerticalTag, parseRelayLoops } from "@/lib/relay"

test("vertical filter fits 16:9 into 1080x1920, centred, configurable bars", () => {
  assert.equal(verticalFilter("#0000b6"), "scale=1080:-2:flags=bicubic,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0000B6,fps=30,format=yuv420p,setsar=1")
  assert.match(verticalFilter("nope"), /color=0x000000/)
  assert.equal(cleanBg(" #0000b6 "), "#0000B6")
})

test("settings parse: ids deduped/capped, unknown values fall back", () => {
  const s = parseVerticalSettings({ destIds: ["a", "a", "b", 3, "c", "d", "e"], bg: "red", encoder: "x", audio: "aac" })
  assert.deepEqual(s, { destIds: ["a", "b", "c", "d"], bg: "#000000", encoder: "auto", audio: "aac", relay: true })
  assert.equal(resolveEncoder("auto"), "libx264")
  assert.equal(resolveEncoder("videotoolbox"), "videotoolbox")
})

test("video: CBR 4500k, 30fps, keyframe every 2s; audio copy or AAC 48k", () => {
  const x = videoArgs("libx264").join(" ")
  assert.match(x, /-b:v 4500k -minrate 4500k -maxrate 4500k -bufsize 9000k/)
  assert.match(x, /nal-hrd=cbr/)
  assert.match(x, /-g 60 -keyint_min 60 -sc_threshold 0/)
  assert.match(videoArgs("videotoolbox").join(" "), /h264_videotoolbox .*-g 60/)
  assert.deepEqual(audioArgs(true), ["-c:a", "copy"])
  assert.deepEqual(audioArgs(false), ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"])
  assert.equal(decideAudioCopy("auto", ["H264", "MPEG-4 Audio"]), true)
  assert.equal(decideAudioCopy("auto", ["H264", "Opus"]), false)
  assert.equal(decideAudioCopy("aac", ["MPEG-4 Audio"]), false)
  assert.equal(decideAudioCopy("auto", []), true) // capture not up yet: it always sends AAC 48k
})

test("tee target: one encode, N outputs; one bad ingest can't drop the others", () => {
  assert.equal(teeTarget(["rtmp://a/x"]), "[f=flv:flvflags=no_duration_filesize:onfail=abort]rtmp://a/x")
  assert.equal(teeTarget(["rtmp://a/x", "rtmp://b/y"]).split("|").length, 2)
  assert.match(teeTarget(["rtmp://a/x", "rtmp://b/y"]), /onfail=ignore/)
  assert.equal(teeSafeUrl("rtmp://a/live/key?x=1"), true)
  assert.equal(teeSafeUrl("rtmp://a/live/k|y"), false)
  const cmd = verticalCommand({ readUrl: "rtmp://127.0.0.1:19350/capture?user=r&pass=p", urls: ["rtmp://a/x"], bg: "#000000", encoder: "libx264", audioCopy: true })
  assert.equal(cmd[cmd.indexOf("-i") + 1], "rtmp://127.0.0.1:19350/capture?user=r&pass=p")
  assert.deepEqual(cmd.slice(-3), ["-f", "tee", "[f=flv:flvflags=no_duration_filesize:onfail=abort]rtmp://a/x"])
  // Not a "-f flv" publisher, and its relay-loop group is ours: never flagged as a stray.
  assert.ok(!cmd.join(" ").includes(" -f flv "))
})

test("conflicts and tags", () => {
  assert.match(verticalConflict(["f1"], [{ path: "capture", dest: "f1" }], []) ?? "", /Relay \/capture/)
  assert.match(verticalConflict(["f1"], [], [{ channel: "slate", running: true, dest: "f1" }]) ?? "", /Slate/)
  assert.equal(verticalConflict(["f1"], [], [{ channel: "capture", running: true, dest: "f1", relay: true }]), null)
  assert.equal(combinedFingerprint(["rtmp://a/x", "rtmp://b/y"]), combinedFingerprint(["rtmp://b/y", "rtmp://a/x"]))
  assert.ok(isVerticalTag("vertical:dest=0123456789abcdef"))
  assert.ok(!isVerticalTag("forward:capture:id:dest=0123456789abcdef"))
  const loops = parseRelayLoops("  42 42 bash /x/scripts/relay-loop.sh vertical:dest=0123456789abcdef -- ffmpeg\n", "/x/scripts/relay-loop.sh")
  assert.deepEqual(loops, [{ pid: 42, tag: "vertical:dest=0123456789abcdef" }])
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

test("relay output: /vertical is one more tee output that never takes the external ones down", () => {
  const relay = "rtmp://127.0.0.1:19350/vertical?user=vrt_x&pass=y"
  assert.equal(teeTarget([], relay), `[f=flv:flvflags=no_duration_filesize:onfail=abort]${relay}`)
  const one = teeTarget(["rtmp://a/x"], relay).split("|")
  assert.match(one[0], /onfail=abort\]rtmp:\/\/a\/x$/)
  assert.match(one[1], /onfail=ignore\]rtmp:\/\/127\.0\.0\.1:19350\/vertical/)
  assert.equal(parseVerticalSettings({}).relay, true)
  assert.equal(parseVerticalSettings({ relay: false }).relay, false)
})

test("MediaMTX config: /vertical path with its own localhost-only vrt_ publisher", () => {
  const yml = buildMediamtxConfig({ host: "127.0.0.1", ports: { rtmp: 19350, hls: 18888, api: 19997 }, creds: { publishUser: "pub_a", publishPass: "p", readUser: "read_a", readPass: "r", verticalUser: "vrt_a", verticalPass: "v" } })
  assert.match(yml, /^ {2}vertical: \{\}$/m)
  assert.match(yml, /user: "vrt_a"\n {4}pass: "v"\n {4}ips: \['127\.0\.0\.1\/32', '::1\/128'\]\n {4}permissions: \[\{ action: publish, path: vertical \}\]/)
  // the channel publisher can't publish /vertical
  assert.match(yml, /user: "pub_a"[\s\S]*?permissions: \[\{ action: publish, path: slate \}, \{ action: publish, path: capture \}\]/)
})
