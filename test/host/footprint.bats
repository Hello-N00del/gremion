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
    # the file-store root exists (empty = a measured 0); a test that wants it
    # unset or wrong passes FILES_ROOT
    mkdir -p "$GREMION_ROOT/etc/env" "$GREMION_ROOT/files"
}

teardown() {
    teardown_host_root
}

at() { date -u -d "$1" +%s; }

# docker as the host sees it: a messaging Postgres whose synapse database is
# 7340032 bytes, a state Postgres whose psql answers the job-run SQL (it records
# its stdin), the daemon's volume sizes and two labelled ops containers.
# Knobs (files under GREMION_ROOT): no-synapse, no-pg, no-volume, psql-fail,
# psql-exists, psql-noseed, synapse-garbage, synapse-down, df-fail,
# no-overhead, ps-fail.
shim_world() {
    shim docker '
# ps-fail: the container lookup (docker ps --filter ...) fails as with a daemon that does not answer
if [ -f "$GREMION_ROOT/ps-fail" ] && [ "$1" = ps ] && [ "$2" = --filter ]; then
  echo "Cannot connect to the Docker daemon" >&2; exit 1
fi
# ps-fail-synapse: only the messaging-postgres lookup fails (the daemon answers everything else)
if [ -f "$GREMION_ROOT/ps-fail-synapse" ] && [ "$1" = ps ] && [[ "$*" == *"service=messaging-postgres"* ]]; then
  echo "error during connect: lookup interrupted" >&2; exit 1
fi
case "$*" in
  *"com.docker.compose.service=messaging-postgres"*) [ -f "$GREMION_ROOT/no-synapse" ] || echo "syn111" ;;
  *"com.docker.compose.service=postgres"*)           [ -f "$GREMION_ROOT/no-pg" ] || echo "pg222" ;;
  "exec syn111 sh -c"*)
    [ -f "$GREMION_ROOT/synapse-garbage" ] && { echo "psql: could not connect"; exit 0; }
    [ -f "$GREMION_ROOT/synapse-down" ] && { echo "psql: error: FATAL:  role \"synapse_admin\" does not exist" >&2; exit 2; }
    echo 7340032 ;;
  "exec -i pg222 psql"*)
    # answers like the job-run SQL would: the seed line, the week line, the RETURNING line
    cat > "$GREMION_ROOT/psql-stdin"
    st="$(printf "%s" "$*" | sed -n "s/.* -v status=\([a-z]*\) .*/\1/p")"
    [ -f "$GREMION_ROOT/psql-fail" ] && { echo "psql: error: connection to server on socket failed" >&2; exit 2; }
    [ -f "$GREMION_ROOT/psql-norelation" ] && { echo "ERROR:  relation \"plt.scheduled_job\" does not exist" >&2; exit 3; }
    [ -f "$GREMION_ROOT/psql-noseed" ] && { printf "seed=0 enabled=none\nweek=\n"; exit 0; }
    [ -f "$GREMION_ROOT/psql-exists" ] && { printf "seed=1 enabled=true\nweek=succeeded\n"; exit 0; }
    [ -f "$GREMION_ROOT/psql-disabled-rerun" ] && { printf "seed=1 enabled=false\nweek=skipped\n"; exit 0; }
    [ -f "$GREMION_ROOT/psql-disabled" ] && { printf "seed=1 enabled=false\nweek=\ninserted status=skipped\n"; exit 0; }
    if [ -f "$GREMION_ROOT/psql-week-failed" ]; then
      printf "seed=1 enabled=true\nweek=failed\n"
      [ "$st" = succeeded ] && echo "retried status=succeeded"
      exit 0
    fi
    printf "seed=1 enabled=true\nweek=\ninserted status=%s\n" "$st" ;;
  "system df -v"*)
    [ -f "$GREMION_ROOT/df-fail" ] && { echo "Error response from daemon: a disk usage operation is already running" >&2; exit 1; }
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
    # a run that measured nothing does NOT refresh the timestamp: "missing or
    # old gremion_footprint_timestamp_seconds" is one of the three failure
    # channels (round-1 MEDIUM)
    run grep -c 'gremion_footprint_timestamp_seconds' "$(gauge)"
    [ "$output" = "0" ]
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

