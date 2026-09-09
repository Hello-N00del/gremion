#!/usr/bin/env bash
# scripts/rotate-ipcrypt-key.sh
# Rotates the ipcrypt key used by the Vector log processing pipeline.
# Called as the final step of the daily backup chain (scripts/backup.sh).
# Rotation is independent of backup health — runs regardless of backup outcome.
set -euo pipefail

# #258-F5: the ipcrypt key + previous-key files are secret material under
# secrets/. With a default umask (022) `openssl rand > file` and `cp` create
# them 0644 (world-readable). Restrict every file this script creates to the
# owner by setting a restrictive umask up front.
umask 077

SECRETS_DIR="${SECRETS_DIR:-./secrets}"
KEY_FILE="$SECRETS_DIR/ipcrypt_key.txt"
PREV_KEY_FILE="$SECRETS_DIR/ipcrypt_key_prev.txt"
EPOCH_FILE="$SECRETS_DIR/ipcrypt_epoch.txt"

# Read current epoch (default 0)
current_epoch=$(cat "$EPOCH_FILE" 2>/dev/null || echo "0")
new_epoch=$((current_epoch + 1))

# Promote current key to previous
if [ -f "$KEY_FILE" ]; then
    cp "$KEY_FILE" "$PREV_KEY_FILE"
fi

# Generate new key
# NOTE: `>` truncates the EXISTING inode. That matters: compose bind-mounts this
# file into the Vector container as /run/secrets/ipcrypt_key, so an in-place
# rewrite is visible to the container. Never `mv` a new file over it.
openssl rand -hex 16 > "$KEY_FILE"
new_key=$(cat "$KEY_FILE")

# Increment epoch
echo "$new_epoch" > "$EPOCH_FILE"

# ---------------------------------------------------------------------------
# Propagate the new key to the running pipeline.
#
# The key is consumed by `ipcrypt`, which reads it from the IPCRYPT_KEY env var.
# docker/vector/entrypoint.sh exports that ONCE, from $IPCRYPT_KEY_FILE, at
# container start. There is no reload path:
#   * the previous `docker kill --signal=SIGHUP` was a NO-OP — entrypoint.sh is
#     PID 1, and the kernel does not deliver a default-disposition signal to
#     PID 1, so the container never even noticed it (verified: StartedAt and
#     RestartCount unchanged, same child PIDs, old key still in the processor's
#     environ);
#   * even a genuine Vector config reload would not touch process-logs.sh's
#     already-exported environment.
# Restarting the container is therefore the only propagation mechanism, and it
# is only worth anything if we ASSERT the post-condition afterwards.
# ---------------------------------------------------------------------------
rotation_propagated=0

if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker not available — cannot propagate the new ipcrypt key to the running Vector pipeline, and cannot establish that no pipeline is running." >&2
else
    # Prefer the compose lookup; fall back to a label filter so that running this
    # script from outside the compose project root cannot masquerade as
    # "container not running" (which would report success while the live pipeline
    # keeps using the old key).
    vector_container=$(docker compose ps -q vector 2>/dev/null || true)
    if [ -z "$vector_container" ]; then
        vector_container=$(docker ps -q \
            --filter "label=com.docker.compose.service=vector" 2>/dev/null | head -n1 || true)
    fi

    if [ -z "$vector_container" ]; then
        echo "Vector container not running — key written, will take effect on next start"
        rotation_propagated=1
    elif ! docker restart "$vector_container" >/dev/null 2>&1; then
        echo "ERROR: failed to restart Vector container $vector_container — the running pipeline is STILL using the OLD ipcrypt key." >&2
    else
        # Post-condition: the live log processor's IPCRYPT_KEY is the NEW key.
        # Read it back out of the container rather than trusting the restart.
        # (Never echo either key — this is secret material.)
        running_key=""
        attempt=0
        while [ "$attempt" -lt 30 ]; do
            running_key=$(docker exec "$vector_container" sh -c \
                'for f in /proc/[0-9]*/environ; do tr "\0" "\n" < "$f" 2>/dev/null | sed -n "s/^IPCRYPT_KEY=//p"; done | sort -u | head -n1' \
                2>/dev/null || true)
            [ -n "$running_key" ] && break
            attempt=$((attempt + 1))
            sleep 1
        done

        if [ -z "$running_key" ]; then
            echo "ERROR: could not read IPCRYPT_KEY back from the running Vector container ($vector_container) after restart — rotation NOT confirmed." >&2
        elif [ "$running_key" != "$new_key" ]; then
            echo "ERROR: Vector container $vector_container restarted but is still running on a DIFFERENT key than the one just written (check that secrets/ipcrypt_key.txt is bind-mounted and was rewritten in place, not replaced)." >&2
        else
            echo "Vector restarted and VERIFIED running on the new ipcrypt key (epoch $new_epoch)"
            rotation_propagated=1
        fi
    fi
fi

# Purge previous key if it is older than the access log retention window
ACCESS_RETENTION_DAYS="${LOG_ACCESS_RETENTION_DAYS:-14}"
if [ -f "$PREV_KEY_FILE" ]; then
    file_age_days=$(( ($(date +%s) - $(date -r "$PREV_KEY_FILE" +%s 2>/dev/null || date +%s)) / 86400 ))
    if [ "$file_age_days" -gt "$ACCESS_RETENTION_DAYS" ]; then
        rm -f "$PREV_KEY_FILE"
        echo "Previous key purged (age: ${file_age_days}d > retention: ${ACCESS_RETENTION_DAYS}d)"
    else
        echo "Previous key retained (age: ${file_age_days}d, retention: ${ACCESS_RETENTION_DAYS}d)"
    fi
fi

if [ "$rotation_propagated" -ne 1 ]; then
    echo "Key rotation INCOMPLETE: new key written to $KEY_FILE (epoch $new_epoch) but it was NOT confirmed to be in use by the running pipeline. Access logs are still being pseudonymised with the previous key." >&2
    exit 1
fi

echo "Key rotation complete. New epoch: $new_epoch"
