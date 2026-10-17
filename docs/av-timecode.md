# A/V timecode drift test (TC1–TC4)

Diagnostics only. Nothing here changes capture, ffmpeg or the sync logic; it lets you **measure** the chain.
All timecodes are local wall-clock **HH:MM:SS:FF** (FF = frame within the second at the chosen fps), drawn from
the same Mac clock, so subtracting two readings gives the delay between those two points.

| | Where it is drawn | What it shows |
|---|---|---|
| **TC1 · OBS SRC** | OBS, burned into the program you send to the relay | the moment OBS rendered the frame |
| **TC2 · STREAM** | `/stream` (Browser capture page), next to the program | the moment capture rendered `/stream` |
| **TC3** | Desk › A/V diagnostics › MediaMTX | relay path ready / bytes / readers / tracks |
| **TC4** | your phone playing the platform (e.g. YouTube) | glass-to-glass platform delay |

In the final output (YouTube) you see both badges side by side, bottom-right:
`[ STREAM 14:02:11:07 ] [ OBS SRC 14:02:10:21 ]` → STREAM − OBS SRC = OBS → relay → /stream player delay (here ≈ 0.53 s at 30 fps).

## TC1: OBS SRC timecode in OBS

Recommended: our page as a Browser Source (frame-accurate, transparent, labelled).

1. OBS › Sources › **+ › Browser**, name it `TC1 OBS SRC`.
2. URL: `http://127.0.0.1:43211/overlay/timecode?fps=30` (use the Mac's LAN IP if OBS is on another machine; both clocks must then be NTP-synced).
3. **Width 1920, Height 1080**, no custom CSS. Untick *Shutdown source when not visible*.
4. Set `?fps=` to your OBS canvas fps: `25`, `30`, `50` or `60`.
5. Position: `?pos=bottom-right` (default). Keep bottom-right so it sits next to STREAM; other values: `bottom-left`, `top-left`, `top-right`.
6. Put it at the top of the scene so it is in every program frame. Add `&checker=1` only to preview it on a checkerboard.

The page needs no view key (it shows only the time of day).

Alternative without a browser: OBS **Text (FreeType 2/GDI+)** source driven by a clock script (Tools › Scripts, e.g. a
Lua clock script that sets the text to `os.date("%H:%M:%S")` plus a frame counter each tick). Scripts tick on OBS's
render loop but are only ms-accurate to the script's timer; prefer the Browser Source for frame accuracy.
Label it `OBS SRC` and place it bottom-right, 96 px in.

## TC2: STREAM timecode on /stream

Desk › **A/V diagnostics** › tick *Show STREAM timecode on /stream (TC2)* (synced to every /stream, default off), pick the same fps.
It is drawn just left of where TC1 lands (bottom, 96 px up, right edge 500 px in) so the two never overlap.
Turn it off after the test; it is a diagnostic badge and goes out on air while it is on.

## TC3: MediaMTX stats

Desk › A/V diagnostics › MediaMTX shows each relay path: ready, bytes in/out, readers, tracks (read-only, polled every second).
- Our relay runs MediaMTX with its API on `127.0.0.1:19997` (`RELAY_API_PORT`); start the relay and the table fills in.
- Another MediaMTX: set `api: yes` (and `apiAddress: :9997`) in its `mediamtx.yml`, then start the app with
  `MEDIAMTX_API_URL=http://127.0.0.1:9997`. "API off" means the API isn't reachable.

## The 3-minute drift test

1. Start OBS → relay → Program on /stream → Browser capture → YouTube. Turn TC2 on.
2. Desk › A/V diagnostics › **New test (archive log)**.
3. Every 30 s for 3 minutes: read both badges off the YouTube player (pause or screenshot), type **STREAM − OBS SRC in ms**
   (frames × 1000 / fps) into the box, optionally a note, press **Mark**. Each mark logs wall clock, /stream player latency,
   adaptive program audio delay, auto + manual offsets and your reading to `data/av-log.jsonl`.
4. **Download CSV** and chart `readingMs` and `playerLatencyMs` over time. Flat = no drift; a steady slope = drift;
   steps = the adaptive delay re-locking (compare with `audioDelayMs`).

## TC4: phone vs OBS

Play the platform (YouTube) on a phone held next to the OBS monitor and photograph both in one shot (or film them at 60 fps).
OBS's live TC1 (on the monitor) − TC1 burned into the phone picture = full glass-to-glass delay (encode + relay + capture + platform).
Subtract the TC2 − TC1 reading to get the platform's share. Log it with **Mark** as a note, e.g. `TC4 phone +7.4s`.
Phone and Mac clocks don't matter here: both numbers are read from the same photo.
