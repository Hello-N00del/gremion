#!/usr/bin/env bash
# Feed node-exporter's textfile collector with the three facts no exporter
# knows: when the last backup succeeded, which containers Docker reports
# unhealthy, and how close Postgres is to max_connections. Runs on the HOST
# (gremion-metrics.timer, every minute), never in a container — this way no
# second container needs the Docker socket.
#
# Every metric here is ABSENT rather than zero when it cannot be measured. The
# matching alert rules carry an absent() clause, so a collector that has gone
# blind fires instead of reporting a comfortable 0.
#
# exit 0 wrote the file · 2 missing runtime directory or tool
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"

need_cmd docker jq date mktemp

ROOT="$(gremion_root)"
RUNTIME="$ROOT/runtime"
OUT_DIR="$RUNTIME/textfile"
STACK_NAME="${STACK:-gremion}"

[[ -d "$RUNTIME" ]] || die "runtime directory absent: $RUNTIME" 2
mkdir -p "$OUT_DIR"

# Diagnostics go to stderr: stdout is the metrics stream.
note() { echo "[metrics] $*" >&2; }

to_epoch() {
    local ts="$1"
    if [[ "$ts" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$ts"
    else
        date -u -d "$ts" +%s
    fi
}

emit_backup_age() {
    local file="$RUNTIME/last-backup.json" ok_flag ts epoch
    [[ -f "$file" ]] || { note "no last-backup.json yet — BackupOlderThan26h fires by absence"; return 0; }
    ok_flag="$(jq -r '.ok // false' "$file" 2>/dev/null || echo false)"
    [[ "$ok_flag" == "true" ]] || { note "last backup reports ok=$ok_flag — emitting no success timestamp"; return 0; }
    ts="$(jq -r '.ts // empty' "$file")"
    [[ -n "$ts" ]] || { note "last-backup.json has no ts"; return 0; }
    epoch="$(to_epoch "$ts")" || { note "unparseable ts '$ts'"; return 0; }
    printf '# HELP gremion_backup_last_success_timestamp_seconds Unix time of the last successful gremion-backup run.\n'
    printf '# TYPE gremion_backup_last_success_timestamp_seconds gauge\n'
    printf 'gremion_backup_last_success_timestamp_seconds %s\n' "$epoch"
}

emit_container_health() {
    local name status value
    printf '# HELP gremion_container_unhealthy 1 when Docker reports the container unhealthy.\n'
    printf '# TYPE gremion_container_unhealthy gauge\n'
    while IFS=$'\t' read -r name status; do
        [[ -n "$name" ]] || continue
        if [[ "$status" == *"(unhealthy)"* ]]; then value=1; else value=0; fi
        printf 'gremion_container_unhealthy{name="%s"} %s\n' "$name" "$value"
    done < <(docker ps --all --filter "label=com.docker.compose.project" --format '{{.Names}}\t{{.Status}}')
}

emit_postgres_connections() {
    local cid row used max
    cid="$(docker ps --filter "label=com.docker.compose.project=${STACK_NAME}-state" \
                     --filter "label=com.docker.compose.service=postgres" \
                     --format '{{.ID}}' | head -n 1)"
    [[ -n "$cid" ]] || { note "no ${STACK_NAME}-state postgres container — PostgresConnections80pct fires by absence"; return 0; }
    row="$(docker exec "$cid" psql -U postgres -tAF'|' -c \
        "SELECT (SELECT count(*) FROM pg_stat_activity), (SELECT setting::int FROM pg_settings WHERE name='max_connections')" \
        2>/dev/null || true)"
    row="$(printf '%s' "$row" | tr -d '[:space:]')"
    used="${row%%|*}"
    max="${row##*|}"
    if ! [[ "$used" =~ ^[0-9]+$ && "$max" =~ ^[0-9]+$ && "$max" != "0" ]]; then
        note "postgres query returned '$row' — emitting nothing"
        return 0
    fi
    printf '# HELP gremion_postgres_connections_used Backends currently connected to the state Postgres.\n'
    printf '# TYPE gremion_postgres_connections_used gauge\n'
    printf 'gremion_postgres_connections_used %s\n' "$used"
    printf '# HELP gremion_postgres_connections_max The server max_connections setting.\n'
    printf '# TYPE gremion_postgres_connections_max gauge\n'
    printf 'gremion_postgres_connections_max %s\n' "$max"
}

main() {
    local tmp
    # The scratch file is NOT written next to the output: node-exporter reads
    # every *.prom in the textfile directory, and a half-written one there is a
    # parse error on a real collector.
    tmp="$(mktemp)"
    {
        emit_backup_age
        emit_container_health
        emit_postgres_connections
        printf '# HELP gremion_metrics_textfile_timestamp_seconds Unix time this collector last completed.\n'
        printf '# TYPE gremion_metrics_textfile_timestamp_seconds gauge\n'
        printf 'gremion_metrics_textfile_timestamp_seconds %s\n' "$(date -u +%s)"
    } > "$tmp"
    atomic_write "$OUT_DIR/gremion.prom" 0644 < "$tmp"
    rm -f "$tmp"
    note "wrote $OUT_DIR/gremion.prom ($(wc -l < "$OUT_DIR/gremion.prom") lines)"
}

main "$@"
