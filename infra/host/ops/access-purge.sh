#!/usr/bin/env bash
# The scheduled purge of the vendor/operator access record (TRD-092 / TRD-191,
# RC-LOG-AUD). Runs from gremion-access-purge.timer (daily) as the deploy user,
# on the HOST, like footprint.sh: `docker exec` into the state Postgres, over its
# local socket, as the executor role (lib/executor/db.sh, the same connection
# lib/access-log.sh writes the record through).
#
#   SELECT oac.purge_access_records(interval '27 days');
#
# The window is a constant, NOT a knob: the access record is kept at least as
# long as the security-log window (RC-LOG-SEC, 27 d configured, 30 d cap) and
# never shorter, so no environment variable can narrow it. The function itself
# refuses a window outside 27..30 days and any caller that is not the executor;
# it removes rows older than the window and nothing else (the table is
# append-only for every other purpose).
#
# stdout: one line, `access-purge: removed=<n> window=27d`.
# exit 0 purged (n may be 0)
#      1 the database did not answer, refused, or returned something that is not a count
#      2 missing tool
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=../lib/customer-ops.sh
. "$SCRIPT_DIR/../lib/customer-ops.sh"
# shellcheck source=../lib/executor/db.sh
. "$SCRIPT_DIR/../lib/executor/db.sh"

need_cmd docker grep head
setup_paths

readonly ACCESS_PURGE_WINDOW_DAYS=27

out="$(executor_sql "SELECT oac.purge_access_records(interval '${ACCESS_PURGE_WINDOW_DAYS} days');")" \
    || die "oac.purge_access_records failed (the state database is down, or it refused the purge)" 1
out="$(printf '%s' "$out" | head -n 1 | tr -d '[:space:]')"
[[ "$out" =~ ^[0-9]+$ ]] || die "oac.purge_access_records returned '${out}', not a row count" 1

printf 'access-purge: removed=%s window=%sd\n' "$out" "$ACCESS_PURGE_WINDOW_DAYS"
