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

# Rotate the raw access.log + appended security.log on an interval. The COPYed
# /etc/logrotate.d/vector-logs is only a config file — logrotate must actually
# be RUN for rotation to happen. This loop is the running invoker; its `daily`
# directives gate on logrotate's own state file so re-running each interval is a
# no-op until a day has elapsed. Interval is overridable via LOGROTATE_INTERVAL.
# R28-VECTOR-RETENTION: logrotate never ages out the day-bucketed
# retained-YYYY-MM-DD.log files (maxage is only checked on a rotation that
# notifempty stops after the first one), so the same loop runs prune-retained.sh,
# which deletes them by the date in their name. A failure deletes nothing and is
# reported on stderr (container log) instead of being swallowed.
LOGROTATE_INTERVAL="${LOGROTATE_INTERVAL:-3600}"
while true; do
    logrotate /etc/logrotate.d/vector-logs || true
    /usr/local/bin/prune-retained.sh || echo "entrypoint.sh: prune-retained.sh failed; retained-*.log not pruned this interval" >&2
    sleep "$LOGROTATE_INTERVAL"
done &
LOGROTATE_PID=$!

# Exit if any supervised process dies
wait -n $PROCESSOR_PID $VECTOR_PID $LOGROTATE_PID
kill $PROCESSOR_PID $VECTOR_PID $LOGROTATE_PID 2>/dev/null || true
