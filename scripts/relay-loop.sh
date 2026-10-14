#!/usr/bin/env bash
# Keeps one relay process up: the MediaMTX server, or one forward (ffmpeg -c copy from a
# relay path to a saved destination). Restarts it when it exits: 2s, doubling to LOOP_MAX_DELAY
# (default 30s; forwards use 5s) while it keeps failing fast; a run of 30s+ resets the wait.
#
# Usage: relay-loop.sh <tag> -- <command> [args...]
#   <tag> identifies the process for adoption after a server restart (e.g. "mediamtx",
#   "forward:slate:<destination id>:dest=<fingerprint>"). Never a key.
# Env: LOOP_STATE_FILE (JSON state for the desk), LOOP_REDACT=1 hides everything after the
# host in rtmp(s) URLs in the output (ffmpeg prints its output URL).
#      LOOP_WATCH_LOG=<log> (forwards): stall watchdog. ffmpeg's -progress output in that log must
#      show total_size growing; if it doesn't for LOOP_STALL_SECS (25) after LOOP_STALL_GRACE (30)
#      the child is killed and restarted (e.g. a Castr connection that hangs without ffmpeg exiting).
# Stop: SIGTERM the process group. Bash 3.2 compatible (macOS).

umask 077
TAG="$1"; shift
[[ "$1" == "--" ]] && shift
STATE_FILE="${LOOP_STATE_FILE:-}"
restarts=0     # every relaunch (includes quick retries, e.g. while the source is not publishing yet)
reconnects=0   # relaunches after a run that lasted 10s+ (a working connection dropped)
delay=2
MAX_DELAY="${LOOP_MAX_DELAY:-30}"
(( delay > MAX_DELAY )) && delay=$MAX_DELAY
child=""
watcher=""

stop_watcher() {
  [[ -n "$watcher" ]] && kill "$watcher" 2>/dev/null
  watcher=""
}

# Stall watchdog: bytes sent (total_size= in -progress blocks) must keep growing.
watch_progress() {
  local pid=$1 limit="${LOOP_STALL_SECS:-25}" last="" since now cur
  sleep "${LOOP_STALL_GRACE:-30}"
  since=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    cur=$(tail -c 4096 "$LOOP_WATCH_LOG" 2>/dev/null | grep -a 'total_size=' | tail -n 1)
    now=$(date +%s)
    if [[ -n "$cur" && "$cur" != "$last" ]]; then
      last="$cur"; since=$now
    elif (( now - since > limit )); then
      echo "[relay-loop $(date '+%H:%M:%S')] no data sent for $(( now - since ))s (stalled); killing to reconnect"
      kill "$pid" 2>/dev/null
      sleep 3
      kill -9 "$pid" 2>/dev/null
      return
    fi
    sleep 5
  done
}

write_state() {
  [[ -z "$STATE_FILE" ]] && return
  printf '{"tag":"%s","state":"%s","restarts":%s,"reconnects":%s,"lastExit":%s,"updatedAt":%s}\n' "$TAG" "$1" "$restarts" "$reconnects" "${2:-null}" "$(date +%s)" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}
stop() {
  echo "[relay-loop $(date '+%H:%M:%S')] stop requested"
  stop_watcher
  [[ -n "$child" ]] && kill "$child" 2>/dev/null
  pkill -TERM -P $$ 2>/dev/null
  wait 2>/dev/null
  exit 0
}
trap stop TERM INT HUP

echo "[relay-loop $(date '+%H:%M:%S')] started $TAG (pid $$, max retry wait ${MAX_DELAY}s)"
while true; do
  started=$(date +%s)
  write_state running
  if [[ "${LOOP_REDACT:-}" == "1" ]]; then
    # Process substitution (not a pipe) so $! is ffmpeg itself: wait gets ffmpeg's exit code and
    # the watchdog/stop kill ffmpeg, not the redaction filter.
    "$@" < /dev/null > >(perl -pe 'BEGIN { $| = 1 } s#(rtmps?://[^/\s'"'"'"]+)/[^\s'"'"'"]*#$1/[redacted]#gi') 2>&1 &
  else
    "$@" 2>&1 < /dev/null &
  fi
  child=$!
  if [[ -n "${LOOP_WATCH_LOG:-}" ]]; then
    watch_progress "$child" &
    watcher=$!
  fi
  wait "$child"
  code=$?
  child=""
  stop_watcher
  ran=$(( $(date +%s) - started ))
  restarts=$(( restarts + 1 ))
  if (( ran >= 10 )); then reconnects=$(( reconnects + 1 )); fi
  if (( ran >= 30 )); then delay=$(( MAX_DELAY < 2 ? MAX_DELAY : 2 )); fi
  echo "[relay-loop $(date '+%H:%M:%S')] exited (code $code after ${ran}s); restarting in ${delay}s"
  write_state waiting "$code"
  sleep "$delay" & wait $!
  if (( delay * 2 > MAX_DELAY )); then delay=$MAX_DELAY; else delay=$(( delay * 2 )); fi
done
