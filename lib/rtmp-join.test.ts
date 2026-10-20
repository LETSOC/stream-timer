import assert from "node:assert/strict"
import { test } from "node:test"
import { joinRtmpServerAndKey } from "@/lib/rtmp-join"

test("server + key join: trim, single slash, ?query keys, paste compat", () => {
  assert.equal(joinRtmpServerAndKey(" rtmp://a.rtmp.youtube.com/live2/ ", " abcd-1234 "), "rtmp://a.rtmp.youtube.com/live2/abcd-1234")
  assert.equal(joinRtmpServerAndKey("rtmp://live.restream.io/live", "/re_key"), "rtmp://live.restream.io/live/re_key")
  assert.equal(joinRtmpServerAndKey("rtmp://live.restream.io/live//", "//re_key"), "rtmp://live.restream.io/live/re_key")
  assert.equal(joinRtmpServerAndKey("rtmp://host/app/stream", "?password=x"), "rtmp://host/app/stream?password=x")
  assert.equal(joinRtmpServerAndKey("rtmp://live.restream.io/live/KEY", ""), "rtmp://live.restream.io/live/KEY")
})

test("split is the inverse of join (edit form) and the display mask hides host + key", async () => {
  const { splitRtmpUrl, maskRtmpDisplay } = await import("@/lib/rtmp-join")
  for (const url of ["rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl", "rtmps://live-api-s.facebook.com:443/rtmp/FB-123?s_bl=1&a=xyz", "rtmp://uk.castr.io/static?password=pw", "rtmp://uk.castr.io/static/live_abcd?password=pw12", "rtmp://host/app"]) {
    const { server, key } = splitRtmpUrl(url)
    assert.equal(joinRtmpServerAndKey(server, key), url, url)
  }
  assert.deepEqual(splitRtmpUrl("rtmp://a.rtmp.youtube.com/live2/abcd"), { server: "rtmp://a.rtmp.youtube.com/live2", key: "abcd" })
  assert.equal(maskRtmpDisplay("rtmp://live.example.com/live/a1b2c3d4e5f6"), "rtmp://••••••••/live/••••••••e5f6")
  assert.ok(!maskRtmpDisplay("rtmps://live-api-s.facebook.com:443/rtmp/FB-123?s_bl=1&a=xyz").includes("facebook"))
})