@test "footprint: a component that is NOT PRESENT (no messaging-postgres, no file-store root) leaves the run succeeded, and the row's pointer names what is missing (round-1 M3)" {
    shim_world
    touch "$GREMION_ROOT/no-synapse"
    FILES_ROOT="" run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ] || { echo "status $status: $output"; return 1; }
    local r; r="$(record 2026-W41)"
    jq -e '.outcome.status == "succeeded" and .outcome.measured_of_three == 1 and .outcome.incomplete == ["synapse_db", "council_files"] and .outcome.errored == []' "$r"
    jq -e '[.components[] | select(.component == "synapse_db" or .component == "council_files")] | all(.status == "absent" and .absent_reason == "not_present")' "$r"
    assert_recorded docker "status=succeeded"
    assert_recorded docker "detail=footprint/2026-W41.json#incomplete=synapse_db,council_files"
    grep -qE '^gremion_footprint_timestamp_seconds [0-9]+$' "$(gauge)"
}

@test "footprint: a component whose source is there but does not answer is an ERROR: the run is failed, exit 1, the cause is logged, no fresh timestamp (round-1 M3)" {
    shim_world
    seed_council "$COUNCIL_A" 1
    touch "$GREMION_ROOT/synapse-down"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    local r; r="$(record 2026-W41)"
    jq -e '.outcome.status == "failed" and .outcome.measured_of_three == 2 and .outcome.incomplete == ["synapse_db"] and .outcome.errored == ["synapse_db"]' "$r"
    jq -e '[.components[] | select(.component == "synapse_db")] | .[0].status == "absent" and .[0].absent_reason == "error" and .[0].bytes == null' "$r"
    # the measured components keep their gauge lines; the run is not a fresh success
    grep -q 'component="log_volume"' "$(gauge)"
    run grep -c 'gremion_footprint_timestamp_seconds' "$(gauge)"
    [ "$output" = "0" ]
    assert_recorded docker "status=failed"
    assert_recorded docker "detail=footprint/2026-W41.json#incomplete=synapse_db"
    # psql's own error reaches the log
    run_fp "2026-10-07 09:00:00"
    [[ "$output" == *'role "synapse_admin" does not exist'* ]] || { echo "$output"; return 1; }
}

@test "footprint: a failing docker system df and a partly unreadable file store are errors too (round-1 M3)" {
    shim_world
    seed_council "$COUNCIL_A" 1
    touch "$GREMION_ROOT/df-fail"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    jq -e '.outcome.status == "failed" and .outcome.errored == ["log_volume"]' "$(record 2026-W41)"
    [[ "$output" == *"a disk usage operation is already running"* ]] || { echo "$output"; return 1; }
    rm -f "$GREMION_ROOT/df-fail"
    seed_council "$COUNCIL_B" 1
    shim_du_fails "$COUNCIL_B"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    jq -e '.outcome.status == "failed" and .outcome.measured_of_three == 3 and .outcome.errored == ["council_files"] and .outcome.incomplete == ["council_files"]' "$(record 2026-W41)"
}

@test "footprint: all three measured is a plain pointer and a succeeded outcome" {
    shim_world
    seed_council "$COUNCIL_A" 1
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ] || { echo "status $status: $output"; return 1; }
    jq -e '.outcome == {status: "succeeded", measured_of_three: 3, incomplete: [], errored: []}' "$(record 2026-W41)"
    run grep -E '^docker exec -i pg222 psql .*detail=footprint/2026-W41\.json( |$)' "$SHIM_LOG"
    [ "$status" -eq 0 ] || { cat "$SHIM_LOG"; return 1; }
}

