#!/usr/bin/env bash
# Generate a 1280x720 live countdown and send it to RTMP, a file, or ffplay.
# Fixes the two bugs in the original command:
#   1. Colons in drawtext (09:30) must be escaped as \: or FFmpeg reports
#      "No option name near '30'".
#   2. drawtext `t` is seconds since the filter started, not Unix time.
#      Remaining seconds are computed at launch: (TARGET_UNIX - now - t).

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  RTMP_URL='rtmp://…' ./scripts/stream-countdown.sh
  ./scripts/stream-countdown.sh --file hyphen-countdown-test.mp4 --duration 6
  ./scripts/stream-countdown.sh --hls data/hls
  ./scripts/stream-countdown.sh --preview

Environment:
  EVENT_NAME     Title burned into the frame (default: Hyphen Festival 2026)
  EVENT_LINE     Subtitle (default: 4 November 2026  •  09:30 GMT)
  TARGET_UNIX    Event start as a Unix timestamp (default: 1793784600 = 4 Nov 2026 09:30 GMT)
  RTMP_URL       Castr (or other) ingest URL, including password
  FONTFILE       Path to a .ttf/.otf font. Auto-detected on macOS and Linux.
EOF
}

MODE="rtmp"
OUTPUT_FILE=""
OUTPUT_DIR=""
DURATION=""
SIZE="1280x720"
FPS="30"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      MODE="file"
      OUTPUT_FILE="${2:?--file needs a path}"
      shift 2
      ;;
    --hls)
      MODE="hls"
      OUTPUT_DIR="${2:?--hls needs a directory}"
      shift 2
      ;;
    --preview)
      MODE="preview"
      shift
      ;;
    --duration)
      DURATION="${2:?--duration needs seconds}"
      shift 2
      ;;
    --size)
      SIZE="${2:?--size needs WIDTHxHEIGHT}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLATE="${SLATE:-$ROOT/assets/countdown-slate.png}"
LIVE_SLATE="${LIVE_SLATE:-$ROOT/assets/live-slate.png}"
SERIF_FONT="${SERIF_FONT:-$ROOT/assets/fonts/InstrumentSerif-Regular.ttf}"
MONO_FONT="${MONO_FONT:-$ROOT/assets/fonts/JetBrainsMono-Medium.ttf}"

EVENT_NAME="${EVENT_NAME:-Hyphen Festival 2026}"
EVENT_LINE="${EVENT_LINE:-4 November 2026  •  09:30 GMT}"
# 2026-11-04 09:30 GMT (London). The original command used 1762245000 (4 Nov 2025 CET).
TARGET_UNIX="${TARGET_UNIX:-1793784600}"

now="$(date +%s)"
remaining="$((TARGET_UNIX - now))"
if (( remaining < 0 )); then
  remaining=0
fi

escape_drawtext() {
  # FFmpeg filter parsing, not the shell, treats : as an option separator.
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//:/\\:}"
  text="${text//,/\\,}"
  text="${text//%/%%}"
  text="${text//\'/\\\'}"
  printf '%s' "$text"
}

EVENT_LINE_DISPLAY="$(printf '%s' "$EVENT_LINE" | tr '[:lower:]' '[:upper:]')"

if [[ ! -f "$SLATE" ]]; then
  echo "Missing slate image: $SLATE" >&2
  exit 1
fi
if [[ ! -f "$MONO_FONT" ]]; then
  echo "Missing bundled font: $MONO_FONT" >&2
  exit 1
fi

