# SRS experiment

Branch `exp/srs-on-main` is based on current `main` (includes split-arm + destinations edit).

This evaluates [SRS](https://github.com/ossrs/srs) (MIT) as a side-by-side Backup 2 / Backup 3 ingest, mainly for the noisy SRT path.

**Does not touch** the MediaMTX relay in `lib/relay.ts`, the browser capture path, arm/disarm, or destinations.

## Config

`scripts/srs.conf` — listens on ports that do not collide with MediaMTX.

| Service | Port | MediaMTX equivalent |
|---------|------|---------------------|
| RTMP    | 19360 | 19350 |
| SRT     | 10080/udp | 8890 |
| HTTP/HLS| 8088 | 18888 |
| API     | 1985 | 19997 |

## OBS (Backup 2 or Backup 3)

**RTMP (simplest)**

- Server: `rtmp://<show-mac-lan-ip>:19360/live`
- Stream Key: `backup2` or `backup3`

**SRT (optional)**

```
srt://<show-mac-lan-ip>:10080?streamid=#!::r=live/backup2,m=publish
```

## Start SRS

From the repo root after `git checkout exp/srs-on-main`:

```bash
docker run --rm -it \
  -p 19360:19360 -p 8088:8088 -p 1985:1985 -p 10080:10080/udp \
  -v "$PWD/scripts/srs.conf:/usr/local/srs/conf/srs.conf" \
  ossrs/srs:6
```

`ossrs/srs:6` has an arm64 image, so it runs natively on the MacBook. The image's own entrypoint loads the mounted conf.

Or a local binary: `./objs/srs -c scripts/srs.conf`

## Test playback

- RTMP: `rtmp://127.0.0.1:19360/live/backup2`
- HTTP-FLV: `http://127.0.0.1:8088/live/backup2.flv`
- HLS: `http://127.0.0.1:8088/live/backup2.m3u8`
- Streams list: `http://127.0.0.1:1985/api/v1/streams/`

## Next

Once a feed is stable on SRS, we can optionally have the existing player or a capture path read from `rtmp://127.0.0.1:19360/live/backup2` instead of (or as a third source beside) MediaMTX `/program-backup`.