@test "footprint: an empty file-store root is a measured zero, a root that is not a directory is absent" {
    shim_world
    mkdir -p "$GREMION_ROOT/files"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ]
    jq -e '[.components[] | select(.component == "council_files")] | length == 1 and .[0].status == "measured" and .[0].bytes == 0' "$(record 2026-W41)"
    # brief s.4: the measured empty store is `council: null, bytes: 0`
    jq -e '[.components[] | select(.component == "council_files")] | .[0] | has("council") and .council == null' "$(record 2026-W41)"
    FILES_ROOT="$GREMION_ROOT/nope" run_fp "2026-10-07 09:00:00"
    jq -e '[.components[] | select(.component == "council_files")] | .[0].status == "absent" and .[0].bytes == null' "$(record 2026-W41)"
}

# The root may be a SYMLINK to the mount (the deploy tree already uses a
# `current` symlink; an operator may point the key at a stable link). `find`
# does not follow a starting point that is a symlink unless told to (-H), so
# the listing came back empty with rc 0 and a store holding a council read as
# a measured 0 (round-3 verifier HIGH). Needs no shim: it fails as root too.
@test "footprint: a file-store root that is a SYMLINK to the store is measured through the link, never read as an empty store (round-3 HIGH)" {
    shim_world
    seed_council "$COUNCIL_A" 2
    ln -s "$GREMION_ROOT/files" "$GREMION_ROOT/files-link"
    FILES_ROOT="$GREMION_ROOT/files-link" run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *" council_files=1councils "* ]] || { echo "$output"; return 1; }
    local r; r="$(record 2026-W41)"
    jq -e --arg c "$COUNCIL_A" '[.components[] | select(.component == "council_files")] | length == 1 and .[0].status == "measured" and .[0].council == $c and .[0].bytes >= 2097152 and .[0].bytes < 3145728' "$r"
    grep -qF "gremion_footprint_component_bytes{component=\"council_files\",council=\"$COUNCIL_A\"} " "$(gauge)"
}

# The file-store root as the deploy user sees it when the app container's uid
# owns it at mode 0700/0711: no r bit, so the directory cannot be LISTED. The
# bats runner runs as root, for whom chmod 300 lists fine, so the test cannot
# use chmod: it shims `find`, the listing command, to answer as the kernel
# answers a non-root user (verifier probe, uid 65534, root at chmod 300).
shim_root_unlistable() {
    shim find '
case "$*" in
  *"'"$1"'"*-mindepth*|*-mindepth*"'"$1"'"*)
    echo "find: '"'"'$1'"'"': Permission denied" >&2
    exit 1 ;;
esac
PATH="${PATH#*:}" exec find "$@"'
}

