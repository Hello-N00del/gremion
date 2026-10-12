#!/usr/bin/env bash
# The weekly storage footprint record (TRD-223, TASK-039-FU): how many bytes
# the three growth components hold, written down once per ISO week so a growth
# curve exists. Runs from gremion-footprint.timer (Mon 03:00 UTC) as the deploy
# user, on the HOST, like the metrics collector (Q3/Q11 path: host script,
# `docker exec`, textfile) -- never in a container.
#
#   synapse_db      pg_database_size('synapse') in the messaging Postgres
#   council_files   `du -sb` of every <root>/<tenant uuid>/ directory of the
#                   per-council file store (GREMION_FOOTPRINT_FILESTORE_ROOT)
#   log_volume      the pseudonymised-log (Vector) volume, as the daemon sizes it
#   platform_overhead  the containers labelled gremion.footprint=platform_overhead
#                   (the six ops services), `docker ps --size` (TRD-203, second half)
#
# A component that cannot be measured is `absent` (bytes null, no gauge line),
# never 0: a 0 means the source answered 0. Each absent entry says why
# (`absent_reason`):
#   not_present  the source does not exist on this host: no messaging-postgres
#                container (messaging off), no file-store root configured, no
#                Vector volume -- nothing to measure, not a fault
#   error        the source is there but did not answer: the size query failed,
#                du could not read a council directory (a PARTIAL du total is
#                not a measurement: it would undercount), docker system df
#                failed, the configured root is not a directory
#
# The run's outcome (in the record as .outcome, and in the plt.job_run row):
#   failed     none of the three TRD-223 components was measured, OR one of
#              them errored (a fault the operator has to see; exit 1)
#   succeeded  otherwise; a component that is not present does not fail the run
#   The row's detail_ref is `footprint/<week>.json`, plus
#   `#incomplete=<c>[,<c>]` naming each of the three that was not (fully)
#   measured, so the panel shows a partial week without opening the file.
#
# Writes, in this order, each atomically:
#   1. runtime/footprint/<ISO-week>.json     the dated record (kept: measurements, not logs)
#   2. runtime/textfile/gremion-footprint.prom   its OWN textfile, so the per-minute
#                                                collector never overwrites it;
#      gremion_footprint_timestamp_seconds is written only by a SUCCEEDED run,
#      so a failing week shows as a missing or old timestamp
#   3. one plt.job_run row (job_kind footprint_measurement) in gremion_platform,
#      idempotent per ISO week: UNIQUE (scheduled_job_id, scheduled_for)
#
# exit 0 record + gauge + row done (or the row already existed this week)
#      1 record and gauge written but the row failed (database down, the seed
#        row missing, the platform chain not at 0005), or the run's outcome is
#        failed (see above; a `failed` row is written when it can be)
#      2 missing runtime directory or tool
#
# Knobs: STACK, GREMION_FOOTPRINT_FILESTORE_ROOT (the environment wins over
# ops.env). FOOTPRINT_NOW_EPOCH overrides the clock for tests and the proof
# only; it is NOT an ops.env key.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"

need_cmd docker jq date mktemp awk du

ROOT="$(gremion_root)"
RUNTIME="$ROOT/runtime"
RECORD_DIR="$RUNTIME/footprint"
TEXTFILE_DIR="$RUNTIME/textfile"
OPS_ENV="$ROOT/etc/env/ops.env"

[[ -d "$RUNTIME" ]] || die "runtime directory absent: $RUNTIME" 2

# shellcheck source=./ops-lib.sh
. "$SCRIPT_DIR/ops-lib.sh"

STACK_NAME="$(ops_key STACK)"; STACK_NAME="${STACK_NAME:-gremion}"
FILESTORE_ROOT="$(ops_key GREMION_FOOTPRINT_FILESTORE_ROOT)"

# Diagnostics go to stderr: stdout is the one summary line.
note() { echo "[footprint] $*" >&2; }

mkdir -p "$RECORD_DIR" "$TEXTFILE_DIR"

