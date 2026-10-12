#!/usr/bin/env bats
# TASK-039-FU (TRD-223): the weekly footprint record, infra/host/ops/footprint.sh.
# Unit only: docker is shimmed, the clock is injected (FOOTPRINT_NOW_EPOCH);
# nothing here touches a real daemon. The running proof is
# test/host/integration/observability-proof.sh (phases footprint-red, footprint,
# footprint-series).

load 'test_helper/host'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
FOOTPRINT="${PROJECT_ROOT}/infra/host/ops/footprint.sh"
COUNCIL_A="0192f0c1-2b3c-7d4e-8f00-112233445566"
COUNCIL_B="0192f0c1-2b3c-7d4e-8f00-665544332211"

setup() {
    setup_host_root
    mkdir -p "$GREMION_ROOT/etc/env"
}

teardown() {
    teardown_host_root
}

at() { date -u -d "$1" +%s; }

# docker as the host sees it: a messaging Postgres whose synapse database is
# 7340032 bytes, a state Postgres whose psql answers the job-run SQL (it records
# its stdin), the daemon's volume sizes and two labelled ops containers.
# Knobs (files under GREMION_ROOT): no-synapse, no-pg, no-volume, psql-fail,
# psql-exists, psql-noseed, synapse-garbage, no-overhead.
shim_world() {
    shim docker '
case "$*" in
  *"com.docker.compose.service=messaging-postgres"*) [ -f "$GREMION_ROOT/no-synapse" ] || echo "syn111" ;;
  *"com.docker.compose.service=postgres"*)           [ -f "$GREMION_ROOT/no-pg" ] || echo "pg222" ;;
  "exec syn111 sh -c"*)
    [ -f "$GREMION_ROOT/synapse-garbage" ] && { echo "psql: could not connect"; exit 0; }
    echo 7340032 ;;
  "exec -i pg222 psql"*)
    cat > "$GREMION_ROOT/psql-stdin"
    [ -f "$GREMION_ROOT/psql-fail" ] && exit 1
    [ -f "$GREMION_ROOT/psql-noseed" ] && { echo "seed=0"; exit 0; }
    [ -f "$GREMION_ROOT/psql-exists" ] && { echo "seed=1"; exit 0; }
    printf "seed=1\ninserted\n" ;;
  "system df -v"*)
    [ -f "$GREMION_ROOT/no-volume" ] && { printf "%s" "[{\"Name\":\"other_data\",\"Size\":\"9GB\"}]"; exit 0; }
    printf "%s" "[{\"Name\":\"staging-state_vector-processed-logs\",\"Size\":\"2.1MB\"},{\"Name\":\"staging-state_pg-data\",\"Size\":\"1.5GB\"}]" ;;
  "ps --all --size"*)
    [ -f "$GREMION_ROOT/no-overhead" ] && exit 0
    printf "1.5kB (virtual 300MB)\n2MB (virtual 1GB)\n" ;;
  *) : ;;
esac
exit 0'
}

seed_council() {   # <uuid> <MiB>
    mkdir -p "$GREMION_ROOT/files/$1"
    head -c $(( $2 * 1048576 )) /dev/zero > "$GREMION_ROOT/files/$1/blob"
}

run_fp() {   # <date> -- runs the script at that instant
    FOOTPRINT_NOW_EPOCH="$(at "$1")" STACK=staging GREMION_FOOTPRINT_FILESTORE_ROOT="${FILES_ROOT-$GREMION_ROOT/files}" run "$FOOTPRINT"
}

record() { echo "$GREMION_ROOT/runtime/footprint/$1.json"; }
gauge() { echo "$GREMION_ROOT/runtime/textfile/gremion-footprint.prom"; }