@test "footprint: a file-store root the deploy user cannot LIST is ABSENT (error), never a measured 0: the run is failed and says why (round-2 H2)" {
    shim_world
    seed_council "$COUNCIL_A" 1
    shim_root_unlistable "$GREMION_ROOT/files"
    run_fp "2026-10-07 09:00:00"
    # the script ran to its end, the run is a visible failure
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *" council_files=absent "* ]] || { echo "$output"; return 1; }
    # find's own error is in the log
    [[ "$output" == *"Permission denied"* ]] || { echo "$output"; return 1; }
    local r; r="$(record 2026-W41)"
    # no measured council_files entry at all: not "the root holds nothing"
    jq -e '[.components[] | select(.component == "council_files" and .status == "measured")] | length == 0' "$r"
    jq -e '[.components[] | select(.component == "council_files")] | length == 1 and .[0].status == "absent" and .[0].bytes == null and .[0].absent_reason == "error"' "$r"
    jq -e '.outcome.status == "failed" and .outcome.errored == ["council_files"] and .outcome.incomplete == ["council_files"]' "$r"
    # no gauge line, no fresh timestamp
    run grep -c 'component="council_files"' "$(gauge)"
    [ "$output" = "0" ]
    run grep -c 'gremion_footprint_timestamp_seconds' "$(gauge)"
    [ "$output" = "0" ]
    assert_recorded docker "status=failed"
    assert_recorded docker "detail=footprint/2026-W41.json#incomplete=council_files"
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
    # round 2 (M1): the week window and the retry key are binds too
    grep -qF ":'wk'" "$sql"
    # the window is a fixed 168 hours: a days interval follows the session
    # TimeZone and is 167 or 169 hours across a DST change (round-2 sql LOW)
    grep -qF "interval '168 hours'" "$sql"
    run grep -F "interval '7 days'" "$sql"
    [ "$status" -ne 0 ]
    grep -qF ":'retry'" "$sql"
    # no value interpolated into the SQL text: no date, no pointer ...
    run grep -E '2026-|footprint/|W41' "$sql"
    [ "$status" -ne 0 ]
    # ... and the text is byte-identical for another week and another outcome
    cp "$sql" "$GREMION_ROOT/sql-first"
    touch "$GREMION_ROOT/no-synapse" "$GREMION_ROOT/no-volume"
    FILES_ROOT="" run_fp "2026-10-14 09:00:00"
    [ "$status" -eq 1 ]
    assert_recorded docker "status=failed"
    cmp "$GREMION_ROOT/sql-first" "$sql"
    rm -f "$GREMION_ROOT/no-synapse" "$GREMION_ROOT/no-volume"
    # the values travel as psql variables on the argv: week, scheduled_for, status, the pointer
    assert_recorded docker "exec -i pg222 psql -U postgres -d gremion_platform"
    assert_recorded docker "-v ON_ERROR_STOP=1"
    assert_recorded docker "sf=2026-10-05T03:00:00Z"
    assert_recorded docker "wk=2026-10-05T00:00:00Z"
    assert_recorded docker "retry=2026-10-07T09:00:00Z"
    assert_recorded docker "status=succeeded"
    assert_recorded docker "detail=footprint/2026-W41.json"
    assert_recorded docker "-f -"
    # no password, no -W, no PGPASSWORD on any argv
    refute_recorded docker " -W"
    refute_recorded docker "PGPASSWORD"
    refute_recorded docker "password"
    # the synapse size is read with the role name resolved INSIDE the container
    assert_recorded docker 'exec syn111 sh -c psql -U "$POSTGRES_USER"'
    # exactly one row-writing exec per run (two runs here), not a loop
    run grep -c '^docker exec -i pg222 psql' "$SHIM_LOG"
    [ "$output" = "2" ]
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

@test "footprint: a FAILED week is not hidden by a successful rerun in the same week: the rerun writes a retry row, prints job_run=retried, exits 0 (round-1 M1)" {
    shim_world
    seed_council "$COUNCIL_A" 1
    # run 1, Monday: nothing measurable -> a failed row at the week's key
    touch "$GREMION_ROOT/no-synapse" "$GREMION_ROOT/no-volume"
    FILES_ROOT="" run_fp "2026-10-05 03:00:05"
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *"job_run=inserted"* ]]
    assert_recorded docker "status=failed"
    # run 2, Wednesday, the cause fixed: the week holds only a failed row
    rm -f "$GREMION_ROOT/no-synapse" "$GREMION_ROOT/no-volume"
    touch "$GREMION_ROOT/psql-week-failed"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *"job_run=retried"* ]] || { echo "$output"; return 1; }
    # the operator is told what the week held before
    [[ "$output" == *"failed"*"retry"* ]] || { echo "$output"; return 1; }
    # the retry key is this run's measured_at, inside the week
    assert_recorded docker "retry=2026-10-07T09:00:00Z"
    jq -e '.outcome.status == "succeeded"' "$(record 2026-W41)"
}