# One scratch file for the stderr of the calls whose failure is a note, so the
# note can say WHY (never written next to the outputs).
ERRF="$(mktemp)"
trap 'rm -f "$ERRF"' EXIT
first_err() { head -n 1 "$ERRF" 2>/dev/null || true; }

# --- the week --------------------------------------------------------------
NOW="${FOOTPRINT_NOW_EPOCH:-$(date -u +%s)}"
[[ "$NOW" =~ ^[0-9]+$ ]] || die "FOOTPRINT_NOW_EPOCH is not an epoch: '$NOW'" 2
WEEK="$(date -u -d "@$NOW" +%G-W%V)"
DOW="$(date -u -d "@$NOW" +%u)"
# The ISO week's Monday 03:00:00Z: what the seeded cron '0 3 * * 1' names, and
# the key that makes a rerun inside one week collide on the UNIQUE index.
MONDAY="$(date -u -d "@$(( NOW - (DOW - 1) * 86400 ))" +%Y-%m-%d)"
SCHEDULED_FOR="${MONDAY}T03:00:00Z"
MEASURED_AT="$(date -u -d "@$NOW" +%Y-%m-%dT%H:%M:%SZ)"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- measure ----------------------------------------------------------------
COMPONENTS_JSON=()   # one JSON object per component entry
GAUGE_LINES=()       # measured entries only
SUMMARY_SYNAPSE="absent"
SUMMARY_FILES="absent"
SUMMARY_LOG="absent"
SUMMARY_OVERHEAD="absent"
MEASURED_OF_THREE=0
INCOMPLETE=()        # the TRD-223 components not (fully) measured, in measuring order
ERRORED=()           # ... of those, the ones whose source is there but did not answer

add_measured() {   # <component> <bytes> <source> [council]
    local component="$1" bytes="$2" source="$3" council="${4:-}" label
    if [[ -n "$council" ]]; then
        COMPONENTS_JSON+=("$(jq -nc --arg c "$component" --arg n "$council" --argjson b "$bytes" --arg s "$source" \
            '{component: $c, council: $n, bytes: $b, status: "measured", source: $s}')")
        label="component=\"$(esc "$component")\",council=\"$(esc "$council")\""
    else
        COMPONENTS_JSON+=("$(jq -nc --arg c "$component" --argjson b "$bytes" --arg s "$source" \
            '{component: $c, bytes: $b, status: "measured", source: $s}')")
        label="component=\"$(esc "$component")\""
    fi
    GAUGE_LINES+=("gremion_footprint_component_bytes{${label}} ${bytes}")
}

add_absent() {   # <component> <source> <not_present|error> [council]
    if [[ -n "${4:-}" ]]; then
        COMPONENTS_JSON+=("$(jq -nc --arg c "$1" --arg n "$4" --arg s "$2" --arg r "$3" \
            '{component: $c, council: $n, bytes: null, status: "absent", absent_reason: $r, source: $s}')")
    else
        COMPONENTS_JSON+=("$(jq -nc --arg c "$1" --arg s "$2" --arg r "$3" \
            '{component: $c, bytes: null, status: "absent", absent_reason: $r, source: $s}')")
    fi
}

errored() {   # <component> -- the component's source is there but did not (fully) answer
    INCOMPLETE+=("$1")
    ERRORED+=("$1")
}

measure_synapse_db() {
    local cid bytes rc=0 src="pg_database_size('synapse') in the messaging Postgres"
    cid="$(state_container messaging-postgres)"
    if [[ -z "$cid" ]]; then
        note "no ${STACK_NAME}-state messaging-postgres container -- synapse_db is absent (not present), never 0"
        add_absent synapse_db "$src" not_present
        INCOMPLETE+=(synapse_db)
        return 0
    fi
    # The role name is read INSIDE the container: no credential, no user name on this argv.
    bytes="$(docker exec "$cid" sh -c 'psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT pg_database_size('"'"'synapse'"'"')"' 2>"$ERRF")" || rc=$?
    bytes="$(printf '%s' "$bytes" | tr -d '[:space:]')"
    if (( rc != 0 )) || ! [[ "$bytes" =~ ^[0-9]+$ ]]; then
        note "synapse_db: the database size query (exit ${rc}) returned '${bytes}': $(first_err) -- absent (error)"
        add_absent synapse_db "$src" error
        errored synapse_db
        return 0
    fi
    add_measured synapse_db "$bytes" "$src"
    SUMMARY_SYNAPSE="$bytes"
    MEASURED_OF_THREE=$((MEASURED_OF_THREE + 1))
}

