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
