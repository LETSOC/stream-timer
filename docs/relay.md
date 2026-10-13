# MediaMTX relay (optional)

Off by default. When on, the app runs a local [MediaMTX](https://github.com/bluenviron/mediamtx)
and fans each channel out to several saved destinations:

```
Slate ──────► rtmp://127.0.0.1:19350/slate   ──► ffmpeg -c copy ──► Destination A
Capture ────► rtmp://127.0.0.1:19350/capture ──► ffmpeg -c copy ──► Destination B, C …
                         └─ LL-HLS ──► /api/relay/hls/<path>/index.m3u8 (desk preview, operator auth)
```

The direct mode (a channel straight to one destination) still works as before.

## Install

On a Mac, pick one:

- `brew install mediamtx`. The app finds `/opt/homebrew/bin/mediamtx` and `/usr/local/bin/mediamtx`.
- `scripts/install-mediamtx.sh`. It downloads the release binary into `bin/mediamtx` (gitignored). Pass a version to pin it, e.g. `scripts/install-mediamtx.sh v1.21.2`.
- Set `MEDIAMTX_BIN=/path/to/mediamtx`.

The app looks in this order: `MEDIAMTX_BIN`, then `bin/mediamtx`, then the Homebrew paths, then `PATH`.

## Use (desk → Encoder)

Channels and forwards are independent.

1. Set a channel's destination to **Relay (MediaMTX) → /slate** (or **/capture**) and press Start. This starts the relay **server** if needed and publishes to it. Nothing goes out yet, but the preview works.
2. In the **Relay** card, tick the destinations each path should forward to, then press **Start forwards** to fan out. Every forward has its own status (Waiting for source, Connecting, Forwarding, Retrying, Stalled, Blocked) and live health.
   - **N reconnects:** times a working connection (10s or more) dropped and was made again.
   - **N retries:** quick relaunches that never connected, for example while the source isn't publishing.
3. **Stop forwards** ends the fan-out only. Channels keep publishing to the relay and the preview keeps playing. **Start forwards** resumes every ticked destination.
4. Stopping a channel leaves its forwards waiting for the source. The server stops by itself once no channel publishes to it and forwards are off. If MediaMTX crashes, its loop restarts it and the channel's supervisor reconnects the publisher.
5. **Stop all** stops every channel, every forward and the server. Ticks are kept.

## Files (data/relay/, files 0600, folder 0700, all gitignored)

| file | what |
| --- | --- |
| `settings.json` | relay on/off, forward ticks per path (destination ids) |
| `credentials.json` | random publish / read users for MediaMTX |
| `mediamtx.yml` | generated config (rewritten on each relay start) |
| `mediamtx.json`, `fwd-<path>-<id>.json` | pidfiles (process-group leaders of `scripts/relay-loop.sh`) |
| `*.log`, `*-state.json` | logs (stream keys redacted) and restart state |

After a server restart the app finds the running relay loops (by this checkout's script path and a tag such as `forward:slate:<id>:dest=<hash>`) and takes them back, even if the pidfiles are gone.

## Security notes

- MediaMTX binds `127.0.0.1` only (RTMP 19350, LL-HLS 18888, API 19997). Override with `RELAY_RTMP_PORT`, `RELAY_HLS_PORT`, `RELAY_API_PORT`, `RELAY_BIND`. Its users only accept connections from localhost, and WebRTC, RTSP, SRT, MoQ and playback are off.
- Keys never reach the client, logs, `/stream` or event.json. Forward logs pass through a redactor.
- **The forward's destination URL shows in `ps`.** ffmpeg takes an RTMP output URL only as a command-line argument. I tried `-/rtmp_playpath <file>` (ffmpeg 7's read-option-from-file syntax), but it does not apply to protocol options. MediaMTX's own `runOnReady` would also put it in a command line. Only users on the same machine can run `ps`; the direct Slate mode has always worked the same way. In Docker the process list is private to the container.
- The forward's input URL carries the local read password in `ps`. It only works from localhost.

## Docker (later cloud deploy)

Everything is under `STREAM_DATA_DIR` and configured through env, so one container runs the app, MediaMTX and ffmpeg:

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates perl procps && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm ci && npm run build && scripts/install-mediamtx.sh v1.21.2
ENV STREAM_DATA_DIR=/data MEDIAMTX_BIN=/app/bin/mediamtx BIND_HOST=0.0.0.0
VOLUME /data
CMD ["npm", "start"]
```

Only the app port has to be published. MediaMTX stays on the container's loopback.