measure_log_volume() {
    local vols size bytes rc=0 name="${STACK_NAME}-state_vector-processed-logs" src="docker system df -v, the pseudonymised-log volume"
    vols="$(docker system df -v --format '{{json .Volumes}}' 2>"$ERRF")" || rc=$?
    # A daemon with no volume at all answers null: that is "not present", not an error.
    if (( rc != 0 )) || ! jq -e '. == null or type == "array"' >/dev/null 2>&1 <<< "$vols"; then
        note "log_volume: docker system df failed (exit ${rc}): $(first_err) -- absent (error), never 0"
        add_absent log_volume "$src" error
        errored log_volume
        return 0
    fi
    vols="$(jq -c '. // []' <<< "$vols")"
    if ! jq -e --arg n "$name" 'any(.[]; .Name == $n)' >/dev/null 2>&1 <<< "$vols"; then
        note "log_volume: the daemon knows no volume ${name} -- absent (not present), never 0"
        add_absent log_volume "$src" not_present
        INCOMPLETE+=(log_volume)
        return 0
    fi
    size="$(jq -r --arg n "$name" '[.[] | select(.Name == $n) | .Size][0] // empty' <<< "$vols")"
    bytes=""
    [[ -z "$size" ]] || bytes="$(to_bytes "$size")"
    if [[ -z "$bytes" ]]; then
        note "log_volume: the daemon sized ${name} as '${size}', which is not a size -- absent (error), never 0"
        add_absent log_volume "$src" error
        errored log_volume
        return 0
    fi
    add_measured log_volume "$bytes" "$src"
    SUMMARY_LOG="$bytes"
    MEASURED_OF_THREE=$((MEASURED_OF_THREE + 1))
}