@test "footprint: a rerun that finds the week already recorded says what the week holds; a failed rerun after a success adds nothing and exits 1 (round-1 M1)" {
    shim_world
    touch "$GREMION_ROOT/psql-exists" "$GREMION_ROOT/no-synapse" "$GREMION_ROOT/no-volume"
    FILES_ROOT="" run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *"job_run=exists"* ]]
    [[ "$output" == *"succeeded"* ]]
}

@test "footprint: a DISABLED footprint definition gets a skipped row, never a succeeded one (round-1 LOW enabled)" {
    shim_world
    touch "$GREMION_ROOT/psql-disabled"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *"job_run=skipped"* ]] || { echo "$output"; return 1; }
    [[ "$output" == *"disabled"* ]]
    grep -qF 'CASE WHEN s.enabled THEN' "$GREMION_ROOT/psql-stdin"
}

@test "footprint: a RERUN in a week the disabled definition already skipped is not a failure: exit 0, job_run=exists, and the note says disabled, not 'rerun it' (round-2 verifier LOW)" {
    shim_world
    touch "$GREMION_ROOT/psql-disabled-rerun"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 0 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *"job_run=exists"* ]] || { echo "$output"; return 1; }
    [[ "$output" == *"disabled"* ]] || { echo "$output"; return 1; }
    [[ "$output" != *"rerun it"* ]] || { echo "$output"; return 1; }
}

@test "footprint: a platform database below 0005 is named, with psql's own error (round-1 MEDIUM stderr)" {
    shim_world
    touch "$GREMION_ROOT/psql-norelation"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *"job_run=failed"* ]]
    [[ "$output" == *'relation "plt.scheduled_job" does not exist'* ]] || { echo "$output"; return 1; }
    [[ "$output" == *"0005"* ]]
}

@test "footprint: a failing psql leaves the record and the gauge and exits 1" {
    shim_world
    touch "$GREMION_ROOT/psql-fail"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *"job_run=failed"* ]]
    # psql's own error is in the note (round-1 MEDIUM: it went to /dev/null)
    [[ "$output" == *"connection to server on socket failed"* ]] || { echo "$output"; return 1; }
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

@test "footprint: a failing container lookup (docker ps exits 1) is absent, not a dead script: record, gauge and summary are written, exit 1 (round-1 LOW state_container)" {
    shim_world
    seed_council "$COUNCIL_A" 1
    touch "$GREMION_ROOT/ps-fail"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    [[ "$output" == *"FOOTPRINT: week=2026-W41 synapse_db=absent "* && "$output" == *"job_run=failed"* ]] || { echo "$output"; return 1; }
    jq -e '[.components[] | select(.component == "synapse_db")] | .[0].status == "absent"' "$(record 2026-W41)"
    grep -q 'component="log_volume"' "$(gauge)"
}

@test "footprint: a messaging-postgres lookup that FAILS (the daemon answers the rest) is an ERROR, not 'not present': the week is failed and says why (round-2 silent-failure MEDIUM)" {
    shim_world
    seed_council "$COUNCIL_A" 1
    touch "$GREMION_ROOT/ps-fail-synapse"
    run_fp "2026-10-07 09:00:00"
    [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
    local r; r="$(record 2026-W41)"
    jq -e '[.components[] | select(.component == "synapse_db")] | .[0].status == "absent" and .[0].absent_reason == "error"' "$r"
    jq -e '.outcome.status == "failed" and .outcome.errored == ["synapse_db"]' "$r"
    # the log carries the cause, and it does not claim the container is not there
    [[ "$output" == *"lookup interrupted"* ]] || { echo "$output"; return 1; }
    [[ "$output" != *"no staging-state messaging-postgres container"* ]] || { echo "$output"; return 1; }
    # the other components were still measured
    grep -q 'component="log_volume"' "$(gauge)"
    run grep -c 'gremion_footprint_timestamp_seconds' "$(gauge)"
    [ "$output" = "0" ]
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
