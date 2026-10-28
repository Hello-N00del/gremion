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
# credential: the file is 0600, gitignored, and never printed.
#
# Usage:  scripts/render-pgbouncer-userlist.sh [--root DIR]
# Reads DIR/.env (default: this checkout). Idempotent: rewritten atomically
# when the password changed, left alone otherwise.
# EXIT: 0 ok - 1 refused (missing/empty/CHANGE_ME password) - 2 usage.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --root) [[ $# -ge 2 ]] || { echo "render-pgbouncer-userlist: --root needs a value" >&2; exit 2; }
                ROOT="$(cd "$2" && pwd)"; shift 2 ;;
        *) echo "render-pgbouncer-userlist: unknown argument: $1" >&2; exit 2 ;;
    esac
done

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
mv -f "$tmp" "$OUT"
trap - EXIT
echo "render-pgbouncer-userlist: wrote $OUT (0600)"
