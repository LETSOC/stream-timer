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
# Number centres match scripts/generate-slate.py COUNT_* box (1280x720).
VF="drawtext=${M}:fontsize=32:fontcolor=white:x=126.5-text_w/2:y=550:text='%{eif\:max(0\,trunc((${remaining}-t)/86400))\:d}',drawtext=${M}:fontsize=32:fontcolor=white:x=235.5-text_w/2:y=550:text='%{eif\:trunc(mod(max(0\,${remaining}-t)/3600\,24))\:d\:2}',drawtext=${M}:fontsize=32:fontcolor=white:x=344.5-text_w/2:y=550:text='%{eif\:trunc(mod(max(0\,${remaining}-t)/60\,60))\:d\:2}',drawtext=${M}:fontsize=32:fontcolor=white:x=453.5-text_w/2:y=550:text='%{eif\:mod(max(0\,${remaining}-t)\,60)\:d\:2}'"

echo "Event:        $EVENT_NAME"
echo "Line:         $EVENT_LINE_DISPLAY"
echo "Target unix:  $TARGET_UNIX"
echo "Remaining:    ${remaining}s at launch (drawtext t=0)"
echo "Slate:        $SLATE"
echo "Mode:         $MODE"

common_input=(
  -hide_banner
  -loglevel info
  -re
  -loop 1 -framerate "$FPS" -i "$SLATE"
  -f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100"
  -vf "$VF"
  -map 0:v:0
  -map 1:a:0
  -c:v libx264 -preset veryfast -b:v 2500k -maxrate 2500k -bufsize 5000k
  -g 60 -pix_fmt yuv420p
  -c:a aac -b:a 128k -ar 44100
)

# macOS ships Bash 3.2; `set -u` plus an empty "${array[@]}" is an unbound variable.
DURATION_SECS=""
if [[ -n "$DURATION" ]]; then
  DURATION_SECS="$DURATION"
elif [[ "$MODE" == "file" ]]; then
  DURATION_SECS="6"
fi

run_ffmpeg() {
  if [[ -n "$DURATION_SECS" ]]; then
    ffmpeg "${common_input[@]}" -t "$DURATION_SECS" "$@"
  else
    ffmpeg "${common_input[@]}" "$@"
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
    run_ffmpeg -f flv "$RTMP_URL"
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
