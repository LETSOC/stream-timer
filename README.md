# Hyphen Festival countdown

A 16:9 live countdown player for **Hyphen Festival 2026** (4 November 2026, 09:30 London / GMT) plus a working FFmpeg script for an RTMP hold stream.

## Why the original FFmpeg command failed

The crash was not Castr. FFmpeg never opened the RTMP output because the filtergraph was invalid:

```
[AVFilterGraph] No option name near '30'
```

Two separate bugs:

1. **Unescaped colon in `09:30`.**  
   `drawtext` options are separated by `:`. The subtitle `text='4 November 2026 • 09:30'` is parsed as an option named `30`. Escape it as `09\:30`.

2. **`t` is not Unix time.**  
   In `drawtext`, `t` is seconds since *this filter started* (0, 1, 2…).  
   `1762245000-t` does not count down to the event. Compute remaining seconds at launch:

   ```text
   remaining = TARGET_UNIX - now
   display   = remaining - t
   ```

The unix stamp `1762245000` is **4 November 2025, 09:30 CET**, not 2026. This project defaults to `1793784600` (4 November 2026, 09:30 GMT). That is the official `startDate` on the Hyphen event page (`2026-11-04T09:30:00+0000`).

If the Castr ingest URL and password were pasted into a terminal log or chat, rotate that stream password.

