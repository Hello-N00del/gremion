#!/usr/bin/env bash
# ============================================================
# render-pgbouncer-userlist.sh -- write docker/pgbouncer/userlist.txt from
# .env's PGBOUNCER_AUTH_PASSWORD (bootstrap/dev twin of gremion-render's
# render_pgbouncer_userlist; same one-line format).
#
# pgbouncer.ini uses auth_type=scram-sha-256 + auth_query: every client role is
# verified against Postgres' own SCRAM verifier. The ONLY userlist entry is
# auth_user (pgbouncer_auth), whose plaintext password pgbouncer needs in order
# to LOG IN to Postgres and run auth_query -- a SCRAM verifier cannot be used
# for that outbound login in the pass-through role, so plaintext is the
# documented form (docker/pgbouncer/userlist.txt.example). It is therefore a
# credential: the file is gitignored, never printed, and 0600 by default.
#
# --container-group: the Linux-host form. The PgBouncer container runs as gid
# 70 (GREMION_PGBOUNCER_GID overrides) and bind-mounts the file read-only, so a
# 0600 file of the invoking user is unreadable to it (issue #83). With this
# flag the file is written 0640, handed to that gid (chgrp, then sudo -n
# chgrp) before it is published, and the run FAILS when the group cannot be
# set. Docker Desktop ignores bind-mount modes and needs no flag; a host that
# runs the prod overlay from a single checkout passes it (docs/runbooks/pgbouncer.md).
#
# Usage:  scripts/render-pgbouncer-userlist.sh [--root DIR] [--container-group]
# Reads DIR/.env (default: this checkout). Idempotent: rewritten atomically
# when the password changed, left alone otherwise.
# EXIT: 0 ok - 1 refused (missing/empty/CHANGE_ME password, group not set) - 2 usage.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_GROUP=0
GID="${GREMION_PGBOUNCER_GID:-70}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --root) [[ $# -ge 2 ]] || { echo "render-pgbouncer-userlist: --root needs a value" >&2; exit 2; }
                ROOT="$(cd "$2" && pwd)"; shift 2 ;;
        --container-group) CONTAINER_GROUP=1; shift ;;
        *) echo "render-pgbouncer-userlist: unknown argument: $1" >&2; exit 2 ;;
    esac
done
if [[ ! "$GID" =~ ^[0-9]+$ ]]; then
    echo "render-pgbouncer-userlist: GREMION_PGBOUNCER_GID must be a numeric gid, got: $GID" >&2
    exit 2
fi

ENV_FILE="$ROOT/.env"
DIR="$ROOT/docker/pgbouncer"
OUT="$DIR/userlist.txt"

[[ -f "$ENV_FILE" ]] || { echo "render-pgbouncer-userlist: no $ENV_FILE -- run: make setup" >&2; exit 1; }
[[ -d "$DIR" ]] || { echo "render-pgbouncer-userlist: no directory $DIR" >&2; exit 1; }

# Last assignment wins would hide a duplicate; take the first and refuse dups.
mapfile -t lines < <(grep -E '^PGBOUNCER_AUTH_PASSWORD=' "$ENV_FILE" || true)
if [[ ${#lines[@]} -ne 1 ]]; then
    echo "render-pgbouncer-userlist: PGBOUNCER_AUTH_PASSWORD must be set exactly once in $ENV_FILE (found ${#lines[@]})" >&2
    exit 1
fi
pw="${lines[0]#PGBOUNCER_AUTH_PASSWORD=}"
if [[ -z "$pw" ]]; then
    echo "render-pgbouncer-userlist: PGBOUNCER_AUTH_PASSWORD is empty in $ENV_FILE" >&2
    exit 1
fi
if [[ "$pw" == *CHANGE_ME_* ]]; then
    echo "render-pgbouncer-userlist: PGBOUNCER_AUTH_PASSWORD is still a CHANGE_ME_ placeholder -- run: make setup" >&2
    exit 1
fi
if [[ "$pw" == *'"'* || "$pw" == *$'\n'* ]]; then
    echo "render-pgbouncer-userlist: PGBOUNCER_AUTH_PASSWORD contains a character userlist.txt cannot carry (double quote)" >&2
    exit 1
fi

umask 077
tmp="$(mktemp "$DIR/.userlist.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
printf '"pgbouncer_auth" "%s"\n' "$pw" > "$tmp"
chmod 0600 "$tmp"
mode=0600
if [[ $CONTAINER_GROUP -eq 1 ]]; then
    # Hand the temp file to the group BEFORE it is published, so a failure
    # leaves the previous userlist as it was and nothing is ever readable by
    # the wrong group. chgrp directly first (a member of the group), then
    # through `sudo -n`.
    handed=0 e1="" e2=""
    if e1="$(chgrp -- "$GID" "$tmp" 2>&1)"; then
        handed=1
    elif ! command -v sudo >/dev/null 2>&1; then
        e2="sudo is not installed"
    elif e2="$(sudo -n chgrp -- "$GID" "$tmp" 2>&1)"; then
        handed=1
    fi
    if [[ $handed -ne 1 ]]; then
        echo "render-pgbouncer-userlist: cannot hand the userlist to group $GID (the PgBouncer container reads it as that gid): chgrp: ${e1//$'\n'/ }; sudo -n chgrp: ${e2//$'\n'/ }. Join group $GID, or use gremion-render on a host." >&2
        exit 1
    fi
    chmod 0640 "$tmp"
    seen="$(stat -c '%g %a' "$tmp")"
    if [[ "$seen" != "$GID 640" ]]; then
        echo "render-pgbouncer-userlist: temp file is '$seen', expected '$GID 640': not publishing it" >&2
        exit 1
    fi
    mode="0640 group $GID"
fi
mv -f "$tmp" "$OUT"
trap - EXIT
if [[ $CONTAINER_GROUP -eq 1 ]]; then
    echo "render-pgbouncer-userlist: wrote $OUT ($mode)"
else
    echo "render-pgbouncer-userlist: wrote $OUT ($mode; a Linux host that runs the prod overlay needs --container-group)"
fi