M="fontfile='${MONO_FONT}'"
# Number centres match scripts/generate-slate.py separate boxes (1280x720).
VF="drawtext=${M}:fontsize=49:fontcolor=white:borderw=1:bordercolor=white:x=124-text_w/2:y=528:text='%{eif\:max(0\,trunc((${remaining}-t)/86400))\:d}',drawtext=${M}:fontsize=49:fontcolor=white:borderw=1:bordercolor=white:x=236-text_w/2:y=528:text='%{eif\:trunc(mod(max(0\,${remaining}-t)/3600\,24))\:d\:2}',drawtext=${M}:fontsize=49:fontcolor=white:borderw=1:bordercolor=white:x=348-text_w/2:y=528:text='%{eif\:trunc(mod(max(0\,${remaining}-t)/60\,60))\:d\:2}',drawtext=${M}:fontsize=49:fontcolor=white:borderw=1:bordercolor=white:x=460-text_w/2:y=528:text='%{eif\:mod(max(0\,${remaining}-t)\,60)\:d\:2}'"

fingerprint() {
  # Short content hash + size, so the log proves exactly which image is on air.
  local sum
  if command -v shasum >/dev/null 2>&1; then
    sum="$(shasum -a 1 "$1" | cut -c1-12)"
  elif command -v sha1sum >/dev/null 2>&1; then
    sum="$(sha1sum "$1" | cut -c1-12)"
  else
    sum="n/a"
  fi
  printf 'sha1 %s, %s bytes' "$sum" "$(wc -c < "$1" | tr -d ' ')"
}

echo "Event:        $EVENT_NAME"
echo "Line:         $EVENT_LINE_DISPLAY"
echo "Target unix:  $TARGET_UNIX"
echo "Remaining:    ${remaining}s at launch (drawtext t=0)"
echo "Slate:        $SLATE ($(fingerprint "$SLATE"))"
if [[ -f "$LIVE_SLATE" ]]; then
  echo "Live slate:   $LIVE_SLATE ($(fingerprint "$LIVE_SLATE"))"
else
  echo "Live slate:   none (plain countdown continues after zero)"
fi
echo "Mode:         $MODE"