@test "footprint names the record by ISO week: Sunday 2026-10-04 is 2026-W40, Monday 2026-10-05 is 2026-W41, 2027-01-01 is 2026-W53" {
    shim_world
    seed_council "$COUNCIL_A" 1
    run_fp "2026-10-04 12:00:00"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [ -f "$(record 2026-W40)" ]
    jq -e '.week == "2026-W40" and .scheduled_for == "2026-09-28T03:00:00Z"' "$(record 2026-W40)"
    run_fp "2026-10-05 00:00:01"
    [ "$status" -eq 0 ]
    [ -f "$(record 2026-W41)" ]
    jq -e '.week == "2026-W41" and .scheduled_for == "2026-10-05T03:00:00Z"' "$(record 2026-W41)"
    run_fp "2027-01-01 12:00:00"
    [ "$status" -eq 0 ]
    [ -f "$(record 2026-W53)" ]
    jq -e '.week == "2026-W53" and .scheduled_for == "2026-12-28T03:00:00Z"' "$(record 2026-W53)"
}

@test "footprint writes the record: three components measured, seeded sizes read back, a council per uuid, no host data" {
    shim_world
    seed_council "$COUNCIL_A" 3
    mkdir -p "$GREMION_ROOT/files/not-a-council"; head -c 524288 /dev/zero > "$GREMION_ROOT/files/not-a-council/blob"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    local summary="$output" r; r="$(record 2026-W41)"
    jq -e '.schema == 1 and (.measured_at | test("^2026-10-07T09:00:00Z$"))' "$r"
    jq -e '[.components[] | select(.component == "synapse_db")] | length == 1 and .[0].bytes == 7340032 and .[0].status == "measured"' "$r"
    jq -e '[.components[] | select(.component == "log_volume")] | .[0].bytes == 2100000 and .[0].status == "measured"' "$r"
    # a 3 MiB file under <root>/<uuid>/: [3145728, 3145728 + 1 MiB); the non-uuid directory is ignored
    jq -e --arg c "$COUNCIL_A" '[.components[] | select(.component == "council_files")] | length == 1 and .[0].council == $c and .[0].bytes >= 3145728 and .[0].bytes < 4194304' "$r"
    # 1.5 kB + 2 MB from docker ps --size
    jq -e '[.components[] | select(.component == "platform_overhead")] | .[0].bytes == 2001500 and .[0].status == "measured"' "$r"
    # every component is either an integer + measured or null + absent
    jq -e 'all(.components[]; (.status == "measured" and (.bytes | type) == "number" and .bytes == (.bytes | floor)) or (.status == "absent" and .bytes == null))' "$r"
    # the overhead is this stack's six ops containers: the label AND the project, so another stack's ops project is not counted
    assert_recorded docker "label=gremion.footprint=platform_overhead"
    assert_recorded docker "label=com.docker.compose.project=staging-ops"
    # no host name, address or secret
    run grep -Ei 'password|secret|token|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|\.local|\.com|\.org|not-a-council' "$r"
    [ "$status" -ne 0 ]
    [[ "$summary" == "FOOTPRINT: week=2026-W41 synapse_db=7340032 council_files=1councils log_volume=2100000 platform_overhead=2001500 job_run=inserted" ]] || { echo "$summary"; return 1; }
    # the council id is the only council identifier in the gauge
    grep -qF "gremion_footprint_component_bytes{component=\"council_files\",council=\"$COUNCIL_A\"} " "$(gauge)"
    grep -qE '^gremion_footprint_component_bytes\{component="synapse_db"\} 7340032$' "$(gauge)"
    grep -qE '^gremion_footprint_component_bytes\{component="log_volume"\} 2100000$' "$(gauge)"
    grep -qE '^gremion_footprint_timestamp_seconds [0-9]+$' "$(gauge)"
}

