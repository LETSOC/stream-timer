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

Open [http://127.0.0.1:43210](http://127.0.0.1:43210).

| Route | Use |
| --- | --- |
| `/` | Operator desk: edit title/time, preview the frame, play the encoded slate, copy FFmpeg commands |
| `/stream` | Clean 16:9 output for an OBS browser source |

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