# Stream audio (lib/audio-bed.ts writes $AUDIO_ARGS_FILE: one ffmpeg arg per line, plus
# "@requires <file>" and "@filter <audio filter>" lines). Any required file missing → silence.
audio_in=(-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=48000")
audio_af="aresample=48000:async=1000:first_pts=0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
if [[ -n "${AUDIO_ARGS_FILE:-}" && -f "${AUDIO_ARGS_FILE:-}" ]]; then
  audio_ok=1
  audio_tmp=()
  audio_tmp_af=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "@requires "*) [[ -f "${line#@requires }" ]] || audio_ok=0 ;;
      "@filter "*) audio_tmp_af="${line#@filter }" ;;
      "") ;;
      *) audio_tmp+=("$line") ;;
    esac
  done < "$AUDIO_ARGS_FILE"
  if (( audio_ok )) && (( ${#audio_tmp[@]} > 0 )); then
    audio_in=("${audio_tmp[@]}")
    [[ -n "$audio_tmp_af" ]] && audio_af="$audio_tmp_af"
  else
    echo "[audio] audio bed file missing; streaming silence"
  fi
fi
# Live audio (hot-swappable): scripts/audio-feeder.mjs writes wall-clock-paced PCM that ffmpeg reads
# on fd 3, so the desk can change silence/tone/bed/volume while live (no ffmpeg/RTMP restart).
AUDIO_FEED=0
if [[ -n "${AUDIO_LIVE_FILE:-}" && -n "${NODE_BIN:-}" && -x "${NODE_BIN:-}" && -f "$ROOT/scripts/audio-feeder.mjs" ]]; then
  AUDIO_FEED=1
  audio_in=(-thread_queue_size 4096 -f s16le -ar 48000 -ac 2 -i pipe:3)
  audio_af="aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
  echo "Audio:        live feeder (changes apply without a restart)"
else
  echo "Audio:        ${audio_in[*]: -1}"
fi

if [[ -f "$LIVE_SLATE" ]]; then
  common_input=(
    -hide_banner
    -loglevel info
    -stats_period 5
    -re
    -loop 1 -framerate "$FPS" -i "$SLATE"
    "${audio_in[@]}"
    -loop 1 -framerate "$FPS" -i "$LIVE_SLATE"
    -filter_complex "[0:v]${VF}[counted];[counted][2:v]overlay=enable='gte(t,${remaining})'[v]"
    -map "[v]"
    -map 1:a:0
    -c:v libx264 -preset veryfast -b:v 2500k -maxrate 2500k -bufsize 5000k -nal-hrd cbr
    -g $((FPS * 2)) -keyint_min $((FPS * 2)) -sc_threshold 0 -pix_fmt yuv420p
    -af "$audio_af"
    -c:a aac -b:a 128k -ar 48000 -ac 2
  )
else
  common_input=(
    -hide_banner
    -loglevel info
    -stats_period 5
    -re
    -loop 1 -framerate "$FPS" -i "$SLATE"
    "${audio_in[@]}"
    -vf "$VF"
    -map 0:v:0
    -map 1:a:0
    -c:v libx264 -preset veryfast -b:v 2500k -maxrate 2500k -bufsize 5000k -nal-hrd cbr
    -g $((FPS * 2)) -keyint_min $((FPS * 2)) -sc_threshold 0 -pix_fmt yuv420p
    -af "$audio_af"
    -c:a aac -b:a 128k -ar 48000 -ac 2
  )
fi

# macOS ships Bash 3.2; `set -u` plus an empty "${array[@]}" is an unbound variable.
DURATION_SECS=""
if [[ -n "$DURATION" ]]; then
  DURATION_SECS="$DURATION"
elif [[ "$MODE" == "file" ]]; then
  DURATION_SECS="6"
fi

ffmpeg_audio() {
  if (( AUDIO_FEED )); then
    # The feeder never sees the ingest URL or tokens; it exits when ffmpeg closes the pipe.
    ffmpeg "$@" 3< <(exec env -u RTMP_URL -u ENCODER_TOKEN "$NODE_BIN" "$ROOT/scripts/audio-feeder.mjs")
  else
    ffmpeg "$@"
  fi
}

run_ffmpeg() {
  if [[ -n "$DURATION_SECS" ]]; then
    ffmpeg_audio "${common_input[@]}" -t "$DURATION_SECS" "$@"
  else
    ffmpeg_audio "${common_input[@]}" "$@"
  fi
}

case "$MODE" in
  file)
    run_ffmpeg -movflags +faststart -f mp4 "$OUTPUT_FILE"
    echo "Wrote $OUTPUT_FILE"
    ;;
  preview)
    if ! command -v ffplay >/dev/null 2>&1; then
      echo "ffplay is not installed. Use --file instead." >&2
      exit 1
    fi
    run_ffmpeg -f flv - | ffplay -autoexit -loglevel warning -
    ;;
  rtmp)
    if [[ -z "${RTMP_URL:-}" ]]; then
      echo "Set RTMP_URL to your Castr ingest URL, or use --file / --preview." >&2
      usage >&2
      exit 1
    fi
    if [[ ! "$RTMP_URL" =~ ^rtmps?://[^[:space:]]+$ ]]; then
      echo "RTMP_URL must start with rtmp:// or rtmps:// and contain no spaces." >&2
      exit 1
    fi
    # -rw_timeout: abandon a stalled connection after 10s so the supervisor can reconnect.
    run_ffmpeg -rw_timeout 10000000 -f flv "$RTMP_URL"
    ;;
  hls)
    mkdir -p "$OUTPUT_DIR"
    OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
    rm -f "$OUTPUT_DIR"/seg-*.ts "$OUTPUT_DIR"/stream.m3u8
    run_ffmpeg \
      -fps_mode cfr \
      -f hls \
      -hls_time 2 \
      -hls_list_size 6 \
      -hls_flags delete_segments+independent_segments+omit_endlist+temp_file \
      -hls_segment_filename "$OUTPUT_DIR/seg-%05d.ts" \
      "$OUTPUT_DIR/stream.m3u8"
    ;;
esac
