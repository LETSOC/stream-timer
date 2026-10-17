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

### Two OBS computers: main + backup

| | OBS computer 1 (main) | OBS computer 2 (backup) |
|---|---|---|
| URL | `http://127.0.0.1:43211/overlay/timecode?fps=30&beep=1` | `http://<Mac LAN IP>:43211/overlay/timecode/backup?fps=30&beep=1` (same as `?src=backup`) |
| Label | `OBS SRC`, white border | `BACKUP SRC`, amber border |
| Default position | bottom-right, 96 px | bottom-left, 96 px |
| Beep | 1.5 kHz, 3 kHz on the minute | 1.2 kHz, 2.4 kHz on the minute |

`?label=` sets a custom label (up to 16 characters), `?pos=` overrides the corner. Desk › A/V diagnostics lists both URLs with
Copy buttons (computer 2 uses this Mac's LAN IP; start the app with `BIND_HOST=0.0.0.0`).

**Both computers must have automatic time sync on** (macOS: System Settings › General › Date & Time › *Set time and date
automatically*; Windows: Settings › Time & language › *Set time automatically* + *Sync now*). Each badge shows its own
computer's clock, so any clock difference between the two OBS machines shows up as a fake delay. Check before a test:
both badges side by side should agree within a frame or two.

### TC1 audio marker (`?beep=1`)

`/overlay/timecode?fps=30&beep=1` adds a WebAudio beep exactly on each whole second of the same clock TC1 shows,
and flashes the OBS SRC badge white for 100 ms at the same instant (the frame where FF rolls to `00`).

- Beep: **1.5 kHz, 40 ms**; **3 kHz on the minute** (`:00`). Deliberately different from the /stream sync beep (1 kHz, 100 ms), so you can tell them apart by ear and on a waveform.
- `?beepEvery=1|5|10` seconds (default 1), `?vol=0..1` (default 0.5).
- Scheduled on the AudioContext clock with lookahead (anchored to `Date.now()` every 50 ms, beeps placed 400 ms ahead, output latency subtracted), so timer jitter never moves the beep.
- **OBS**: in the Browser Source properties tick **Control audio via OBS**, then route it to the program (Audio Mixer / Advanced Audio Properties: monitor off, track 1 on). OBS browser sources play audio without a click.
- **Normal browser**: autoplay is blocked until you click; the page shows *Click to enable audio (beep)*. Click anywhere once.

Example OBS URL: `http://127.0.0.1:43211/overlay/timecode?fps=30&beep=1&beepEvery=1&vol=0.5`

### Reading audio drift at the output

Record or screen-capture the output (YouTube, or the capture HLS) and step through frames with audio waveform visible:

- **OBS beep vs OBS SRC rollover** (badge flashes / FF = `00`): both made in OBS at the same instant, so any gap is the
  **source leg's A/V offset** (OBS → relay → /stream player → capture → platform carrying OBS's own audio and video).
  `audio offset ms` = beep onset − flash frame time (+ = audio late).
- **/stream sync beep vs sync flash** (desk › capture › A/V sync test): both made by our capture page, so their gap is
  **our pipeline's** A/V offset (capture → ffmpeg → relay → platform), independent of OBS.
- If the OBS pair is off but the /stream pair is fine, the drift is on the OBS/program-audio leg; if both are off by the same amount, it's after capture.

Type the measured number into Desk › A/V diagnostics › **Audio offset ms** when you press **Mark**; it is logged as
`audioOffsetMs` in `data/av-log.jsonl` and the CSV.

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
   adaptive program audio delay, auto + manual offsets, your reading and the optional **audio offset ms** to `data/av-log.jsonl`.
4. **Download CSV** and chart `readingMs` and `playerLatencyMs` over time. Flat = no drift; a steady slope = drift;
   steps = the adaptive delay re-locking (compare with `audioDelayMs`).

## TC4: phone vs OBS

Play the platform (YouTube) on a phone held next to the OBS monitor and photograph both in one shot (or film them at 60 fps).
OBS's live TC1 (on the monitor) − TC1 burned into the phone picture = full glass-to-glass delay (encode + relay + capture + platform).
Subtract the TC2 − TC1 reading to get the platform's share. Log it with **Mark** as a note, e.g. `TC4 phone +7.4s`.
Phone and Mac clocks don't matter here: both numbers are read from the same photo.

## Known issue: audio leads video on Backup (analysis, not fixed yet)

Seen in the drift log: on Backup the program audio delay reads exactly **5000 ms** while the /stream player latency is
~**6.2 s** (Main: delay ~3.1–3.7 s for ~3.1 s latency). In `scripts/capture-stream.mjs` the reader-path target is
`programTargetMs() = clamp(100, 5000, playerLatency + screencastLag − readerLag − arrivalExcess + trim + offset + videoDelay)`.
Whenever the Backup player sits more than ~5 s behind the live edge, the delay is **capped at 5000 ms**, so audio is played
early by (target − 5000) ms, and because that latency wanders (Backup jitter 47 ms, the hls.js player drifting up to
`liveMaxLatencyDurationCount` segments behind), the lead is not constant. The reader buffer limit (`targetMs + 1 s`) follows the same cap.
The "switch buffer 5 s" setting only times the Main↔Backup hand-over on /stream; it is not the cause.
