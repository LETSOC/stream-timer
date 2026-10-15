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

## Program backup input (/program-backup) and failover

Next to the OBS program feed (`/program`, "Main") the relay takes a second, **Backup** input on
`/program-backup`, on the same RTMP ingest port (default 19350). It is accepted while the program
feed is armed (Relay card › Arm receive) and has **its own publish key** (rotated together with the
OBS key by "New key"). Feed it in one of two ways:

- **A second computer / second OBS** publishes to it: Relay card › Reveal backup URL gives Server
  `rtmp://127.0.0.1:19350/` and Key `program-backup?user=bak_…&pass=…`. (The ingest binds to
  `127.0.0.1` like `/program`; for another machine use `BIND_HOST`/a tunnel, same as Main.)
- **Pull from URL**: paste an `rtmp://`, `rtsp://`, `srt://` or `https://…/index.m3u8` (HLS) URL and
  press Pull. MediaMTX keeps pulling it (`source:` with `sourceOnDemand: no`) so it is warm for an
  instant switch; the publish key is then not used. Only `scheme://host` is ever shown in status.

**Switching** (desk › Transport and phone /deck › Program source): **Main / Backup** with live status
of each input (publishing, bitrate, age of the last data MediaMTX received ≈ last frame age).
`/stream` prewarms both players whenever each is publishing; on a switch the input on air stays up
until the incoming one has rendered a frame, then it crossfades on top (4 s cap). The previews
(desk hero, deck) follow the active input with the usual sound toggle + level meter. Browser
capture's program audio follows the input on air (it reads `program-backup-read.url`, 0600, for
Backup) and the adaptive A/V-sync delay re-locks on the new player's latency.

**Auto-failover** (default off, saved in `data/relay/settings.json`): a server monitor checks both
inputs every 0.5 s. If Main is on air and has no new data for **N s** (default 3, 1–60) and Backup is
healthy, it switches to Backup. Then either it **returns to Main** once Main has been healthy for
**M s** (default 10, 2–600), or it **stays on Backup** (untick "return to Main"). Auto-return only
undoes its own failover; a manual "Backup" is never overridden. Every switch (auto or manual) is
logged (`[program] auto-failover …` in the server log), shown as "Last: …" under the switch, and
toasted on every desk and deck (synced over the deck WebSocket).

API (operator, same-origin POST `/api/relay`): `reveal-backup`, `backup-pull {url}` (`""` = publisher
again), `failover {failover: {auto, stallSec, returnSec, autoReturn}}`. The switch itself is the
transport action `{ type: "programSource", source: "main" | "backup" }` (deck WS / `/api/deck/action`).

### Second laptop on the LAN ("Accept program ingest from LAN")

By default the RTMP ingest listens on `127.0.0.1` only, so OBS on another computer can't connect.
Relay card › /program › tick **Accept program ingest from LAN** (saved, default off):

- MediaMTX's RTMP listener moves to `0.0.0.0:19350` (or `INGEST_HOST`, e.g. one interface's IP).
  LL-HLS (preview) and the API stay on `127.0.0.1`.
- Only the two OBS logins (`/program`, `/program-backup`) may connect from other addresses, and only
  to **publish** their own path. Reading, the API and the internal Slate/Capture publishers stay
  loopback-only, so nobody on the LAN can watch or take over a path. The keys are still required
  (rotate with **New key** if one leaks). The setting only applies while the program feed is armed.
- Turning it on or off restarts MediaMTX's RTMP listener: connected publishers drop for a moment (OBS reconnects by itself if "Automatically reconnect" is on, the default).
- The reveal panels then also show **LAN** `rtmp://<this Mac's LAN IP>:19350/` (private IPv4, en0
  first) with Copy. Use it as the second laptop's OBS Server.
- macOS: the first time, the firewall may ask whether **mediamtx** may accept incoming connections:
  click **Allow** (System Settings › Network › Firewall › Options if you missed it). Both laptops must
  be on the same network, and "client isolation" on guest Wi-Fi blocks this.

Second laptop OBS › Settings › Stream: Service **Custom…**, Server `rtmp://<LAN IP>:19350/`,
Stream Key `program-backup?user=bak_…&pass=…` (or the `/program` key to be Main). Settings › Output:
x264/hardware, CBR 3000–6000 kb/s, keyframe interval 1 s (LL-HLS wants short GOPs), AAC 48 kHz.

### When the LAN laptop can't (re)connect

- **Connection refused** = nothing listens on 19350: the relay server is stopped (Disarm, or a server
  crash). Desk "Stop all" no longer stops MediaMTX while the program input is armed.
- **Authentication failed** = wrong/old key. Each input has its own **New key**: Main's rotates Main
  only, Backup's rotates Backup only.
- A reconnecting OBS takes over its path at once (`overridePublisher: yes`), even if the dead session
  hasn't timed out.
- The LAN IP can change (DHCP, other Wi-Fi): compare OBS's Server with the LAN row in the panel.
- Relay card › /program shows **Ingest: listening on …** and the **last refused** publish from
  `data/relay/mediamtx.log` (the log restarts with MediaMTX).

### Bed / tone during the program

While the program (Main or Backup) is on air, Browser capture carries program audio only: the bed or
tone fades out once program audio first flows (3 s cap) and stays out through Main↔Backup switches,
reader restarts and underruns. It comes back only when /stream leaves the program for a card or the
countdown.

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

## LAN name (mDNS / Bonjour): `rtmp://hyphen-stream.local:19350/`

While **Accept program ingest from LAN** is on *and* the program input is armed, the app advertises
this Mac on the local network:

- an A record **`<name>.local` → current LAN IP** (default name `hyphen-stream`; rename it in the Relay
  card under the LAN checkbox, letters/digits/hyphens), and
- a Bonjour service **`_rtmp._tcp`** on the ingest port (19350), instance `<name>`, TXT `path=/program`.

The second laptop's OBS can then use **Server `rtmp://hyphen-stream.local:19350/`** (Stream key as
revealed) instead of an IP that changes with DHCP. The reveal panels show it as **LAN** with Copy, and
the IP as **LAN IP** as a fallback (use the IP if `.local` doesn't resolve on that network, e.g. some
guest Wi-Fi blocks multicast). The phone `/deck` shows both and a **QR code of the Server URL** for the
backup laptop (keys are never shown on the deck).

- **macOS** uses `dns-sd -P` (mDNSResponder owns port 5353 and handles probing). Other systems, or
  `MDNS_BACKEND=js`, use a built-in multicast-dns responder.
- The IP is re-checked every monitor tick; on a change the records are re-published and re-announced.
- It stops (goodbye packets) when LAN ingest is turned off, the program input is disarmed, or the
  server shuts down.
- **Name conflict:** before publishing, the app asks the LAN who has `<name>.local`. If another device
  answers, it does **not** advertise and the Relay card shows a red warning
  ("hyphen-stream.local is already used by 192.168.1.77"): pick another name (e.g. `hyphen-stream-2`).

Verify from the second laptop (macOS):

```sh
ping -c 3 hyphen-stream.local        # resolves to the stream Mac's LAN IP
dns-sd -B _rtmp._tcp                 # lists "hyphen-stream" (Ctrl-C to stop)
dns-sd -L hyphen-stream _rtmp._tcp   # → hyphen-stream.local.:19350
```