@test "footprint: a missing component is ABSENT, never 0 (no messaging-postgres, no file-store root, no volume)" {
    shim_world
    touch "$GREMION_ROOT/no-synapse" "$GREMION_ROOT/no-volume" "$GREMION_ROOT/no-overhead"
    FILES_ROOT="" run_fp "2026-10-07 09:00:00"
    # none of the three measurable: the record and the gauge exist, the run is a visible failure
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    local r; r="$(record 2026-W41)"
    jq -e 'all(.components[]; .status == "absent" and .bytes == null)' "$r"
    jq -e '[.components[].component] | sort == ["council_files", "log_volume", "platform_overhead", "synapse_db"]' "$r"
    # no gauge line for an absent component: grep, not a value compare
    run grep -c 'component="' "$(gauge)"
    [ "$output" = "0" ]
    run grep -c 'gremion_footprint_component_bytes' "$(gauge)"
    [ "$output" = "0" ]
    grep -qE '^gremion_footprint_timestamp_seconds [0-9]+$' "$(gauge)"
    run grep -E '"bytes": *0\b' "$r"
    [ "$status" -ne 0 ]
}

@test "footprint: one absent component does not hide the others, and only the absent one has no gauge line" {
    shim_world
    touch "$GREMION_ROOT/no-synapse"
    seed_council "$COUNCIL_A" 1
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    jq -e '[.components[] | select(.component == "synapse_db")] | .[0].status == "absent" and .[0].bytes == null' "$(record 2026-W41)"
    run grep -c 'component="synapse_db"' "$(gauge)"
    [ "$output" = "0" ]
    grep -q 'component="log_volume"' "$(gauge)"
    # a garbage size answer is absent too
    rm -f "$GREMION_ROOT/no-synapse"; touch "$GREMION_ROOT/synapse-garbage"
    run_fp "2026-10-07 09:00:00"
    jq -e '[.components[] | select(.component == "synapse_db")] | .[0].status == "absent"' "$(record 2026-W41)"
    run grep -c 'component="synapse_db"' "$(gauge)"
    [ "$output" = "0" ]
}

@test "footprint: an empty file-store root is a measured zero, a root that is not a directory is absent" {
    shim_world
    mkdir -p "$GREMION_ROOT/files"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ]
    jq -e '[.components[] | select(.component == "council_files")] | length == 1 and .[0].status == "measured" and .[0].bytes == 0' "$(record 2026-W41)"
    FILES_ROOT="$GREMION_ROOT/nope" run_fp "2026-10-07 09:00:00"
    jq -e '[.components[] | select(.component == "council_files")] | .[0].status == "absent" and .[0].bytes == null' "$(record 2026-W41)"
}

# du as the deploy user sees a council directory whose files the app container's
# uid owns: it prints a PARTIAL total for <uuid> and exits 1 (EACCES on a
# subdirectory); every other directory goes to the real du.
shim_du_fails() {   # <uuid>
    shim du '
case "$*" in
  *"'"$1"'"*)
    echo "du: cannot read directory '"'"'${@: -1}/private'"'"': Permission denied" >&2
    printf "4096\t%s\n" "${@: -1}"
    exit 1 ;;
esac
PATH="${PATH#*:}" exec du "$@"'
}

@test "footprint: a council directory du cannot read (exit 1, partial total) is ABSENT with its council id, du's error is logged, and the run still writes record, gauge and row (round-1 H1)" {
    shim_world
    seed_council "$COUNCIL_A" 1
    seed_council "$COUNCIL_B" 1
    shim_du_fails "$COUNCIL_B"
    run_fp "2026-10-07 09:00:00"
    # the script ran to its end: the one summary line is printed
    [[ "$output" == *"FOOTPRINT: week=2026-W41 "* ]] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *" council_files=1councils+1absent "* ]] || { echo "$output"; return 1; }
    local r; r="$(record 2026-W41)"
    [ -s "$r" ]
    # the unreadable council: absent, bytes null, its id kept -- a partial du total is NOT a measurement
    jq -e --arg c "$COUNCIL_B" '[.components[] | select(.component == "council_files" and .council == $c)] | length == 1 and .[0].status == "absent" and .[0].bytes == null' "$r"
    # the readable council is still measured
    jq -e --arg c "$COUNCIL_A" '[.components[] | select(.component == "council_files" and .council == $c)] | length == 1 and .[0].status == "measured" and .[0].bytes >= 1048576' "$r"
    # du's own error reaches the log (stderr is part of $output under bats run)
    [[ "$output" == *"Permission denied"* ]] || { echo "$output"; return 1; }
    # the gauge: the readable council has a line, the unreadable one has none
    grep -qF "council=\"$COUNCIL_A\"" "$(gauge)"
    run grep -c "council=\"$COUNCIL_B\"" "$(gauge)"
    [ "$output" = "0" ]
    # the row was still attempted
    [ -s "$GREMION_ROOT/psql-stdin" ]
}

