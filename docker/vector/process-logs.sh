#!/bin/bash
# process-logs.sh — runs in background inside the Vector container.
# Reads raw Traefik JSON access log line by line.
# Security paths: pseudonymise ClientHost via ipcrypt-nd, write to processed log.
# All other paths: drop (never written anywhere).
set -euo pipefail

RAW_LOG="${RAW_LOG_PATH:-/logs/traefik/access.log}"
PROCESSED_LOG="${PROCESSED_LOG_PATH:-/logs/processed/security.log}"
# key_epoch tracks which rotation cycle produced this entry for future audit
KEY_EPOCH="${IPCRYPT_KEY_EPOCH:-0}"

SECURITY_PATTERN='^(/auth|/realms|/api|/admin)'

# Preflight. Every jq/ipcrypt invocation below is deliberately guarded by
# `|| continue` so one malformed line can never take the loop down — which also
# means a MISSING tool degrades to "drop every line, forever, in silence".
# Fail loudly at startup instead: entrypoint.sh supervises this process and
# exits the container with it, so the breakage is visible immediately.
for _tool in jq ipcrypt; do
    if ! command -v "$_tool" >/dev/null 2>&1; then
        echo "process-logs.sh: FATAL: required tool '$_tool' not found in PATH." >&2
        echo "process-logs.sh: refusing to run — log pseudonymisation would silently drop every line." >&2
        exit 1
    fi
done

mkdir -p "$(dirname "$PROCESSED_LOG")"

# Wait for the raw log file to appear (Traefik may not have written it yet)
until [ -f "$RAW_LOG" ]; do sleep 2; done

tail -F "$RAW_LOG" | while IFS= read -r line; do
    # Extract request path — skip lines that aren't valid JSON
    request_path=$(echo "$line" | jq -r '.RequestPath // empty' 2>/dev/null) || continue
    [ -z "$request_path" ] && continue

    # Only process security-relevant paths
    if ! echo "$request_path" | grep -qE "$SECURITY_PATTERN"; then
        continue
    fi

    # Extract and pseudonymise the client IP
    client_ip=$(echo "$line" | jq -r '.ClientHost // empty' 2>/dev/null) || continue
    [ -z "$client_ip" ] && continue

    pseudo_ip=$(printf '%s\n' "$client_ip" | ipcrypt nd-encrypt 2>/dev/null) || {
        # If ipcrypt fails, drop the line — never write raw IP
        continue
    }

    # Write the processed line with pseudonymised IP and key_epoch metadata.
    # #258-F2: Traefik logs the FULL RequestPath including the query string
    # (defaultMode: keep), so OIDC authorization codes (/auth/callback/...?code=),
    # Keycloak session_codes (/auth/realms/.../authenticate?session_code=) and
    # newsletter unsubscribe tokens (/api/newsletter/unsubscribe?token=) would
    # otherwise be persisted verbatim into security.log. Strip everything from
    # the first '?' onward (replacing it with '?<redacted>' so the presence of a
    # query is still visible) before writing. The path itself is retained.
    echo "$line" \
        | jq --arg pip "$pseudo_ip" --arg epoch "$KEY_EPOCH" \
             '.ClientHost = $pip
              | .key_epoch = ($epoch | tonumber)
              | if (.RequestPath | type) == "string" and (.RequestPath | test("[?]"))
                then .RequestPath |= sub("[?].*$"; "?<redacted>")
                else . end' \
        >> "$PROCESSED_LOG"
done