measure_council_files() {
    local dir name bytes rc n=0 skipped=0 src="du -sb of each <tenant uuid> directory of the file-store root"
    if [[ -z "$FILESTORE_ROOT" ]]; then
        note "GREMION_FOOTPRINT_FILESTORE_ROOT is not set -- council_files is absent (not present), never 0"
        add_absent council_files "$src" not_present
        INCOMPLETE+=(council_files)
        return 0
    fi
    if [[ ! -d "$FILESTORE_ROOT" ]]; then
        note "GREMION_FOOTPRINT_FILESTORE_ROOT is set but is not a directory -- council_files is absent (error)"
        add_absent council_files "$src" error
        errored council_files
        return 0
    fi
    for dir in "$FILESTORE_ROOT"/*/; do
        [[ -d "$dir" ]] || continue
        dir="${dir%/}"
        name="${dir##*/}"
        # A canonical lowercase uuid is a council's pseudonymous id; anything else is not a tenant prefix.
        [[ "$name" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || continue
        # Never fatal (set -e): du exits 1 on any file it cannot read -- the
        # council files belong to the app container's uid, this unit runs as
        # the deploy user -- and a dead script writes no record, no gauge and
        # no row. du's own error is kept for the note.
        rc=0
        bytes="$(du -sb "$dir" 2>"$ERRF")" || rc=$?
        bytes="$(awk 'NR == 1 && $1 ~ /^[0-9]+$/ { print $1 }' <<< "$bytes")"
        # A PARTIAL total (du exit 1 with a number printed) is NOT a
        # measurement: it leaves out exactly what du could not read, so it
        # would undercount. That council is absent for the week, never a
        # smaller number.
        if (( rc != 0 )) || [[ -z "$bytes" ]]; then
            note "council_files: council ${name} is not measurable (du exit ${rc}: $(first_err)) -- absent (error), never 0 and never a partial total"
            add_absent council_files "$src" error "$name"
            skipped=$((skipped + 1))
            continue
        fi
        add_measured council_files "$bytes" "$src" "$name"
        n=$((n + 1))
    done
    (( skipped == 0 )) || errored council_files
    if (( n == 0 && skipped == 0 )); then
        # The root exists and holds no council directory: the source answered "nothing here".
        add_measured council_files 0 "$src (the root holds no council directory)"
        SUMMARY_FILES="0councils"
        MEASURED_OF_THREE=$((MEASURED_OF_THREE + 1))
        return 0
    fi
    if (( n == 0 )); then
        # Every council directory unmeasurable: the component was not measured
        # (each directory is in the record as absent), never "the root is empty".
        SUMMARY_FILES="absent"
        return 0
    fi
    SUMMARY_FILES="${n}councils"
    (( skipped == 0 )) || SUMMARY_FILES+="+${skipped}absent"
    MEASURED_OF_THREE=$((MEASURED_OF_THREE + 1))
}

measure_platform_overhead() {
    local sizes size bytes rc=0 total=0 n=0 src="docker ps --size, label gremion.footprint=platform_overhead"
    # Both filters are ANDed: the label names the six ops services, the project
    # keeps another stack's ops containers on the same daemon out of this
    # stack's overhead (named deviation: the brief names the label filter alone).
    sizes="$(docker ps --all --size --filter 'label=gremion.footprint=platform_overhead' \
        --filter "label=com.docker.compose.project=${STACK_NAME}-ops" --format '{{.Size}}' 2>"$ERRF")" || rc=$?
    if (( rc != 0 )); then
        # Not one of the three TRD-223 components: an error here is noted and
        # recorded, it does not fail the run.
        note "platform_overhead: docker ps --size failed (exit ${rc}): $(first_err) -- absent (error)"
        add_absent platform_overhead "$src" error
        return 0
    fi
    while IFS= read -r size; do
        [[ -n "$size" ]] || continue
        bytes="$(to_bytes "${size%% *}")"
        [[ -n "$bytes" ]] || continue
        total=$((total + bytes))
        n=$((n + 1))
    done <<< "$sizes"
    if (( n == 0 )); then
        note "platform_overhead: no labelled container of ${STACK_NAME}-ops reported a size -- absent (not present)"
        add_absent platform_overhead "$src" not_present
        return 0
    fi
    add_measured platform_overhead "$total" "$src"
    SUMMARY_OVERHEAD="$total"
}

measure_synapse_db
measure_council_files
measure_log_volume
measure_platform_overhead

# --- the outcome --------------------------------------------------------------
STATUS="succeeded"
if (( MEASURED_OF_THREE == 0 )); then
    note "none of the three TRD-223 components was measured"
    STATUS="failed"
elif (( ${#ERRORED[@]} > 0 )); then
    note "a TRD-223 component errored (${ERRORED[*]}) -- the run is failed"
    STATUS="failed"
fi

# --- write: record, gauge, row ----------------------------------------------
RECORD_NAME="${WEEK}.json"
RECORD_REL="footprint/${RECORD_NAME}"
DETAIL_REF="$RECORD_REL"
if (( ${#INCOMPLETE[@]} > 0 )); then
    DETAIL_REF+="#incomplete=$(IFS=,; printf '%s' "${INCOMPLETE[*]}")"
fi

printf '%s\n' "${COMPONENTS_JSON[@]}" \
    | jq -s --arg week "$WEEK" --arg sf "$SCHEDULED_FOR" --arg at "$MEASURED_AT" \
        --arg status "$STATUS" --argjson m "$MEASURED_OF_THREE" \
        --arg inc "$(IFS=,; printf '%s' "${INCOMPLETE[*]}")" --arg err "$(IFS=,; printf '%s' "${ERRORED[*]}")" \
        '{schema: 1, week: $week, scheduled_for: $sf, measured_at: $at,
          outcome: {status: $status, measured_of_three: $m,
                    incomplete: ($inc | split(",") | map(select(. != ""))),
                    errored: ($err | split(",") | map(select(. != "")))},
          components: .}' \
    | atomic_write "$RECORD_DIR/$RECORD_NAME" 0644

{
    if (( ${#GAUGE_LINES[@]} > 0 )); then
        printf '# HELP gremion_footprint_component_bytes Bytes a TRD-223 growth component held at the last weekly measurement.\n'
        printf '# TYPE gremion_footprint_component_bytes gauge\n'
        printf '%s\n' "${GAUGE_LINES[@]}"
    fi
    # Only a succeeded run refreshes the timestamp: a failing week is a missing
    # or old timestamp, never a fresh one next to nothing measured.
    if [[ "$STATUS" == succeeded ]]; then
        printf '# HELP gremion_footprint_timestamp_seconds Unix time of the last weekly footprint measurement that succeeded.\n'
        printf '# TYPE gremion_footprint_timestamp_seconds gauge\n'
        printf 'gremion_footprint_timestamp_seconds %s\n' "$NOW"
    fi
} | atomic_write "$TEXTFILE_DIR/gremion-footprint.prom" 0644

FINISHED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
JOB_RUN="failed"
EXIT=0
[[ "$STATUS" == succeeded ]] || EXIT=1

# One docker exec, the SQL on stdin, psql's own :'var' quoting: no string-built
# SQL. The first statement tells "the seed is missing" from "this week is
# already recorded", which both insert zero rows.
SQL="$(cat <<'EOSQL'
SELECT 'seed=' || count(*) FROM plt.scheduled_job WHERE job_kind = 'footprint_measurement' AND scope = 'platform';
INSERT INTO plt.job_run (scheduled_job_id, scope, scheduled_for, started_at, finished_at, status, detail_ref)
SELECT scheduled_job_id, 'platform', :'sf'::timestamptz, :'started'::timestamptz, :'finished'::timestamptz, :'status', :'detail'
  FROM plt.scheduled_job WHERE job_kind = 'footprint_measurement' AND scope = 'platform'
ON CONFLICT (scheduled_job_id, scheduled_for) DO NOTHING
RETURNING 'inserted';
EOSQL
)"

PG="$(state_container postgres)"
if [[ -z "$PG" ]]; then
    note "no ${STACK_NAME}-state postgres container -- the plt.job_run row was not written"
    EXIT=1
else
    if out="$(docker exec -i "$PG" psql -U postgres -d gremion_platform -X -q -tA -v ON_ERROR_STOP=1 \
            -v "week=${WEEK}" -v "sf=${SCHEDULED_FOR}" -v "started=${STARTED}" -v "finished=${FINISHED}" \
            -v "status=${STATUS}" -v "detail=${DETAIL_REF}" -f - <<< "$SQL" 2>/dev/null)"; then
        if [[ "$out" == *"seed=0"* ]]; then
            note "plt.scheduled_job has no footprint_measurement platform row (platform migration 0005 not applied or its seed removed) -- no job_run written"
            EXIT=1
        elif [[ "$out" == *inserted* ]]; then
            JOB_RUN="inserted"
        elif [[ "$out" == *"seed=1"* ]]; then
            JOB_RUN="exists"
        else
            note "the job_run write answered '${out}' -- not treated as written"
            EXIT=1
        fi
    else
        note "the plt.job_run write failed (database refused it or is not reachable)"
        EXIT=1
    fi
fi

printf 'FOOTPRINT: week=%s synapse_db=%s council_files=%s log_volume=%s platform_overhead=%s job_run=%s\n' \
    "$WEEK" "$SUMMARY_SYNAPSE" "$SUMMARY_FILES" "$SUMMARY_LOG" "$SUMMARY_OVERHEAD" "$JOB_RUN"
exit "$EXIT"