@test "footprint: when every council directory is unmeasurable, council_files is never a measured 0 (round-1 H1)" {
    shim_world
    seed_council "$COUNCIL_B" 1
    shim_du_fails "$COUNCIL_B"
    run_fp "2026-10-07 09:00:00"
    [[ "$output" == *"FOOTPRINT: week=2026-W41 "* ]] || { echo "status $status: $output"; return 1; }
    local summary="$output" r; r="$(record 2026-W41)"
    [[ "$summary" == *" council_files=absent "* ]] || { echo "$summary"; return 1; }
    # no measured council_files entry at all, so no "the root holds nothing" 0
    jq -e '[.components[] | select(.component == "council_files" and .status == "measured")] | length == 0' "$r"
    jq -e --arg c "$COUNCIL_B" '[.components[] | select(.component == "council_files")] | length == 1 and .[0].council == $c and .[0].status == "absent"' "$r"
    run grep -c 'component="council_files"' "$(gauge)"
    [ "$output" = "0" ]
}

@test "footprint writes the job_run through ONE docker exec, SQL on stdin with psql binds, no value in the SQL text, no secret on any argv" {
    shim_world
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    local sql="$GREMION_ROOT/psql-stdin"
    [ -s "$sql" ]
    grep -qF 'INSERT INTO plt.job_run' "$sql"
    grep -qF 'ON CONFLICT (scheduled_job_id, scheduled_for) DO NOTHING' "$sql"
    grep -qF ":'sf'" "$sql"
    grep -qF ":'started'" "$sql"
    grep -qF ":'finished'" "$sql"
    grep -qF ":'status'" "$sql"
    grep -qF ":'detail'" "$sql"
    grep -qF "job_kind = 'footprint_measurement'" "$sql"
    # no value interpolated into the SQL text
    run grep -E '2026-|footprint/|succeeded|failed' "$sql"
    [ "$status" -ne 0 ]
    # the values travel as psql variables on the argv: week, scheduled_for, status, the pointer
    assert_recorded docker "exec -i pg222 psql -U postgres -d gremion_platform"
    assert_recorded docker "-v ON_ERROR_STOP=1"
    assert_recorded docker "sf=2026-10-05T03:00:00Z"
    assert_recorded docker "status=succeeded"
    assert_recorded docker "detail=footprint/2026-W41.json"
    assert_recorded docker "-f -"
    # no password, no -W, no PGPASSWORD on any argv
    refute_recorded docker " -W"
    refute_recorded docker "PGPASSWORD"
    refute_recorded docker "password"
    # the synapse size is read with the role name resolved INSIDE the container
    assert_recorded docker 'exec syn111 sh -c psql -U "$POSTGRES_USER"'
    # exactly one row-writing exec, not a loop
    run grep -c '^docker exec -i pg222 psql' "$SHIM_LOG"
    [ "$output" = "1" ]
}

@test "footprint: a second run in the same ISO week prints job_run=exists, exits 0 and rewrites the record" {
    shim_world
    run_fp "2026-10-05 09:00:00"
    [ "$status" -eq 0 ]
    [[ "$output" == *"job_run=inserted"* ]]
    printf 'stale' > "$(record 2026-W41)"
    touch "$GREMION_ROOT/psql-exists"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    [[ "$output" == *"job_run=exists"* ]]
    jq -e '.week == "2026-W41" and (.components | length) == 4' "$(record 2026-W41)"
    # a run in the NEXT week is a new record and a new row
    rm -f "$GREMION_ROOT/psql-exists"
    run_fp "2026-10-12 09:00:00"
    [ "$status" -eq 0 ]
    [[ "$output" == *"week=2026-W42"* && "$output" == *"job_run=inserted"* ]]
    [ -f "$(record 2026-W42)" ] && [ -f "$(record 2026-W41)" ]
    assert_recorded docker "sf=2026-10-12T03:00:00Z"
}

