# SRS experiment

This branch (`exp/srs`) is for evaluating [SRS](https://github.com/ossrs/srs) (MIT) as a side-by-side or alternative to MediaMTX, mainly for the Backup SRT path.

**Does not touch** the MediaMTX relay in `lib/relay.ts` or the browser capture path. Main / `fix/capture-health` stay unchanged.

## Why SRS

From the 20 Oct logs:
- Backup SRT is the noisy part (RTT spikes, packet loss, `PIPELINE_ERROR_DECODE`, HLS part-duration changes).
- Capture + VideoToolbox is otherwise holding real-time.
- MediaMTX is already MIT and solid for the local relay. SRS is the main peer worth testing for SRT resilience.

## Plan

1. Run SRS on a different port set (e.g. RTMP 19360, SRT 10080, HTTP 8088) so it does not collide with MediaMTX (19350 / 8890 / 18888).
2. Point only the Backup OBS (or a test publisher) at the SRS SRT/RTMP listener.
3. Have SRS output HLS or RTMP that the existing player / capture can optionally consume.
4. Compare SRT behaviour (latency, loss, reconnect) against the MediaMTX Backup path.

## Ports (proposed, unused by stream-timer)

| Service | Port | Notes |
|---------|------|-------|
| RTMP    | 19360 | local only |
| SRT     | 10080 | Backup test |
| HTTP/HLS| 8088  | preview |
| API     | 1985  | SRS default |

## Next steps

- Add `scripts/srs.conf` (minimal SRT + RTMP + HLS).
- Optional: a small `scripts/srs-loop.sh` or supervisor entry that starts/stops SRS independently of MediaMTX.
- Keep MediaMTX as the production relay until SRS proves better on the Backup link.
