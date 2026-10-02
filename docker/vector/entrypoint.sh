#!/bin/bash
set -e

# Load ipcrypt key from file if IPCRYPT_KEY_FILE is set (Docker secret)
if [ -n "${IPCRYPT_KEY_FILE:-}" ] && [ -f "$IPCRYPT_KEY_FILE" ]; then
    export IPCRYPT_KEY=$(cat "$IPCRYPT_KEY_FILE")
fi

# Start the ipcrypt log processor in the background
/usr/local/bin/process-logs.sh &
PROCESSOR_PID=$!

# Start Vector
exec vector --config /etc/vector/vector.toml &
VECTOR_PID=$!

# Rotate the raw access.log + Traefik's own log + appended security.log on an
# interval. The COPYed /etc/logrotate.d/vector-logs is only a config file —
# logrotate must actually be RUN for rotation to happen. This loop is the running
# invoker; its `daily` directives gate on logrotate's own state file so re-running
# each interval is a no-op until a day has elapsed.
# R28-VECTOR-RETENTION: logrotate never ages out the day-bucketed
# retained-YYYY-MM-DD.log files (maxage is only checked on a rotation that
# notifempty stops after the first one), so the same loop runs prune-retained.sh,
# which deletes them by the date in their name. A failure deletes nothing and is
# reported on stderr (container log) instead of being swallowed.
# R29-RETENTION-30: the 30-day bound (test-edge-retention-bound.sh) assumes the
# loop runs at least hourly, so LOGROTATE_INTERVAL is clamped to 60..3600 s: a
# longer value would stretch every family's worst case by the difference.
# BEGIN interval
LOGROTATE_INTERVAL="${LOGROTATE_INTERVAL:-3600}"
case "$LOGROTATE_INTERVAL" in
    '' | *[!0-9]*) interval_ok=0 ;;
    *) if [ "$LOGROTATE_INTERVAL" -ge 60 ] 2>/dev/null && [ "$LOGROTATE_INTERVAL" -le 3600 ] 2>/dev/null; then interval_ok=1; else interval_ok=0; fi ;;
esac
if [ "$interval_ok" -ne 1 ]; then
    echo "entrypoint.sh: LOGROTATE_INTERVAL must be an integer 60..3600 (seconds); using 3600" >&2
    LOGROTATE_INTERVAL=3600
fi
# END interval
while true; do
    # The state file lives on the processed-logs volume: in the container
    # filesystem (logrotate's default) it was lost on every re-create, restarting
    # each live file's first-sighting day. It does not match prune-retained.sh's
    # retained-* glob. A failure is reported like the prune's, never swallowed.
    # BEGIN rotate-step
    logrotate -s /logs/processed/.logrotate.status /etc/logrotate.d/vector-logs || echo "entrypoint.sh: logrotate failed; logs not rotated this interval" >&2
    /usr/local/bin/prune-retained.sh || echo "entrypoint.sh: prune-retained.sh failed; retained-*.log not pruned this interval" >&2
    # END rotate-step
    sleep "$LOGROTATE_INTERVAL"
done &
LOGROTATE_PID=$!

# Exit if any supervised process dies
wait -n $PROCESSOR_PID $VECTOR_PID $LOGROTATE_PID
kill $PROCESSOR_PID $VECTOR_PID $LOGROTATE_PID 2>/dev/null || true