@test "footprint: a failing psql leaves the record and the gauge and exits 1" {
    shim_world
    touch "$GREMION_ROOT/psql-fail"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *"job_run=failed"* ]]
    [ -s "$(record 2026-W41)" ]
    jq -e '.components | length == 4' "$(record 2026-W41)"
    grep -q 'component="log_volume"' "$(gauge)"
}

@test "footprint: no state postgres container exits 1 with the record and the gauge written" {
    shim_world
    touch "$GREMION_ROOT/no-pg"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ]
    [[ "$output" == *"job_run=failed"* ]]
    [ -s "$(record 2026-W41)" ]
    [ -s "$(gauge)" ]
}

@test "footprint: all three components absent writes a FAILED row and exits 1" {
    shim_world
    touch "$GREMION_ROOT/no-synapse" "$GREMION_ROOT/no-volume"
    FILES_ROOT="" run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ]
    assert_recorded docker "status=failed"
    refute_recorded docker "status=succeeded"
    [[ "$output" == *"job_run=inserted"* ]]
}

@test "footprint: a missing scheduled_job seed exits 1 naming it, and never inserts the definition" {
    shim_world
    touch "$GREMION_ROOT/psql-noseed"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ]
    [[ "$output" == *"job_run=failed"* ]]
    # stderr is part of $output under bats run
    [[ "$output" == *"footprint_measurement"* ]]
    run grep -c 'INSERT INTO plt.scheduled_job' "$GREMION_ROOT/psql-stdin"
    [ "$output" = "0" ]
}

@test "footprint leaves no partial file behind and writes the gauge to its OWN textfile" {
    shim_world
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ]
    run find "$GREMION_ROOT/runtime" -name '*.tmp'
    [ -z "$output" ]
    [ -s "$GREMION_ROOT/runtime/textfile/gremion-footprint.prom" ]
    # the per-minute collector's file is never touched by this script
    [ ! -e "$GREMION_ROOT/runtime/textfile/gremion.prom" ]
    # one family, once, contiguously
    run bash -c "grep -oE '^# TYPE [a-z_]+' '$(gauge)' | sort | uniq -d"
    [ -z "$output" ]
}

@test "footprint refuses a missing runtime directory (exit 2)" {
    shim_world
    rm -rf "$GREMION_ROOT/runtime"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 2 ]
    [[ "$output" == *"runtime directory absent"* ]]
}

@test "footprint reads the file-store root from ops.env when the environment has none, and the stack name from it" {
    shim_world
    seed_council "$COUNCIL_B" 1
    printf 'STACK=staging\nGREMION_FOOTPRINT_FILESTORE_ROOT=%s\n' "$GREMION_ROOT/files" > "$GREMION_ROOT/etc/env/ops.env"
    FOOTPRINT_NOW_EPOCH="$(at '2026-10-07 09:00:00')" run "$FOOTPRINT"
    [ "$status" -eq 0 ] || { echo "$output"; return 1; }
    jq -e --arg c "$COUNCIL_B" '[.components[] | select(.component == "council_files")] | .[0].council == $c' "$(record 2026-W41)"
    assert_recorded docker "com.docker.compose.project=staging-state"
}

@test "ops-lib.sh carries the four shared helpers once; neither script defines its own copy (R31 O14)" {
    local lib="${PROJECT_ROOT}/infra/host/ops/ops-lib.sh"
    [ -f "$lib" ]
    local f
    for f in ops_key esc to_bytes state_container; do
        grep -qE "^${f}\(\) " "$lib" || { echo "ops-lib.sh does not define $f"; return 1; }
        run grep -nE "^${f}\(\) " "${PROJECT_ROOT}/infra/host/ops/metrics-textfile.sh" "$FOOTPRINT"
        [ "$status" -ne 0 ] || { echo "$f is still defined in a script: $output"; return 1; }
    done
}
