#!/usr/bin/env bash
# Keeps the RTMP stream up. Runs stream-countdown.sh and starts it again
# whenever ffmpeg exits (network drop, Castr reset, crash).
#
# - Every relaunch recomputes the remaining time, so the countdown stays right.
# - Waits 2s, then doubles up to 30s while ffmpeg keeps failing quickly. A run
#   that lasts 30s or more resets the wait.
# - Writes its state to $RTMP_STATE_FILE (JSON) so the desk can show
#   "Reconnecting" and the restart count.
# - Stop it by sending SIGTERM to its process group (the desk does this).
#
# Works with the Bash 3.2 that ships with macOS: no `set -u`, no empty arrays.

DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="${RTMP_STATE_FILE:-}"
MIN_DELAY=2
MAX_DELAY=30
STABLE_AFTER=30

restarts=0
fails=0
child=""

log() {
  printf '[supervisor %s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

write_state() {
  # $1 = running | waiting
  if [[ -n "$STATE_FILE" ]]; then
    printf '{"state":"%s","restarts":%s,"updatedAt":%s}\n' "$1" "$restarts" "$(date +%s)" > "$STATE_FILE.tmp" \
      && mv "$STATE_FILE.tmp" "$STATE_FILE"
  fi
}

stop() {
  log "stop requested"
  if [[ -n "$child" ]]; then
    kill "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  exit 0
}
trap stop TERM INT HUP

log "supervisor started (pid $$)"

while true; do
  started=$(date +%s)
  write_state running
  bash "$DIR/stream-countdown.sh" &
  child=$!
  wait "$child"
  code=$?
  child=""
  ran=$(( $(date +%s) - started ))

  if (( ran >= STABLE_AFTER )); then
    fails=1
  else
    fails=$(( fails + 1 ))
  fi
  delay=$MIN_DELAY
  i=1
  while (( i < fails && delay < MAX_DELAY )); do
    delay=$(( delay * 2 ))
    i=$(( i + 1 ))
  done
  if (( delay > MAX_DELAY )); then delay=$MAX_DELAY; fi

  restarts=$(( restarts + 1 ))
  write_state waiting
  log "ffmpeg exited (code $code) after ${ran}s; restart #$restarts in ${delay}s"

  sleep "$delay" &
  child=$!
  wait "$child"
  child=""
done
