#!/usr/bin/env bash
# Keeps one relay process up: the MediaMTX server, or one forward (ffmpeg -c copy from a
# relay path to a saved destination). Restarts it when it exits: 2s, doubling to 30s while it
# keeps failing fast; a run of 30s+ resets the wait.
#
# Usage: relay-loop.sh <tag> -- <command> [args...]
#   <tag> identifies the process for adoption after a server restart (e.g. "mediamtx",
#   "forward:slate:<destination id>:dest=<fingerprint>"). Never a key.
# Env: LOOP_STATE_FILE (JSON state for the desk), LOOP_REDACT=1 hides everything after the
# host in rtmp(s) URLs in the output (ffmpeg prints its output URL).
# Stop: SIGTERM the process group. Bash 3.2 compatible (macOS).

umask 077
TAG="$1"; shift
[[ "$1" == "--" ]] && shift
STATE_FILE="${LOOP_STATE_FILE:-}"
restarts=0     # every relaunch (includes quick retries, e.g. while the source is not publishing yet)
reconnects=0   # relaunches after a run that lasted 10s+ (a working connection dropped)
delay=2
child=""

write_state() {
  [[ -z "$STATE_FILE" ]] && return
  printf '{"tag":"%s","state":"%s","restarts":%s,"reconnects":%s,"lastExit":%s,"updatedAt":%s}\n' "$TAG" "$1" "$restarts" "$reconnects" "${2:-null}" "$(date +%s)" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}
stop() {
  echo "[relay-loop $(date '+%H:%M:%S')] stop requested"
  [[ -n "$child" ]] && kill "$child" 2>/dev/null
  pkill -TERM -P $$ 2>/dev/null
  wait 2>/dev/null
  exit 0
}
trap stop TERM INT HUP

echo "[relay-loop $(date '+%H:%M:%S')] started $TAG (pid $$)"
while true; do
  started=$(date +%s)
  write_state running
  if [[ "${LOOP_REDACT:-}" == "1" ]]; then
    "$@" 2>&1 < /dev/null | perl -pe 'BEGIN { $| = 1 } s#(rtmps?://[^/\s'"'"'"]+)/[^\s'"'"'"]*#$1/[redacted]#gi' &
  else
    "$@" 2>&1 < /dev/null &
  fi
  child=$!
  wait "$child"
  code=$?
  child=""
  ran=$(( $(date +%s) - started ))
  restarts=$(( restarts + 1 ))
  if (( ran >= 10 )); then reconnects=$(( reconnects + 1 )); fi
  if (( ran >= 30 )); then delay=2; fi
  echo "[relay-loop $(date '+%H:%M:%S')] exited (code $code after ${ran}s); restarting in ${delay}s"
  write_state waiting "$code"
  sleep "$delay" & wait $!
  (( delay = delay * 2 > 30 ? 30 : delay * 2 ))
done