## Run the player

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:43211](http://127.0.0.1:43211). Port 43210 is left for the other local project.

| Route | Use |
| --- | --- |
| `/` | Operator desk. Edits save in this browser and sync to `/api/event` |
| `/stream` | Clean 16:9 OBS output. With no query string it follows the desk |
| `/api/event` | Saved event. `PUT` needs the encoder token |
| `/api/encoder` | Play, restart, or stop the FFmpeg slate. Mutations need the token |

OBS can use `http://127.0.0.1:43211/stream`. Copy OBS URL on the desk. A long param URL is still available when you need a fixed snapshot. The server binds to `127.0.0.1` by default (override with `BIND_HOST=0.0.0.0 npm run dev`). The `Host` header is never trusted: when `BIND_HOST` is not loopback, the token is not handed out and mutations need `ENCODER_ALLOW_REMOTE=1` plus a manually set `ENCODER_TOKEN`. The burned-in slate can restart every 10 minutes. A past start shows LIVE instead of zero boxes.

**Play encoded slate** on the desk runs `scripts/stream-countdown.sh --hls` and plays the H.264 picture in the page. That is the same filtergraph as the Castr command. The burned-in clock is the time left when ffmpeg starts. The browser preview keeps using the wall clock.

OBS: add a Browser Source pointing at `/stream` (optionally with `?name=…&date=2026-11-04&time=09:30&end=16:15&tz=Europe/London&venue=…`), 1280×720 or 1920×1080.

The 16:9 frame follows the Hyphen event hero: Arial/Helvetica title at the site h1 size, date / session / venue at h4, an RSVP button, a QR for the tickets URL, and the hyphen + Emerald lockup on the right. Replace `public/brand/hyphen-emerald.png` or `assets/logo-preview.png` and run `python3 scripts/generate-slate.py` (needs `pillow` and `qrcode`) to rebuild the FFmpeg still.

The player uses **this computer’s clock**. There is no separate “current time” to configure. On 8 October 2026 at 10:21 BST, 4 November 09:30 GMT is **27 days, 0 hours, ~9 minutes** away. The Zoho countdown on [events.hyphenonline.com](https://events.hyphenonline.com/HyphenFestival2026) often shows one fewer day with the same hours and minutes — that widget is a day short, it is not a clock-sync problem.

## FFmpeg hold stream

Do not put the ingest password in git. Export it in the shell:

```bash
export RTMP_URL='rtmp://uk.castr.io/static/YOUR_STREAM?password=YOUR_PASSWORD'
./scripts/stream-countdown.sh
```

Prove the filter parses *before* going live:

```bash
./scripts/stream-countdown.sh --file hyphen-countdown-test.mp4 --duration 6
```

On a Mac with `ffplay`:

```bash
./scripts/stream-countdown.sh --preview
```

Homebrew FFmpeg on macOS usually needs `fontfile`. The script looks for Arial, then DejaVu. Override with `FONTFILE=/path/to/Font.ttf`.

### Corrected drawtext (the part that was broken)

```text
text='4 November 2026  •  09\:30'
text='%{eif\:max(0\,trunc((REMAINING-t)/86400))\:d}d …'
```

`REMAINING` is `TARGET_UNIX - $(date +%s)` at process start, not the unix timestamp itself.

## Stream audio (Slate / Browser capture)

The desk's **Stream audio** card sets each RTMP channel's audio: **Silent** (default), **Tone** (sine, Hz + dBFS, e.g. 1 kHz −20 dBFS), or **Audio bed**. The bed is one or more uploaded MP3/M4A/WAV/AAC files (max 50 MB each, checked with ffprobe), played in order or shuffled, looped forever (`-re -stream_loop -1`), with a volume in dB and an optional fade-in. Output is always AAC 128k, 48 kHz stereo, resampled with `aresample=async` so it stays in sync with the realtime video.

Settings save on the server (`data/audio-settings.json`, files in `data/audio/`) and sync to every desk. Edits are a draft until **Save audio**. Saved changes apply **live** (within about a second, 300 ms crossfade; volume-only changes ramp over 200 ms): silence, tone, bed, playlist, volume and fade switch without restarting ffmpeg or reconnecting RTMP. How: `scripts/audio-feeder.mjs` makes the stream audio (raw PCM, wall-clock paced) and the encoder reads it as a never-ending input: the Slate gets it on fd 3 from a feeder process started next to its ffmpeg, Browser capture runs the feeder in-process and mixes OBS program audio on top. Beds are decoded by short-lived ffmpeg children, one per file; a missing or broken file plays silence until the next one instead of stalling the stream. The server writes `data/rtmp-audio-<channel>.live.json` on save; the feeder reports what is on air (mode, peak dBFS, underruns) in `…applied.json`, shown on the channel card ("Applied live" / "Applying…"). Only a channel started by an older build still shows "Restart to apply new audio"; restart it once. Shuffle reshuffles on every pass through the list.

## Phone Stream Deck (/deck)

Open `/deck` on a phone (same login as the desk; local mode on 127.0.0.1 needs none). Big buttons for
Transport: go live, pause/resume, reset clock, restore festival, jumps (15s/10m/30m/1h), countdown /
break / hold / welcome / end card, Rehearsal/Live. Go live, reset, restore and end card need a second tap.
It shows the current screen, mode, countdown, paused and test-clock state, and can preview `/stream`
(no view key needed: your session is enough) or the relay output.

`npm start` / `npm run dev` now run `server.ts`: Next plus a WebSocket at `/api/deck/ws` on the same port
(43211, `BIND_HOST` as before). Every save pushes state to all decks and desks instantly; the desk's 2s poll
and HTTP `POST /api/deck/action` stay as fallbacks if the socket is blocked. The socket needs a same-origin
`Origin` and an operator session (the encoder token is not accepted). `npm run start:next` / `dev:next`
run plain Next without the socket.

## OBS program feed (/program)

OBS (on this Mac) can send its program into the relay; Transport › **Show program (OBS)** (desk or
`/deck`) then puts it full-frame on `/stream`. Precedence on `/stream`: break/hold/welcome card >
program > end card > countdown (cards go on top of the program; Countdown / End card switch it off).

1. Desk › Relay › `/program · OBS feed` › **Arm receive** (starts MediaMTX if needed; it stays up while
   armed, independent of channels and forwards).
2. **Reveal OBS URL** (hides after 30s). In OBS › Settings › Stream: Service *Custom*, Server
   `rtmp://127.0.0.1:19350/`, Stream Key `program?user=obs_…&pass=…` (copy both). OBS › Output:
   keyframe interval **1 s**, x264/Apple VT H.264, AAC 48 kHz; tune zerolatency if offered.
3. Start Streaming in OBS. The card shows *Receiving* with codec, resolution, fps and bitrate; *Preview*
   plays it on the desk.
4. **Show program (OBS)**. `/stream` (OBS Browser Source or Browser capture) plays it via LL-HLS
   (~1.2 s behind OBS), with sound in OBS Browser Source; *Waiting for OBS* shows while nothing arrives.

- The OBS login is its own (publish to `/program` only, loopback only) and lives in
  `data/relay/credentials.json` (0600). **New key** issues a new one and disconnects OBS. **Disarm**
  removes the login, disconnects OBS and stops MediaMTX if nothing else uses it.
- Viewers get `/program` only through `/api/program/hls` with the view key (or the capture key);
  no relay URL or login reaches a browser. `/api/public/state` adds just `programReady`.
- **Browser capture audio**: headless Chromium's sound isn't captured, so while `/stream` shows the
  program the capture reads `/program`'s audio from the relay and mixes it in (delayed
  `CAPTURE_PROGRAM_AUDIO_DELAY_MS`, default 1170, to match the picture), fading the audio bed out
  under it and back afterwards.
- **Slate** (ffmpeg text) can't show the program; it keeps the countdown. Use Browser capture.
- OBS must run on the same machine (MediaMTX listens on 127.0.0.1 only).

### Program audio and previews

- **/stream (OBS Browser Source)** plays the program feed **with sound** by default. In the Browser Source properties tick **“Control audio via OBS”** so the sound shows up as its own source in the OBS audio mixer (meter, mute, volume, monitoring) instead of going straight to the desktop output. `?mute=1` mutes it (the deck preview uses that).
- **Switching** to program keeps the current screen (countdown or card) up until the feed has drawn a frame, then crossfades (300 ms). /stream preloads the feed whenever OBS is sending, so the switch is normally instant. “Waiting for OBS” only appears if no frame arrives within 5 s, OBS has been gone for more than 3 s, or the picture has stalled for more than 4 s (the last frame is held until then).
- **Desk hero preview, deck preview and the Relay card preview** play the feed over the operator-only HLS path, **muted by default**, with a mute/unmute toggle, volume and a live level meter. The choice is saved per device (and per place). Browsers only allow sound after a tap: if you left it unmuted, the first tap anywhere on the page turns it back on (the button shows “Tap for sound”). The meter reads the audio before the volume, so it moves while muted once sound has been enabled once. On iPhone Safari the meter may stay flat (WebKit limitation with native HLS); the sound still plays.
- **Relay card** shows “Audio present” (codec, channels, kHz) or “No audio track” from MediaMTX, plus whether Browser capture is mixing program audio and its peak level. The Encoder panel’s capture health line shows the same.

## Tests

```bash
npm test
npm run stream:test
```

`stream:test` encodes a short local MP4 with the same filtergraph the live command uses.

## Start automatically (macOS)

`deploy/com.letsoc.stream-timer.plist` is a LaunchAgent that runs `npm run start` at login and restarts it if it exits. Edit the paths at the top of the file, run `npm run build`, then:

```bash
cp deploy/com.letsoc.stream-timer.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.letsoc.stream-timer.plist
# stop: launchctl bootout gui/$(id -u)/com.letsoc.stream-timer
```

It brings the desk back after a reboot, not the RTMP stream: press Start stream again. On Linux use `deploy/stream-timer.service` (systemd) instead.

Encoder hardening: requests that arrive through a proxy or tunnel, or with a non-local `Host`/`Origin`, are never treated as local. Set `RTMP_ALLOWED_HOSTS=castr.io` to refuse any other ingest host. `data/rtmp.log` is owner-only (it holds the raw ingest URL) and is trimmed past 5 MB.

## Operator login and OBS view key

**Local (Mac, default):** `npm run dev` with no extra env runs in *local mode*: the desk at `http://127.0.0.1:43211` needs no login and OBS URLs work with or without a key, exactly as before.

**Password mode** turns on when `OPERATOR_PASSWORD_HASH` (or `OPERATOR_PASSWORD`) is set, when `AUTH_MODE=password`, or when `BIND_HOST` is not loopback (always the case in the cloud).

```bash
npm run hash-password            # prompts, prints OPERATOR_PASSWORD_HASH=scrypt$...
# put that line (and optionally SESSION_SECRET) in .env.local, or in your host's secrets
npm run dev
```

- The desk redirects to `/login`. Sessions are a signed, HttpOnly, SameSite=Lax cookie (12 h, refreshed while in use; Secure on https). **Log out** is in the header.
- 5 wrong passwords lock login for 30 s, doubling up to 15 min (in memory, per instance).
- All desk APIs need the session: `GET/PUT /api/event`, `GET/POST/DELETE /api/encoder`, `/api/view-key`. Scripts can still use `Authorization: Bearer $ENCODER_TOKEN` from the same machine (or anywhere with `ENCODER_ALLOW_REMOTE=1`). The token is no longer sent to browsers.

**OBS URLs** carry a read-only view key: `http://<host>/stream?k=<key>` and `http://<host>/end?k=<key>`. **Copy OBS URL** on the desk includes it. **Rotate view key** (in the preview's URL bar) makes old URLs stop working. The key is required in password mode, optional locally (`REQUIRE_VIEW_KEY=1` to require it). OBS pages read `GET /api/public/state`, which returns only the event, clock and stage, never tokens, RTMP details, logs or process ids.

Cloud hosting needs a long-running server with ffmpeg and a persistent `data/` volume (not serverless); see `AUTH_PLAN.md`.
