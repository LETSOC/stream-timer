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
