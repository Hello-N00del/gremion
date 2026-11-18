#!/usr/bin/env bats
# test/host/cd-core.bats -- cd-core: the gremion-cd dispatcher, core.sh and
# cmd-state.sh (config, state, locks, heartbeat, clock, history, requests, blocks,
# holds, status, hold, resume).
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-core.bats
#
# Every address in this file is a reserved example name (example.org, 203.0.113.0/24).
# The program is run against a throwaway $GREMION_ROOT; docker, sudo and logger are
# shims, and every function another unit owns is a stub (test_helper/cd.bash).

load 'test_helper/host'
load 'test_helper/cd'

setup() { cd_setup; }
teardown() { cd_teardown; }

SHA_A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHA_B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@test "config: a valid cd.env parses, defaults fill the rest" {
    run cd_lib 'cd_cfg_load; echo "$(cd_cfg CD_REPO_URL)|$(cd_cfg CD_WATCH_MINUTES)|$(cd_cfg CD_PROOF_MODE)|$(cd_cfg CD_QUIET_WINDOWS)"'
    [ "$status" -eq 0 ]
    [ "$output" = "https://example.org/org/repo|20|0|01:45-03:15" ]
}

@test "config: surrounding quotes of a value are stripped, never evaluated" {
    cd_write_cfg 'CD_QUIET_WINDOWS="01:45-03:15"' "CD_POLICY_ACK='2026-11-14'"
    run cd_lib 'cd_cfg_load; echo "$(cd_cfg CD_QUIET_WINDOWS)|$(cd_cfg CD_POLICY_ACK)"'
    [ "$status" -eq 0 ]
    [ "$output" = "01:45-03:15|2026-11-14" ]
}

@test "config: an unknown key is exit 2 and the message names the key" {
    cd_write_cfg 'CD_NOT_A_KEY=1'
    run cd_lib 'cd_cfg_load'
    [ "$status" -eq 2 ]
    [[ "$output" == *CD_NOT_A_KEY* ]]
}

@test "config: a CHANGE_ME_OPERATOR_ value is exit 2" {
    cd_write_cfg 'CD_MAIL_TO=CHANGE_ME_OPERATOR_MAIL'
    run cd_lib 'cd_cfg_load'
    [ "$status" -eq 2 ]
    [[ "$output" == *CD_MAIL_TO* ]]
    cd_write_cfg 'CD_POLICY_ACK=CHANGE_ME_OPERATOR_ACK'
    run cd_lib 'cd_cfg_load'
    [ "$status" -eq 2 ]
}

@test "config: CD_PROOF_MODE defaults to 0, 0 and 1 are accepted, anything else is exit 2" {
    run cd_lib 'cd_cfg_load; cd_cfg CD_PROOF_MODE'
    [ "$output" = "0" ]
    cd_write_cfg 'CD_PROOF_MODE=1'
    run cd_lib 'cd_cfg_load; cd_cfg CD_PROOF_MODE'
    [ "$status" -eq 0 ]
    [ "$output" = "1" ]
    local bad
    for bad in 2 yes true '' ' 1'; do
        cd_write_cfg "CD_PROOF_MODE=${bad}"
        run cd_lib 'cd_cfg_load'
        [ "$status" -eq 2 ] || { echo "accepted CD_PROOF_MODE='${bad}'"; return 1; }
    done
}

@test "config: CD_HOST_LABEL is a label, never a host name, an address or 33 characters" {
    local good="pilot-01234567890123456789012345"
    [ "${#good}" -eq 32 ]
    cd_write_cfg "CD_HOST_LABEL=${good}"
    run cd_lib 'cd_cfg_load'
    [ "$status" -eq 0 ]
    local bad
    for bad in app.example.org 203.0.113.7 "${good}x" UPPER under_score ''; do
        cd_write_cfg "CD_HOST_LABEL=${bad}"
        run cd_lib 'cd_cfg_load'
        [ "$status" -eq 2 ] || { echo "accepted CD_HOST_LABEL='${bad}'"; return 1; }
    done
}

@test "config: CD_MAIL_TO is exactly one address (a list, a comma or a space is exit 2)" {
    local bad
    for bad in 'a@example.org,b@example.org' 'a@example.org b@example.org' 'a@example.org;b@example.org' \
               'a@example.org,' 'not-an-address' '' 'a@b'; do
        cd_write_cfg "CD_MAIL_TO=${bad}"
        run cd_lib 'cd_cfg_load'
        [ "$status" -eq 2 ] || { echo "accepted CD_MAIL_TO='${bad}'"; return 1; }
    done
    cd_write_cfg 'CD_MAIL_TO=one.person+cd@example.org'
    run cd_lib 'cd_cfg_load'
    [ "$status" -eq 0 ]
}

@test "config: the file is parsed, never sourced (a value with a command substitution creates nothing)" {
    cd_write_cfg 'CD_POLICY_ACK=$(touch /tmp/cd-core-pwned-$$)'
    cd_write_cfg "CD_POLICY_ACK=\$(touch ${GREMION_ROOT}/pwned)"
    run cd_lib 'cd_cfg_load; cd_cfg CD_POLICY_ACK'
    [ "$status" -eq 0 ]
    [ ! -e "${GREMION_ROOT}/pwned" ]
    [[ "$output" == *'$(touch '* ]]
}

@test "config: CD_LEAF_MIGRATE_TIMEOUT_S defaults to 600; a non-number or a value below 60 is exit 2" {
    run cd_lib 'cd_cfg_load; cd_cfg CD_LEAF_MIGRATE_TIMEOUT_S'
    [ "$output" = "600" ]
    local bad
    for bad in 59 0 abc -1 6.5 ''; do
        cd_write_cfg "CD_LEAF_MIGRATE_TIMEOUT_S=${bad}"
        run cd_lib 'cd_cfg_load'
        [ "$status" -eq 2 ] || { echo "accepted '${bad}'"; return 1; }
    done
    cd_write_cfg 'CD_LEAF_MIGRATE_TIMEOUT_S=60'
    run cd_lib 'cd_cfg_load; cd_cfg CD_LEAF_MIGRATE_TIMEOUT_S'
    [ "$status" -eq 0 ]
    [ "$output" = "60" ]
}

@test "config: CD_REPO_URL is required; the mail address and the host label are required unless mail is off" {
    local key
    for key in CD_REPO_URL CD_MAIL_TO CD_HOST_LABEL; do
        grep -v "^${key}=" "${CD_FIXTURES}/core/cd.env.valid" > "${GREMION_ROOT}/etc/cd.env"
        run cd_lib 'cd_cfg_load'
        [ "$status" -eq 2 ] || { echo "loaded without ${key}"; return 1; }
        [[ "$output" == *"$key"* ]]
    done
    # with mail off the two mail keys may be absent, the repository URL never
    grep -v '^CD_MAIL_TO=\|^CD_HOST_LABEL=' "${CD_FIXTURES}/core/cd.env.valid" > "${GREMION_ROOT}/etc/cd.env"
    printf 'CD_ALLOW_NO_MAIL=1\n' >> "${GREMION_ROOT}/etc/cd.env"
    run cd_lib 'cd_cfg_load; cd_cfg CD_ALLOW_NO_MAIL'
    [ "$status" -eq 0 ]
    [ "$output" = "1" ]
    grep -v '^CD_REPO_URL=' "${CD_FIXTURES}/core/cd.env.valid" > "${GREMION_ROOT}/etc/cd.env"
    printf 'CD_ALLOW_NO_MAIL=1\n' >> "${GREMION_ROOT}/etc/cd.env"
    run cd_lib 'cd_cfg_load'
    [ "$status" -eq 2 ]
}

@test "config: a missing file, a duplicate key and a line that is not KEY=VALUE are exit 2" {
    rm -f "${GREMION_ROOT}/etc/cd.env"
    run cd_lib 'cd_cfg_load'
    [ "$status" -eq 2 ]
    cd_write_cfg
    printf 'CD_HOST_LABEL=other\n' >> "${GREMION_ROOT}/etc/cd.env"
    run cd_lib 'cd_cfg_load'
    [ "$status" -eq 2 ]
    cd_write_cfg
    printf 'this is not a setting\n' >> "${GREMION_ROOT}/etc/cd.env"
    run cd_lib 'cd_cfg_load'
    [ "$status" -eq 2 ]
}

@test "config: cd_cfg before cd_cfg_load, and for an unknown key, fails closed" {
    run cd_lib 'cd_cfg CD_WATCH_MINUTES'
    [ "$status" -eq 2 ]
    run cd_lib 'cd_cfg_load; cd_cfg CD_NO_SUCH_KEY'
    [ "$status" -eq 2 ]
}

@test "config: an operator value that is not an https URL / host / path is exit 2" {
    local kv
    for kv in 'CD_REPO_URL=http://example.org/org/repo' 'CD_REPO_URL=https://' 'CD_PING_URL=ftp://example.org/x' \
              'CD_PROBE_HOST=app example.org' 'CD_GITHUB_TOKEN_FILE=relative/path' 'CD_QUIET_WINDOWS=25:00-26:00' \
              'CD_ALIVE_HOUR=24' 'CD_DUMP_POLICY=never'; do
        cd_write_cfg "$kv"
        run cd_lib 'cd_cfg_load'
        [ "$status" -eq 2 ] || { echo "accepted ${kv%%=*}"; return 1; }
    done
}

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

@test "state: cd_state_init writes schema v1, phase idle, mode 0600" {
    cd_need_flock
    run cd_lib 'cd_lock_take; cd_state_init; cd_state_get ".v"; cd_state_get ".phase"; stat -c %a "$CD_STATE_FILE"'
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "1" ]
    [ "${lines[1]}" = "idle" ]
    [ "${lines[2]}" = "600" ]
}

@test "state: cd_state_init refuses to overwrite an existing state" {
    cd_need_flock
    cd_seed_state '.phase = "parked"'
    run cd_lib 'cd_lock_take; cd_state_init'
    [ "$status" -ne 0 ]
    run cd_lib 'cd_state_get ".phase"'
    [ "$output" = "parked" ]
}

@test "state: an unknown schema version is exit 2 and writes data/cd/ALERT through cd_alert" {
    cd_seed_state '.v = 2'
    shim logger
    run cd_lib 'cd_state_get ".phase"'
    [ "$status" -eq 2 ]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
    [ "$(wc -l < "${GREMION_ROOT}/data/cd/ALERT")" -le 1 ]
    grep -q '^logger ' "$SHIM_LOG"
}

@test "state: an unparseable state file is exit 2 and an alert" {
    printf '{ not json' > "${GREMION_ROOT}/data/cd/state.json"
    run cd_lib 'cd_state_get ".phase"'
    [ "$status" -eq 2 ]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
}

@test "state: a missing state file is exit 2 (fail closed), not an empty answer" {
    run cd_lib 'cd_state_get ".phase"'
    [ "$status" -eq 2 ]
}

@test "state: cd_state_set is atomic (a kill between the write and the rename leaves the old file intact)" {
    cd_need_flock
    cd_seed_state
    # control: the same write without the kill goes through
    run cd_lib 'cd_lock_take; cd_state_set ".poll.tip12 = \"0123456789ab\""'
    [ "$status" -eq 0 ]
    cd_seed_state
    local before
    before="$(sha256sum "${GREMION_ROOT}/data/cd/state.json")"
    # mv that kills its parent (the bash running cd_state_set) before it renames
    shim mv 'kill -9 "$PPID"'
    run cd_lib 'cd_lock_take; cd_state_set ".phase = \"releasing\""'
    [ "$status" -ne 0 ]
    rm -f "${SHIM_DIR}/mv"
    [ "$(sha256sum "${GREMION_ROOT}/data/cd/state.json")" = "$before" ]
    run jq -r .phase "${GREMION_ROOT}/data/cd/state.json"
    [ "$output" = "idle" ]
    [ "$(stat -c %a "${GREMION_ROOT}/data/cd/state.json")" = "600" ]
}

@test "state: cd_state_set applies a filter with --arg and --argjson, mode stays 0600" {
    cd_need_flock
    cd_seed_state
    run cd_lib 'cd_lock_take
cd_state_set ".phase = \$p | .poll.api_calls_hour = \$n | .poll.tip12 = \$t" --arg p releasing --argjson n 7 --arg t 0123456789ab
cd_state_get ".phase"; cd_state_get ".poll.api_calls_hour"; cd_state_get ".poll.tip12"; stat -c %a "$CD_STATE_FILE"'
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "releasing" ]
    [ "${lines[1]}" = "7" ]
    [ "${lines[2]}" = "0123456789ab" ]
    [ "${lines[3]}" = "600" ]
}

@test "state: a jq filter that breaks the schema is refused and the file is unchanged" {
    cd_need_flock
    cd_seed_state
    # control: a filter that keeps the schema is applied
    run cd_lib 'cd_lock_take; cd_state_set ".phase = \"parked\""'
    [ "$status" -eq 0 ]
    cd_seed_state
    local before
    before="$(sha256sum "${GREMION_ROOT}/data/cd/state.json")"
    local f
    for f in '.phase = "dancing"' '.v = 2' 'del(.phase)' '.extra = 1' '.hold = {"kind":"nonsense","reason":"x","sha12":"","since":"t"}' \
             '.poll.verdict = "maybe"' '.release = {"id":"x"}' 'empty' '., .'; do
        run cd_lib 'cd_lock_take; cd_state_set "$1"' "$f"
        [ "$status" -ne 0 ] || { echo "accepted: $f"; return 1; }
        [ "$(sha256sum "${GREMION_ROOT}/data/cd/state.json")" = "$before" ] || { echo "changed by: $f"; return 1; }
    done
}

@test "state: a second writer without the cd lock is refused" {
    cd_need_flock
    cd_seed_state
    # nobody holds the lock and this process never took it: refused
    run cd_lib 'cd_state_set ".phase = \"releasing\""'
    [ "$status" -ne 0 ]
    run jq -r .phase "${GREMION_ROOT}/data/cd/state.json"
    [ "$output" = "idle" ]
    # another process holds the lock: refused as well
    cd_bg 'cd_lock_take; echo ready; exec sleep 300'
    run cd_lib 'cd_state_set ".phase = \"releasing\""'
    [ "$status" -ne 0 ]
    run jq -r .phase "${GREMION_ROOT}/data/cd/state.json"
    [ "$output" = "idle" ]
}

@test "state: every hold kind and every phase of the schema is accepted, any other is refused" {
    cd_need_flock
    cd_seed_state
    local kind phase
    for kind in operator blocked state_tier unsupported_chain contract_migration waived_migration ci_changed \
                chain_class_changed batch_too_large not_ancestor ruleset_missing range_unverified classify_failed \
                failure proof rollback_failed killswitch stuck_stage reconcile_failed; do
        run cd_lib 'cd_lock_take; cd_hold_set "$1" some_reason 0123456789ab; cd_state_get ".hold.kind"' "$kind"
        [ "$status" -eq 0 ] || { echo "kind refused: $kind"; return 1; }
        [ "$output" = "$kind" ]
    done
    for phase in idle releasing watching rolling_back parked; do
        run cd_lib 'cd_lock_take; cd_state_set ".phase = \$p" --arg p "$1"; cd_state_get ".phase"' "$phase"
        [ "$status" -eq 0 ] || { echo "phase refused: $phase"; return 1; }
    done
    run cd_lib 'cd_lock_take; cd_hold_set not_a_kind r ""'
    [ "$status" -ne 0 ]
    run cd_lib 'cd_lock_take; cd_state_set ".phase = \$p" --arg p sleeping'
    [ "$status" -ne 0 ]
}

@test "state: hold_clear empties the hold; hold_set records kind, reason, sha12 and a time" {
    cd_need_flock
    cd_seed_state
    run cd_lib 'cd_lock_take; cd_hold_set blocked build_failed 0123456789ab
cd_state_get ".hold.kind"; cd_state_get ".hold.reason"; cd_state_get ".hold.sha12"; cd_state_get ".hold.since"
cd_hold_clear; cd_state_get ".hold"'
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "blocked" ]
    [ "${lines[1]}" = "build_failed" ]
    [ "${lines[2]}" = "0123456789ab" ]
    [ "${lines[3]}" = "2023-11-14T22:13:20Z" ]
    [ "${lines[4]}" = "null" ]
}

@test "state schema: release.leaves and live.leaves are null or exactly the four counts, nothing else" {
    cd_need_flock
    cd_seed_state ".live = ${CD_LIVE_JSON}"
    run cd_lib 'cd_lock_take; cd_state_set ".live.leaves = {\"total\":3,\"migrated\":2,\"skipped\":1,\"failed\":0}"; cd_state_get ".live.leaves.total"'
    [ "$status" -eq 0 ]
    [ "$output" = "3" ]
    run cd_lib 'cd_lock_take; cd_state_set ".live.leaves = null"'
    [ "$status" -eq 0 ]
    local bad
    for bad in '{"total":3,"migrated":2,"skipped":1,"failed":0,"name":"cal"}' \
               '{"total":3,"migrated":2,"skipped":1}' \
               '{"total":3,"migrated":2,"skipped":1,"failed":"0"}' \
               '{"total":3,"migrated":-2,"skipped":1,"failed":0}' \
               '["calendar"]'; do
        run cd_lib 'cd_lock_take; cd_state_set ".live.leaves = \$x" --argjson x "$1"' "$bad"
        [ "$status" -ne 0 ] || { echo "accepted live.leaves = $bad"; return 1; }
    done
}

@test "state schema: the release record accepts leaves, modules, workers, watch; a name field is refused" {
    cd_need_flock
    cd_seed_state
    local rel='{"id":"0123456789ab-1","sha":"0123456789abcdef0123456789abcdef01234567","sha12":"0123456789ab","tag":"pilot-0123456789ab","colour":"green","tree":"/opt/gremion/releases/0123456789ab","from_sha12":"aaaaaaaaaaaa","mode":"auto","with_state":false,"stage":"migrate","stage_status":"started","attempt":1,"class":{},"dump_label":null,"rollback_target":"ok","retag_prev":null,"workers":"off","modules":{"total":2,"upgraded":1,"unchanged":1,"skipped":0,"failed":0,"files_applied":3},"leaves":{"total":3,"migrated":3,"skipped":0,"failed":0},"switch_started":false,"commit_attempts":0,"committed_at":null,"timing":{"snapshot_s":10,"module_s":20},"started_at":"2026-11-17T01:00:00Z","switched_at":null,"watch":{"observed_s":0,"samples":0,"bad_streak":0,"paused_s":0,"blind":0,"requests":0,"baseline_5xx":null,"baseline_not_ready":null,"last_sample_epoch":0},"failure":null}'
    run cd_lib 'cd_lock_take; cd_state_set ".phase = \"releasing\" | .release = \$r" --argjson r "$1"; cd_state_get ".release.leaves.migrated"' "$rel"
    [ "$status" -eq 0 ]
    [ "$output" = "3" ]
    local bad
    bad="$(printf '%s' "$rel" | jq -c '.leaves.name = "calendar"')"
    run cd_lib 'cd_lock_take; cd_state_set ".release = \$r" --argjson r "$1"' "$bad"
    [ "$status" -ne 0 ]
    bad="$(printf '%s' "$rel" | jq -c '.stage = "teleport"')"
    run cd_lib 'cd_lock_take; cd_state_set ".release = \$r" --argjson r "$1"' "$bad"
    [ "$status" -ne 0 ]
    bad="$(printf '%s' "$rel" | jq -c '.failure = {"kind":"nonsense","stage":"x","code":"1","at":"t"}')"
    run cd_lib 'cd_lock_take; cd_state_set ".release = \$r" --argjson r "$1"' "$bad"
    [ "$status" -ne 0 ]
}

@test "state schema: live.reconcile is the counts and a reason code, no slug field" {
    cd_need_flock
    cd_seed_state ".live = ${CD_LIVE_JSON}"
    local good='{"at":"2026-11-17T02:00:00Z","total":3,"ok":3,"failed":0,"timeout":0,"busy":0,"skipped":0,"invalid":0,"seconds":41,"reason":null}'
    run cd_lib 'cd_lock_take; cd_state_set ".live.reconcile = \$x" --argjson x "$1"' "$good"
    [ "$status" -eq 0 ]
    local bad
    bad="$(printf '%s' "$good" | jq -c '.slugs = ["x"]')"
    run cd_lib 'cd_lock_take; cd_state_set ".live.reconcile = \$x" --argjson x "$1"' "$bad"
    [ "$status" -ne 0 ]
}

@test "stages: begin, ok and fail write the stage and its status; a stage outside the enum is refused" {
    cd_need_flock
    cd_seed_state
    local rel='{"id":"0123456789ab-1","sha":"0123456789abcdef0123456789abcdef01234567","sha12":"0123456789ab","tag":"pilot-0123456789ab","colour":"green","tree":"/t","mode":"auto","stage":"select","stage_status":"ok","attempt":1}'
    run cd_lib 'cd_lock_take; cd_state_set ".phase = \"releasing\" | .release = \$r" --argjson r "$1"
cd_stage_begin build; cd_state_get ".release.stage + \"/\" + .release.stage_status"
cd_stage_ok build; cd_state_get ".release.stage + \"/\" + .release.stage_status"
cd_stage_fail build commit 1; cd_state_get ".release.stage_status + \"/\" + .release.failure.kind + \"/\" + .release.failure.stage + \"/\" + .release.failure.code"' "$rel"
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "build/started" ]
    [ "${lines[1]}" = "build/ok" ]
    [ "${lines[2]}" = "failed/commit/build/1" ]
    run cd_lib 'cd_lock_take; cd_stage_begin teleport'
    [ "$status" -ne 0 ]
    run cd_lib 'cd_lock_take; cd_stage_fail build nonsense 1'
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# Locks
# ---------------------------------------------------------------------------

@test "locks: a second cd_lock_take exits 3 while the first holder lives" {
    cd_need_flock
    cd_bg 'cd_lock_take; echo ready; exec sleep 300'
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 3 ]
}

@test "locks: the cd lock is released when the holder is killed with -9" {
    cd_need_flock
    cd_bg 'cd_lock_take; echo ready; exec sleep 300'
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 3 ]
    kill -9 "$CD_BG_PID"
    wait "$CD_BG_PID" 2>/dev/null || true
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 0 ]
}

@test "locks: taking the cd lock twice in one process keeps it (the re-open does not free it)" {
    cd_need_flock
    cd_bg 'cd_lock_take; cd_lock_take; echo ready; exec sleep 300'
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 3 ]
}

@test "locks: cd_hostlock_take waits the given seconds, then returns 3" {
    cd_need_flock
    cd_bg 'cd_hostlock_take; echo ready; exec sleep 300'
    local t0=$SECONDS
    run cd_lib 'cd_hostlock_take 2'
    [ "$status" -eq 3 ]
    [ $((SECONDS - t0)) -ge 2 ]
    [ $((SECONDS - t0)) -le 8 ]
}

@test "locks: cd_hostlock_take takes the lock once the holder lets go inside the wait" {
    cd_need_flock
    hold_host_lock 2
    run cd_lib 'cd_hostlock_take 6'
    [ "$status" -eq 0 ]
}

@test "locks: cd_hostlock_release frees the host lock and keeps the cd lock" {
    cd_need_flock
    cd_bg 'cd_lock_take; cd_hostlock_take; cd_hostlock_release; echo ready; exec sleep 300'
    run cd_lib 'cd_hostlock_take'
    [ "$status" -eq 0 ]
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 3 ]
}

@test "locks: cd_locks_release frees both" {
    cd_need_flock
    cd_bg 'cd_lock_take; cd_hostlock_take; cd_locks_release; echo ready; exec sleep 300'
    run cd_lib 'cd_hostlock_take; cd_lock_take'
    [ "$status" -eq 0 ]
}

@test "locks: GREMION_HOST_LOCK_HELD=1 is exported while CD holds the host lock and only then" {
    cd_need_flock
    run cd_lib 'echo "before=${GREMION_HOST_LOCK_HELD:-unset}"; cd_hostlock_take
bash -c "echo during=\${GREMION_HOST_LOCK_HELD:-unset}"; cd_hostlock_release; echo "after=${GREMION_HOST_LOCK_HELD:-unset}"'
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "before=unset" ]
    [ "${lines[1]}" = "during=1" ]
    [ "${lines[2]}" = "after=unset" ]
}

@test "locks: cd_release_committed is true only when release.committed_at is set" {
    cd_seed_state
    run cd_lib 'cd_release_committed'
    [ "$status" -ne 0 ]
    local rel='{"id":"0123456789ab-1","sha":"0123456789abcdef0123456789abcdef01234567","sha12":"0123456789ab","tag":"pilot-0123456789ab","colour":"green","tree":"/t","mode":"auto","stage":"commit","stage_status":"started","attempt":1,"committed_at":null}'
    cd_seed_state ".phase = \"watching\" | .release = ${rel}"
    run cd_lib 'cd_release_committed'
    [ "$status" -ne 0 ]
    cd_seed_state ".phase = \"watching\" | .release = (${rel} | .committed_at = \"2026-11-17T02:00:00Z\")"
    run cd_lib 'cd_release_committed'
    [ "$status" -eq 0 ]
}

@test "locks: an unreadable state stops the program inside cd_release_committed (never the not-committed branch)" {
    cd_seed_state '.v = 9'
    run cd_lib 'if cd_release_committed; then echo yes; else echo no; fi; echo survived'
    [ "$status" -eq 2 ]
    printf '%s\n' "$output" > "${GREMION_ROOT}/.out"
    run grep -qxE 'yes|no|survived' "${GREMION_ROOT}/.out"
    [ "$status" -ne 0 ]
    printf '{ not json' > "${GREMION_ROOT}/data/cd/state.json"
    run cd_lib 'if cd_release_committed; then echo yes; else echo no; fi; echo survived'
    [ "$status" -eq 2 ]
    [[ "$output" != *survived* ]]
    rm -f "${GREMION_ROOT}/data/cd/state.json"
    run cd_lib 'if cd_release_committed; then echo yes; else echo no; fi; echo survived'
    [ "$status" -eq 2 ]
    [[ "$output" != *survived* ]]
}

# ---------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------

hb_field() { awk -v n="$1" '{print $n}' "${GREMION_ROOT}/runtime/cd/heartbeat"; }

hb_wait_epoch() {
    # hb_wait_epoch EPOCH -- the beat file shows EPOCH within 3 seconds
    local i
    for i in $(seq 1 30); do
        [[ "$(hb_field 1 2>/dev/null)" == "$1" ]] && return 0
        sleep 0.1
    done
    echo "heartbeat stayed at $(hb_field 1), wanted $1" >&2
    return 1
}

@test "heartbeat: cd_heartbeat_start writes six fields and rewrites them every 30 seconds on the fake clock" {
    cd_need_flock
    cd_seed_state
    cd_bg 'cd_heartbeat_start build 600; echo ready; exec sleep 300'
    local f
    f="$(cat "${GREMION_ROOT}/runtime/cd/heartbeat")"
    [ "$(wc -w <<< "$f")" -eq 6 ]
    [ "$(hb_field 1)" = "1700000000" ]
    [ "$(hb_field 2)" = "idle" ]
    [ "$(hb_field 3)" = "build" ]
    [ "$(hb_field 4)" = "1700000000" ]
    [ "$(hb_field 5)" = "600" ]
    [ "$(hb_field 6)" = "$CD_BG_PID" ]
    # 29 seconds later nothing is rewritten, 30 seconds later it is
    cd_advance 29
    sleep 0.5
    [ "$(hb_field 1)" = "1700000000" ]
    cd_advance 1
    hb_wait_epoch 1700000030
    [ "$(hb_field 4)" = "1700000000" ]
}

@test "heartbeat: the beat subshell has neither lock file open (looked at in /proc), and a child of it neither" {
    cd_need_flock
    cd_seed_state
    # a slow poll, so the beat is certainly still alive when /proc is read
    GREMION_CD_HB_POLL_S=30 cd_bg 'cd_lock_take; cd_hostlock_take; cd_heartbeat_start build 600; echo "hb=$CD_HB_PID"; echo ready; exec sleep 300'
    local hb
    hb="$(sed -n 's/^hb=//p' "$CD_BG_OUT")"
    [[ "$hb" =~ ^[0-9]+$ ]]
    [ -d "/proc/${hb}/fd" ]
    local fd target
    for fd in /proc/"${hb}"/fd/*; do
        target="$(readlink "$fd" || true)"
        [[ "$target" != *cd.lock* && "$target" != *hostd.lock* ]] || { echo "the beat holds ${target}"; return 1; }
    done
    # the control: the parent does hold both
    local held=0
    for fd in /proc/"${CD_BG_PID}"/fd/*; do
        target="$(readlink "$fd" || true)"
        [[ "$target" == *cd.lock* || "$target" == *hostd.lock* ]] && held=$((held + 1))
    done
    [ "$held" -eq 2 ]
}

@test "heartbeat: the beat subshell holds neither fd 8 nor fd 9 and stops after the parent is killed" {
    cd_need_flock
    cd_seed_state
    cd_bg 'cd_lock_take; cd_hostlock_take; cd_heartbeat_start build 600; echo ready; exec sleep 300'
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 3 ]
    run cd_lib 'cd_hostlock_take'
    [ "$status" -eq 3 ]
    kill -9 "$CD_BG_PID"
    wait "$CD_BG_PID" 2>/dev/null || true
    # the locks are free at once, although the beat subshell has not noticed yet
    run cd_lib 'cd_lock_take; cd_hostlock_take'
    [ "$status" -eq 0 ]
    # and the beat stops: advance the clock past one interval, the file does not move
    sleep 0.5
    cd_advance 60
    sleep 0.6
    [ "$(hb_field 1)" = "1700000000" ]
}

@test "heartbeat: the beat stops after budget x 1.25 + 120 seconds even when the parent lives" {
    cd_need_flock
    cd_seed_state
    cd_bg 'cd_heartbeat_start build 100; echo ready; exec sleep 300'
    # limit = 100 + 25 + 120 = 245 s: still beating at +240, silent after +246
    cd_advance 240
    hb_wait_epoch 1700000240
    cd_advance 6
    sleep 0.6
    cd_advance 60
    sleep 0.6
    [ "$(hb_field 1)" = "1700000240" ]
    kill -0 "$CD_BG_PID"
}

@test "heartbeat: cd_heartbeat_stop ends the beat" {
    cd_need_flock
    cd_seed_state
    cd_bg 'cd_heartbeat_start build 600; cd_heartbeat_stop; echo ready; exec sleep 300'
    sleep 0.3
    cd_advance 60
    sleep 0.5
    [ "$(hb_field 1)" = "1700000000" ]
}

@test "heartbeat: a bad stage or budget is exit 2 and writes nothing" {
    run cd_lib 'cd_heartbeat_start "bad stage" 60'
    [ "$status" -eq 2 ]
    run cd_lib 'cd_heartbeat_start build soon'
    [ "$status" -eq 2 ]
    [ ! -e "${GREMION_ROOT}/runtime/cd/heartbeat" ]
}

# ---------------------------------------------------------------------------
# Clock
# ---------------------------------------------------------------------------

@test "clock: the fake clock is honoured with GREMION_CD_TESTING=1" {
    run cd_lib 'cd_now; cd_iso'
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "1700000000" ]
    [ "${lines[1]}" = "2023-11-14T22:13:20Z" ]
    run cd_lib 'cd_iso 0'
    [ "$output" = "1970-01-01T00:00:00Z" ]
}

@test "clock: without GREMION_CD_TESTING=1 the fake clock is ignored" {
    local real
    real="$(date +%s)"
    GREMION_CD_NOW=1700000000 run env -u GREMION_CD_TESTING bash -c '
        set -euo pipefail
        . "${HOST_SRC}/lib/common.sh"; . "${HOST_SRC}/lib/cd/core.sh"
        cd_now'
    [ "$status" -eq 0 ]
    [ "$output" -ge "$real" ]
    [ "$output" -le $((real + 30)) ]
    run env GREMION_CD_TESTING=0 bash -c '
        set -euo pipefail
        . "${HOST_SRC}/lib/common.sh"; . "${HOST_SRC}/lib/cd/core.sh"
        cd_now'
    [ "$output" -ge "$real" ]
}

@test "clock: a fake clock that is not an epoch is an error, not a silent real clock" {
    run cd_lib 'cd_now'
    [ "$output" = "1700000000" ]
    printf 'soon\n' > "$GREMION_CD_NOW_FILE"
    run cd_lib 'cd_now'
    [ "$status" -ne 0 ]
}

@test "clock: cd_sleep advances the fake clock instead of sleeping" {
    local t0=$SECONDS
    run cd_lib 'cd_sleep 900; cd_now'
    [ "$status" -eq 0 ]
    [ "$output" = "1700000900" ]
    [ $((SECONDS - t0)) -le 5 ]
}

# ---------------------------------------------------------------------------
# History and scrubbing
# ---------------------------------------------------------------------------

@test "hist: cd_hist writes one valid JSON line with the time, the event and the pairs" {
    run cd_lib 'cd_hist stage_ok stage=build seconds=12 colour=blue'
    [ "$status" -eq 0 ]
    local f="${GREMION_ROOT}/data/cd/history.jsonl"
    [ "$(wc -l < "$f")" -eq 1 ]
    run jq -r '[.at, .event, .stage, (.seconds|type), .colour] | join(" ")' "$f"
    [ "$output" = "2023-11-14T22:13:20Z stage_ok build number blue" ]
}

@test "hist: a value with a newline is refused, nothing is written" {
    run cd_lib 'cd_hist fine ok=1'
    [ "$status" -eq 0 ]
    : > "${GREMION_ROOT}/data/cd/history.jsonl"
    run cd_lib 'cd_hist note "line one
line two"'
    [ "$status" -ne 0 ]
    [ ! -s "${GREMION_ROOT}/data/cd/history.jsonl" ]
}

@test "hist: a bad event or key name is refused; an address-shaped value is stored redacted" {
    run cd_lib 'cd_hist "bad event"'
    [ "$status" -ne 0 ]
    run cd_lib 'cd_hist ok "Bad Key=1"'
    [ "$status" -ne 0 ]
    run cd_lib 'cd_hist ok detail=ops@example.org'
    [ "$status" -eq 0 ]
    run jq -r .detail "${GREMION_ROOT}/data/cd/history.jsonl"
    [ "$output" = "<redacted>" ]
}

@test "scrub: an address, an IPv4, an IPv6, a URL with a host and a /home path are redacted" {
    local v
    for v in 'ops@example.org' 'mail ops@example.org now' '203.0.113.7' 'at 203.0.113.7:8080' '2001:db8::1' \
             '2001:0db8:0000:0000:0000:0000:0000:0001' '::1' 'https://app.example.org/x' 'ssh://example.org' \
             '/home/deploy/x' 'in /home/deploy'; do
        run cd_lib 'cd_scrub_value "$1"' "$v"
        [ "$status" -eq 0 ]
        [ "$output" = "<redacted>" ] || { echo "not redacted: ${v} -> ${output}"; return 1; }
    done
}

@test "scrub: blue, a tag, a number, a time and a code pass untouched" {
    local v
    for v in blue pilot-0123456789ab 12 '2026-11-17T01:45:00Z' 'watch_5xx' 'chain_class_changed:platform' 'a /homeless value'; do
        run cd_lib 'cd_scrub_value "$1"' "$v"
        [ "$status" -eq 0 ]
        [ "$output" = "$v" ] || { echo "changed: ${v} -> ${output}"; return 1; }
    done
}

# ---------------------------------------------------------------------------
# ALERT
# ---------------------------------------------------------------------------

@test "alert: cd_alert writes a one-line ALERT file (scrubbed) and a logger line" {
    shim logger
    run cd_lib 'cd_alert "state broke for ops@example.org
second line"'
    [ "$status" -eq 0 ]
    local f="${GREMION_ROOT}/data/cd/ALERT"
    [ -s "$f" ]
    [ "$(wc -l < "$f")" -eq 1 ]
    run grep -q 'example.org' "$f"
    [ "$status" -ne 0 ]
    grep -q '^logger ' "$SHIM_LOG"
}

@test "alert: cd_alert still writes the file when there is no logger" {
    run cd_lib 'cd_alert "no logger here"'
    [ "$status" -eq 0 ]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
}

# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------

@test "requests: put writes mode 0600 and next returns them FIFO, moving each to processed/" {
    cd_need_flock
    run cd_lib 'cd_request_put hold "{\"reason\":\"one\"}"; cd_request_put resume "{\"reason\":\"two\"}"; cd_request_put hold "{\"reason\":\"three\"}"'
    [ "$status" -eq 0 ]
    local f
    for f in "${GREMION_ROOT}"/runtime/cd/requests/*.json; do
        [ "$(stat -c %a "$f")" = "600" ]
    done
    [ "$(ls "${GREMION_ROOT}/runtime/cd/requests" | grep -c json)" -eq 3 ]
    run cd_lib 'cd_request_next | jq -r "[.verb, .args.reason, .v] | join(\" \")"
cd_request_next | jq -r "[.verb, .args.reason] | join(\" \")"
cd_request_next | jq -r "[.verb, .args.reason] | join(\" \")"
if cd_request_next; then echo more; else echo none; fi'
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "hold one 1" ]
    [ "${lines[1]}" = "resume two" ]
    [ "${lines[2]}" = "hold three" ]
    [ "${lines[3]}" = "none" ]
    [ "$(ls "${GREMION_ROOT}/runtime/cd/requests/processed" | wc -l)" -eq 3 ]
}

@test "requests: a request carries the verb, the args, a time and who asked" {
    run cd_lib 'cd_request_put hold "{\"reason\":\"r\"}"; cd_request_next | jq -r "[.verb, .at, (.by|type)] | join(\" \")"'
    [ "$status" -eq 0 ]
    [ "$output" = "hold 2023-11-14T22:13:20Z string" ]
}

@test "requests: a malformed request file is moved aside and logged, never executed" {
    local d="${GREMION_ROOT}/runtime/cd/requests"
    mkdir -p "$d"
    printf '{ broken' > "${d}/1700000000-hold.json"
    printf '{"v":2,"verb":"hold","args":{},"at":"t","by":"x"}' > "${d}/1700000001-hold.json"
    printf '{"v":1,"verb":"Bad Verb","args":{},"at":"t","by":"x"}' > "${d}/1700000002-x.json"
    printf '{"v":1,"verb":"hold","args":"notanobject","at":"t","by":"x"}' > "${d}/1700000003-hold.json"
    run cd_lib 'cd_request_put resume "{}"; cd_request_next | jq -r .verb; if cd_request_next; then echo more; else echo none; fi'
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "resume" ]
    [ "${lines[1]}" = "none" ]
    [ "$(ls "${d}/rejected" | wc -l)" -eq 4 ]
    [ "$(grep -c request_rejected "${GREMION_ROOT}/data/cd/history.jsonl")" -eq 4 ]
}

@test "requests: a symlink in the request directory is not followed" {
    local d="${GREMION_ROOT}/runtime/cd/requests"
    mkdir -p "$d"
    printf '{"v":1,"verb":"hold","args":{},"at":"t","by":"x"}' > "${GREMION_ROOT}/outside.json"
    ln -s "${GREMION_ROOT}/outside.json" "${d}/1700000000-hold.json"
    run cd_lib 'if cd_request_next; then echo executed; else echo none; fi'
    [ "$output" = "none" ]
}

@test "requests: the same second keeps the order" {
    run cd_lib 'for i in 1 2 3 4 5 6 7 8 9 10 11; do cd_request_put hold "{\"n\":$i}"; done
for i in 1 2 3 4 5 6 7 8 9 10 11; do cd_request_next | jq -r .args.n; done | tr "\n" " "'
    [ "$status" -eq 0 ]
    [ "$output" = "1 2 3 4 5 6 7 8 9 10 11 " ]
}

# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------

@test "blocks: add, the open list, is_blocked and clear all with a reason that is logged" {
    cd_need_flock
    run cd_lib 'cd_lock_take
cd_block_add '"$SHA_A"' build_failed "image build"
cd_block_add '"$SHA_B"' watch_5xx "five hundreds"
cd_block_open_list | cut -d" " -f1,2
if cd_is_blocked '"$SHA_A"'; then echo A-blocked; fi
if cd_is_blocked cccccccccccccccccccccccccccccccccccccccc; then echo C-blocked; else echo C-free; fi'
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "${SHA_A} build_failed" ]
    [ "${lines[1]}" = "${SHA_B} watch_5xx" ]
    [ "${lines[2]}" = "A-blocked" ]
    [ "${lines[3]}" = "C-free" ]
    [ "$(stat -c %a "${GREMION_ROOT}/data/cd/blocked.json")" = "600" ]
    run cd_lib 'cd_lock_take; cd_block_clear_all "operator accepted the descendants"; echo "open=$(cd_block_open_list | wc -l)"'
    [ "$status" -eq 0 ]
    [ "$output" = "open=0" ]
    run jq -r '[.[] | .cleared.reason] | unique | join("|")' "${GREMION_ROOT}/data/cd/blocked.json"
    [ "$output" = "operator accepted the descendants" ]
    run jq -r 'select(.event=="blocks_cleared") | .reason' "${GREMION_ROOT}/data/cd/history.jsonl"
    [ "$output" = "operator accepted the descendants" ]
}

@test "blocks: a bad sha, a bad rule or a clear without a reason is refused" {
    cd_need_flock
    run cd_lib 'cd_lock_take; cd_block_add '"$SHA_A"' build_failed x; cd_block_open_list | wc -l'
    [ "$output" = "1" ]
    rm -f "${GREMION_ROOT}/data/cd/blocked.json"
    run cd_lib 'cd_lock_take; cd_block_add notasha build_failed x'
    [ "$status" -ne 0 ]
    run cd_lib 'cd_lock_take; cd_block_add '"$SHA_A"' made_up_rule x'
    [ "$status" -ne 0 ]
    run cd_lib 'cd_lock_take; cd_block_clear_all ""'
    [ "$status" -ne 0 ]
    [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
}

@test "blocks: a write without the cd lock is refused" {
    cd_need_flock
    run cd_lib 'cd_lock_take; cd_block_add '"$SHA_A"' build_failed x'
    [ "$status" -eq 0 ]
    rm -f "${GREMION_ROOT}/data/cd/blocked.json"
    run cd_lib 'cd_block_add '"$SHA_A"' build_failed x'
    [ "$status" -ne 0 ]
    [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
}

@test "blocks: the same commit is not blocked twice while its block is open" {
    cd_need_flock
    run cd_lib 'cd_lock_take; cd_block_add '"$SHA_A"' build_failed x; cd_block_add '"$SHA_A"' watch_5xx y; cd_block_open_list | wc -l'
    [ "$status" -eq 0 ]
    [ "$output" = "1" ]
}

@test "blocks: cd_contains_open_block is true for a descendant (and the block itself), false otherwise" {
    cd_need_flock
    cd_git_fixture
    run cd_lib 'cd_lock_take; cd_block_add "$1" build_failed x
for c in "$2" "$1" "$3" "$4"; do if cd_contains_open_block "$c"; then echo yes; else echo no; fi; done' "$C2" "$C3" "$C1" "$D1"
    # C3 descends from C2: yes. C2 is the block: yes. C1 is the parent: no. D1 branches off C1: no.
    [ "$status" -eq 0 ]
    [ "${lines[0]}" = "yes" ]
    [ "${lines[1]}" = "yes" ]
    [ "${lines[2]}" = "no" ]
    [ "${lines[3]}" = "no" ]
}

@test "blocks: an unreadable block list stops the program (never 'not blocked')" {
    cd_need_flock
    run cd_lib 'cd_lock_take; cd_block_add '"$SHA_A"' build_failed x'
    [ "$status" -eq 0 ]
    run cd_lib 'if cd_is_blocked '"$SHA_A"'; then echo blocked; else echo free; fi; echo survived'
    [ "$output" = "$(printf 'blocked\nsurvived')" ]
    printf '{ not json' > "${GREMION_ROOT}/data/cd/blocked.json"
    run cd_lib 'if cd_is_blocked '"$SHA_A"'; then echo blocked; else echo free; fi; echo survived'
    [ "$status" -eq 2 ]
    [[ "$output" != *free* ]]
    [[ "$output" != *survived* ]]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
}

@test "blocks: a block whose commit is not in the mirror counts as contained (unknown is not green)" {
    cd_need_flock
    cd_git_fixture
    run cd_lib 'cd_lock_take; cd_block_add '"$SHA_A"' build_failed x; if cd_contains_open_block "$1"; then echo yes; else echo no; fi' "$C3"
    [ "$output" = "yes" ]
    rm -rf "${GREMION_ROOT}/data/cd/mirror.git"
    run cd_lib 'if cd_contains_open_block "$1"; then echo yes; else echo no; fi' "$C3"
    [ "$output" = "yes" ]
}

@test "blocks: with no open block nothing is contained" {
    cd_git_fixture
    run cd_lib 'if cd_contains_open_block "$1"; then echo yes; else echo no; fi' "$C3"
    [ "$output" = "no" ]
}

@test "blocks: cd_block_close_superseded closes the blocks the committed release contains, only those" {
    cd_need_flock
    cd_git_fixture
    run cd_lib 'cd_lock_take
cd_block_add "$1" build_failed x     # C2: contained in C3
cd_block_add "$2" watch_5xx y        # D1: not contained in C3
cd_block_close_superseded "${3:0:12}"
cd_block_open_list | cut -d" " -f1' "$C2" "$D1" "$C3"
    [ "$status" -eq 0 ]
    [ "$output" = "$D1" ]
    run jq -r --arg s "$C2" '.[] | select(.sha==$s) | .cleared.reason' "${GREMION_ROOT}/data/cd/blocked.json"
    [ "$output" = "superseded by ${C3:0:12}" ]
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

@test "status: the first line shows PROOF MODE when it is on, and not when it is off" {
    cd_seed_state
    run cd_prog status
    [ "$status" -eq 0 ]
    [[ "${lines[0]}" != *PROOF* ]]
    cd_write_cfg 'CD_PROOF_MODE=1'
    run cd_prog status
    [ "$status" -eq 0 ]
    [[ "${lines[0]}" == *"PROOF MODE"* ]]
}

@test "status: --json is valid JSON and carries the same facts" {
    cd_seed_state ".live = ${CD_LIVE_JSON}"
    run cd_prog status --json
    [ "$status" -eq 0 ]
    printf '%s' "$output" | jq -e . >/dev/null
    run cd_prog status --json
    [ "$(printf '%s' "$output" | jq -r .phase)" = "idle" ]
    [ "$(printf '%s' "$output" | jq -r .live.sha12)" = "aaaaaaaaaaaa" ]
    [ "$(printf '%s' "$output" | jq -r .automation)" = "on" ]
    [ "$(printf '%s' "$output" | jq -r .proof_mode)" = "false" ]
}

@test "status: with the kill switch file it says automation is OFF" {
    cd_seed_state
    run cd_prog status
    [[ "$output" == *"automation: on"* ]]
    touch "${GREMION_ROOT}/etc/cd.disabled"
    run cd_prog status
    [[ "$output" == *"automation: OFF"* ]]
    run cd_prog status --json
    [ "$(printf '%s' "$output" | jq -r .automation)" = "off" ]
}

@test "status: keys that differ from the default are listed by NAME, never by value" {
    cd_seed_state
    cd_write_cfg 'CD_WATCH_MINUTES=45' 'CD_PROOF_MODE=0' 'CD_MAX_BATCH=7'
    run cd_prog status
    [ "$status" -eq 0 ]
    [[ "$output" == *"CD_WATCH_MINUTES"* ]]
    [[ "$output" == *"CD_MAX_BATCH"* ]]
    [[ "$output" != *"CD_PROOF_MODE"* ]]
    [[ "$output" != *"45"* ]] || { echo "a value leaked: $output"; return 1; }
    run cd_prog status --json
    [ "$(printf '%s' "$output" | jq -r '.config.differs | sort | join(",")')" = "CD_MAX_BATCH,CD_POLICY_ACK,CD_WATCH_MINUTES" ]
}

@test "status: the operator-value keys show as set or unset and no value reaches the output (leak test)" {
    cd_seed_state
    cd_write_cfg 'CD_REPO_URL=https://repo-leak.example.org/org/repo' 'CD_MAIL_TO=mail-leak@example.org' \
        'CD_HOST_LABEL=label-leak' 'CD_PROBE_HOST=probe-leak.example.org' \
        'CD_PING_URL=https://ping-leak.example.org/token-leak' 'CD_GITHUB_TOKEN_FILE=/run/token-leak.example.org' \
        'CD_PROOF_REPO=https://proof-leak.example.org/org/repo'
    local out
    out="$(cd_prog status 2>&1)"
    local json
    json="$(cd_prog status --json 2>&1)"
    local both="${out}${json}"
    [[ "$both" != *leak* ]] || { echo "LEAK in: $both"; return 1; }
    [[ "$both" != *example.org* ]]
    [[ "$out" == *"CD_PING_URL"*"set"* ]]
    [ "$(printf '%s' "$json" | jq -r '.config.operator.CD_PING_URL')" = "set" ]
    [ "$(printf '%s' "$json" | jq -r '.config.operator.CD_MAIL_TO')" = "set" ]
    # and unset keys say so
    cd_write_cfg
    json="$(cd_prog status --json)"
    [ "$(printf '%s' "$json" | jq -r '.config.operator.CD_PING_URL')" = "unset" ]
    [ "$(printf '%s' "$json" | jq -r '.config.operator.CD_PROOF_REPO')" = "unset" ]
    [ "$(printf '%s' "$json" | jq -r '.config.operator.CD_REPO_URL')" = "set" ]
}

@test "status: parked says what is serving" {
    local rel='{"id":"bbbbbbbbbbbb-1","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sha12":"bbbbbbbbbbbb","tag":"pilot-bbbbbbbbbbbb","colour":"green","tree":"/t","mode":"auto","stage":"watch","stage_status":"started","attempt":1,"committed_at":null}'
    cd_seed_state ".phase = \"parked\" | .live = ${CD_LIVE_JSON} | .hold = {\"kind\":\"failure\",\"reason\":\"watch_pause_cap\",\"sha12\":\"bbbbbbbbbbbb\",\"since\":\"2026-11-17T02:00:00Z\"} | .release = ${rel}"
    run cd_prog status
    [ "$status" -eq 0 ]
    [[ "$output" == *"parked"*"green"*"bbbbbbbbbbbb"* ]]
    [[ "$output" == *"watch_pause_cap"* ]]
    run cd_prog status --json
    [ "$(printf '%s' "$output" | jq -r .serving.colour)" = "green" ]
    [ "$(printf '%s' "$output" | jq -r .serving.sha12)" = "bbbbbbbbbbbb" ]
}

@test "status: counts of the last reconcile, module and leaf step are shown, never names" {
    cd_seed_state ".live = (${CD_LIVE_JSON} | .modules = {\"total\":4,\"upgraded\":2,\"unchanged\":2,\"skipped\":0,\"failed\":0,\"files_applied\":5} | .leaves = {\"total\":3,\"migrated\":2,\"skipped\":1,\"failed\":0} | .reconcile = {\"at\":\"2026-11-17T02:00:00Z\",\"total\":3,\"ok\":3,\"failed\":0,\"timeout\":0,\"busy\":0,\"skipped\":0,\"invalid\":0,\"seconds\":41,\"reason\":null})"
    run cd_prog status
    [ "$status" -eq 0 ]
    [[ "$output" == *"modules: 4"* ]]
    [[ "$output" == *"leaves: 3"* ]]
    [[ "$output" == *"reconcile"*"3"* ]]
}

@test "status: open blocks, live dump sets, mail transport and the lock span are shown through the stubs" {
    cd_need_flock
    cd_seed_state
    cd_stub_set cd_data_dumpset_live 0 'pilot-0123456789ab'
    cd_stub_set cd_notify_transport_ok 1
    cd_stub_set cd_data_timer_guard 3
    run cd_lib 'cd_lock_take; cd_block_add '"$SHA_A"' watch_crash x'
    run cd_prog status
    [ "$status" -eq 0 ]
    [[ "$output" == *"blocks: 1 open"* ]]
    [[ "$output" == *"pilot-0123456789ab"* ]]
    [[ "$output" == *"transport"*"NOT"* ]]
    [[ "$output" == *"overlap"* ]]
    run cd_prog status --json
    [ "$(printf '%s' "$output" | jq -r '.blocks_open')" = "1" ]
    [ "$(printf '%s' "$output" | jq -r '.dump_sets[0]')" = "pilot-0123456789ab" ]
    [ "$(printf '%s' "$output" | jq -r '.mail.transport_ok')" = "false" ]
    [ "$(printf '%s' "$output" | jq -r '.lock_span')" = "overlap" ]
}

@test "status: with no state file it says the program is not adopted yet and still exits 0" {
    run cd_prog status
    [ "$status" -eq 0 ]
    [[ "$output" == *"not adopted"* ]]
    run cd_prog status --json
    [ "$status" -eq 0 ]
    [ "$(printf '%s' "$output" | jq -r .adopted)" = "false" ]
}

@test "status: an unknown state version is exit 2" {
    cd_seed_state '.v = 9'
    run cd_prog status
    [ "$status" -eq 2 ]
}

@test "status: an ALERT file is reported (present, no text) and a bad flag is exit 2" {
    cd_seed_state
    printf '2026-11-17T01:00:00Z something broke\n' > "${GREMION_ROOT}/data/cd/ALERT"
    run cd_prog status
    [[ "$output" == *"ALERT: present"* ]]
    [[ "$output" != *"something broke"* ]]
    run cd_prog status --nonsense
    [ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# hold and resume
# ---------------------------------------------------------------------------

state_sum() { sha256sum "${GREMION_ROOT}/data/cd/state.json" "${GREMION_ROOT}/data/cd/blocked.json" 2>/dev/null | cut -d' ' -f1 | tr -d '\n'; }
request_count() { find "${GREMION_ROOT}/runtime/cd/requests" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l; }

@test "hold: writes a request, tries to start the unit, and does not touch the state" {
    cd_seed_state
    shim sudo
    local before
    before="$(state_sum)"
    run cd_prog hold --reason "maintenance window"
    [ "$status" -eq 0 ]
    [ "$(state_sum)" = "$before" ]
    [ "$(request_count)" -eq 1 ]
    run jq -r '[.verb, .args.reason] | join("|")' "${GREMION_ROOT}"/runtime/cd/requests/*.json
    [ "$output" = "hold|maintenance window" ]
    grep -q '^sudo -n systemctl start --no-block gremion-cd.service$' "$SHIM_LOG"
}

@test "hold: with no reason it still queues; a multi-line reason is exit 2" {
    cd_seed_state
    shim sudo
    run cd_prog hold
    [ "$status" -eq 0 ]
    [ "$(request_count)" -eq 1 ]
    run cd_prog hold --reason "$(printf 'a\nb')"
    [ "$status" -eq 2 ]
    [ "$(request_count)" -eq 1 ]
}

@test "hold: a failing sudo (no sudoers entry) does not fail the verb; the request is queued" {
    cd_seed_state
    shim sudo 'exit 1'
    run cd_prog hold
    [ "$status" -eq 0 ]
    [ "$(request_count)" -eq 1 ]
    [[ "$output" == *"next tick"* ]]
}

@test "resume: on an operator hold writes a request and does not touch the state" {
    cd_seed_state '.hold = {"kind":"operator","reason":"operator","sha12":"","since":"2026-11-17T01:00:00Z"}'
    shim sudo
    local before
    before="$(state_sum)"
    run cd_prog resume --reason "done"
    [ "$status" -eq 0 ]
    [ "$(state_sum)" = "$before" ]
    [ "$(request_count)" -eq 1 ]
    run jq -r '[.verb, .args.reason, (.args.discard_dump|tostring), (.args.accept_descendants|tostring)] | join("|")' "${GREMION_ROOT}"/runtime/cd/requests/*.json
    [ "$output" = "resume|done|false|false" ]
}

@test "resume: refuses (exit 2, with the reason) while a block is open, unless --accept-descendants with a reason" {
    cd_need_flock
    cd_seed_state '.hold = {"kind":"blocked","reason":"build_failed","sha12":"aaaaaaaaaaaa","since":"2026-11-17T01:00:00Z"}'
    shim sudo
    run cd_lib 'cd_lock_take; cd_block_add '"$SHA_A"' build_failed x'
    local before
    before="$(state_sum)"
    run cd_prog resume
    [ "$status" -eq 2 ]
    [[ "$output" == *"block"* ]]
    [[ "$output" == *"--accept-descendants"* ]]
    [ "$(request_count)" -eq 0 ]
    run cd_prog resume --accept-descendants
    [ "$status" -eq 2 ]
    [ "$(request_count)" -eq 0 ]
    run cd_prog resume --accept-descendants --reason "unrelated merge, reviewed"
    [ "$status" -eq 0 ]
    [ "$(request_count)" -eq 1 ]
    [ "$(state_sum)" = "$before" ]
    run jq -r '[.args.accept_descendants, .args.reason] | map(tostring) | join("|")' "${GREMION_ROOT}"/runtime/cd/requests/*.json
    [ "$output" = "true|unrelated merge, reviewed" ]
}

@test "resume: a plain resume is also refused while a block is open under another hold kind" {
    cd_need_flock
    cd_seed_state '.hold = {"kind":"operator","reason":"operator","sha12":"","since":"2026-11-17T01:00:00Z"}'
    run cd_lib 'cd_lock_take; cd_block_add '"$SHA_A"' watch_5xx x'
    run cd_prog resume
    [ "$status" -eq 2 ]
    [ "$(request_count)" -eq 0 ]
}

@test "resume: on a classifier hold changes nothing and says how the hold ends" {
    shim sudo
    local kind
    for kind in state_tier unsupported_chain contract_migration waived_migration ci_changed chain_class_changed \
                batch_too_large not_ancestor ruleset_missing range_unverified classify_failed; do
        cd_seed_state ".hold = {\"kind\":\"${kind}\",\"reason\":\"r\",\"sha12\":\"0123456789ab\",\"since\":\"2026-11-17T01:00:00Z\"}"
        local before
        before="$(state_sum)"
        run cd_prog resume
        [ "$status" -eq 0 ] || { echo "$kind: status $status: $output"; return 1; }
        [ "$(request_count)" -eq 0 ] || { echo "$kind queued a request"; return 1; }
        [ "$(state_sum)" = "$before" ]
        [[ "$output" == *"release-now"* || "$output" == *"re-adopt"* || "$output" == *"fix the cause"* ]] \
            || { echo "$kind says nothing useful: $output"; return 1; }
    done
    cd_seed_state '.hold = {"kind":"range_unverified","reason":"r","sha12":"0123456789ab","since":"2026-11-17T01:00:00Z"}'
    run cd_prog resume
    [[ "$output" == *"--accept-range"* ]]
    cd_seed_state '.hold = {"kind":"state_tier","reason":"r","sha12":"0123456789ab","since":"2026-11-17T01:00:00Z"}'
    run cd_prog resume
    [[ "$output" == *"--with-state"* ]]
    cd_seed_state '.hold = {"kind":"unsupported_chain","reason":"r","sha12":"","since":"2026-11-17T01:00:00Z"}'
    run cd_prog resume
    [[ "$output" == *"adopt --re-adopt"* ]]
}

@test "resume: with no hold there is nothing to resume and no request is written" {
    cd_seed_state
    run cd_prog resume
    [ "$status" -eq 0 ]
    [[ "$output" == *"no hold"* ]]
    [ "$(request_count)" -eq 0 ]
}

@test "resume: refuses while a failed release's dump set is live unless --discard-dump (cd_data_dumpset_live is stubbed)" {
    cd_seed_state '.hold = {"kind":"failure","reason":"infra","sha12":"0123456789ab","since":"2026-11-17T01:00:00Z"}'
    shim sudo
    cd_stub_set cd_data_dumpset_live 0 'pilot-0123456789ab'
    run cd_prog resume
    [ "$status" -eq 2 ]
    [[ "$output" == *"dump"* ]]
    [[ "$output" == *"--discard-dump"* ]]
    [ "$(request_count)" -eq 0 ]
    grep -q '^stub cd_data_dumpset_live' "$SHIM_LOG"
    run cd_prog resume --discard-dump
    [ "$status" -eq 0 ]
    [ "$(request_count)" -eq 1 ]
    run jq -r '.args.discard_dump | tostring' "${GREMION_ROOT}"/runtime/cd/requests/*.json
    [ "$output" = "true" ]
}

@test "resume: no live dump set means a plain resume goes through; a dump check that fails is exit 2" {
    cd_seed_state '.hold = {"kind":"failure","reason":"infra","sha12":"0123456789ab","since":"2026-11-17T01:00:00Z"}'
    shim sudo
    run cd_prog resume
    [ "$status" -eq 0 ]
    [ "$(request_count)" -eq 1 ]
    rm -f "${GREMION_ROOT}"/runtime/cd/requests/*.json
    cd_stub_set cd_data_dumpset_live 1
    run cd_prog resume
    [ "$status" -eq 2 ]
    [ "$(request_count)" -eq 0 ]
}

@test "resume: a parked release is resumed without the dump check (its dump set is legitimately live)" {
    local rel='{"id":"bbbbbbbbbbbb-1","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sha12":"bbbbbbbbbbbb","tag":"pilot-bbbbbbbbbbbb","colour":"green","tree":"/t","mode":"auto","stage":"watch","stage_status":"started","attempt":1,"committed_at":null}'
    cd_seed_state ".phase = \"parked\" | .live = ${CD_LIVE_JSON} | .release = ${rel} | .hold = {\"kind\":\"failure\",\"reason\":\"watch_pause_cap\",\"sha12\":\"bbbbbbbbbbbb\",\"since\":\"2026-11-17T01:00:00Z\"}"
    shim sudo
    cd_stub_set cd_data_dumpset_live 0 'pilot-bbbbbbbbbbbb'
    run cd_prog resume
    [ "$status" -eq 0 ]
    [ "$(request_count)" -eq 1 ]
}

@test "resume: unknown flags and a flag without its value are exit 2" {
    cd_seed_state '.hold = {"kind":"operator","reason":"operator","sha12":"","since":"2026-11-17T01:00:00Z"}'
    run cd_prog resume --nonsense
    [ "$status" -eq 2 ]
    run cd_prog resume --reason
    [ "$status" -eq 2 ]
    [ "$(request_count)" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

@test "dispatcher: an unknown verb is exit 2; a verb that is not a verb name never builds a function name" {
    run cd_prog no-such-verb
    [ "$status" -eq 2 ]
    run cd_prog 'status;touch pwned'
    [ "$status" -eq 2 ]
    run cd_prog '../x'
    [ "$status" -eq 2 ]
    [ ! -e pwned ]
    run cd_prog
    [ "$status" -eq 2 ]
}

@test "dispatcher: verb x-y runs cd_cmd_x_y (a stubbed verb of another unit) and passes its arguments and its exit code" {
    cd_seed_state
    cd_stub_set cd_cmd_release_now 3
    run cd_prog release-now 0123456789ab --with-state
    [ "$status" -eq 3 ]
    grep -q '^stub cd_cmd_release_now 0123456789ab --with-state$' "$SHIM_LOG"
}

@test "dispatcher: help lists the verbs, version prints the program and schema version, neither needs a config" {
    rm -f "${GREMION_ROOT}/etc/cd.env"
    run cd_prog help
    [ "$status" -eq 0 ]
    [[ "$output" == *status* && "$output" == *hold* && "$output" == *resume* && "$output" == *version* ]]
    run cd_prog version
    [ "$status" -eq 0 ]
    [[ "$output" == *"gremion-cd"* ]]
    [[ "$output" == *"state schema 1"* ]]
}

@test "dispatcher: a bad config is exit 2 before any verb runs; a tick-like verb also writes the ALERT file" {
    cd_write_cfg 'CD_PROOF_MODE=7'
    cd_seed_state
    run cd_prog status
    [ "$status" -eq 2 ]
    [ ! -e "${GREMION_ROOT}/data/cd/ALERT" ]
    cd_stub_set cd_cmd_tick 0
    run cd_prog tick
    [ "$status" -eq 2 ]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
    ! grep -q '^stub cd_cmd_tick' "$SHIM_LOG"
}

@test "dispatcher: libs are sourced from lib/cd, apply-root.sh (the root script) never is" {
    local src="${GREMION_ROOT}/host-copy"
    cp -r "$HOST_SRC" "$src"
    printf '#!/usr/bin/env bash\necho SOURCED-APPLY-ROOT\nexit 9\n' > "${src}/lib/cd/apply-root.sh"
    printf 'cd_cmd_zz_probe() { echo zz-probe-ran; }\n' > "${src}/lib/cd/zz-probe.sh"
    run env HOST_SRC="$src" "${src}/bin/gremion-cd" zz-probe
    [ "$status" -eq 0 ]
    [[ "$output" == *zz-probe-ran* ]]
    [[ "$output" != *SOURCED-APPLY-ROOT* ]]
}

@test "dispatcher: the stub file is honoured only with GREMION_CD_TESTING=1" {
    cd_seed_state
    run env -u GREMION_CD_TESTING "${HOST_SRC}/bin/gremion-cd" release-now abc
    [ "$status" -eq 2 ]
}

@test "stubs: every cross-unit function of the cross-unit interface list exists after the stubs are loaded" {
    local fn missing=""
    for fn in "${CD_STUB_FUNCS[@]}"; do
        run cd_lib 'declare -F "$1" >/dev/null' "$fn"
        [ "$status" -eq 0 ] || missing="${missing} ${fn}"
    done
    [ -z "$missing" ] || { echo "no stub for:${missing}"; return 1; }
    # the leaf functions are among them
    [[ " ${CD_STUB_FUNCS[*]} " == *" cd_leaves_migrate "* ]]
    [[ " ${CD_STUB_FUNCS[*]} " == *" cd_leaves_services "* ]]
}

@test "stubs: a stub records its call, returns its configured code and prints its configured output" {
    cd_stub_set cd_leaves_services 0 'calendar content'
    run cd_lib 'cd_leaves_services x y'
    [ "$status" -eq 0 ]
    [ "$output" = "calendar content" ]
    grep -q '^stub cd_leaves_services x y$' "$SHIM_LOG"
    cd_stub_set cd_leaves_migrate 4
    run cd_lib 'cd_leaves_migrate a b c'
    [ "$status" -eq 4 ]
}

# ---------------------------------------------------------------------------
# Review fixes: stderr after a release, empty documents, errexit inside a verb,
# a library that does not load
# ---------------------------------------------------------------------------

@test "locks: stderr still works after cd_hostlock_release and after cd_locks_release" {
    cd_need_flock
    run cd_lib 'cd_lock_take; cd_hostlock_take
cd_hostlock_release
cd_err "visible-after-hostlock-release"
sh -c "echo child-after-hostlock-release >&2"
cd_locks_release
cd_err "visible-after-locks-release"
sh -c "echo child-after-locks-release >&2"
echo stdout-ok'
    [ "$status" -eq 0 ]
    [[ "$output" == *visible-after-hostlock-release* ]]
    [[ "$output" == *child-after-hostlock-release* ]]
    [[ "$output" == *visible-after-locks-release* ]]
    [[ "$output" == *child-after-locks-release* ]]
    # the descriptors really are closed: a second process can take both locks
    run cd_lib 'cd_hostlock_take; cd_lock_take'
    [ "$status" -eq 0 ]
}

@test "requests: an empty, a whitespace-only and a two-document request file are rejected and logged, never consumed" {
    local d="${GREMION_ROOT}/runtime/cd/requests" ok='{"v":1,"verb":"hold","args":{},"at":"t","by":"x"}'
    mkdir -p "$d"
    : > "${d}/1700000000-0001-hold.json"
    printf ' \n\t\n' > "${d}/1700000000-0002-hold.json"
    printf '%s\n%s\n' "$ok" "$ok" > "${d}/1700000000-0003-hold.json"
    run cd_lib 'if cd_request_next; then echo consumed; else echo none; fi'
    [ "$status" -eq 0 ]
    [ "$output" = "none" ]
    [ "$(ls "${d}/rejected" | wc -l)" -eq 3 ]
    [ ! -e "${d}/processed" ] || [ "$(ls "${d}/processed" | wc -l)" -eq 0 ]
    [ "$(grep -c request_rejected "${GREMION_ROOT}/data/cd/history.jsonl")" -eq 3 ]
}

@test "blocks: an empty or whitespace-only block list stops the program (never 'not blocked')" {
    local content
    for content in '' ' ' $'\n' $'  \n\t\n'; do
        printf '%s' "$content" > "${GREMION_ROOT}/data/cd/blocked.json"
        rm -f "${GREMION_ROOT}/data/cd/ALERT"
        run cd_lib 'if cd_is_blocked '"$SHA_A"'; then echo blocked; else echo free; fi; echo survived'
        [ "$status" -eq 2 ] || { echo "status $status for a ${#content}-byte list: $output"; return 1; }
        [[ "$output" != *free* ]]
        [[ "$output" != *survived* ]]
        [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
    done
    # two documents in one file are not a list either
    printf '[]\n[]\n' > "${GREMION_ROOT}/data/cd/blocked.json"
    run cd_lib 'cd_blocks_load; echo survived'
    [ "$status" -eq 2 ]
    [[ "$output" != *survived* ]]
}

@test "blocks: a filter that prints nothing or two documents is refused and the file is unchanged" {
    cd_need_flock
    run cd_lib 'cd_lock_take; cd_block_add '"$SHA_A"' build_failed x'
    [ "$status" -eq 0 ]
    local before
    before="$(sha256sum "${GREMION_ROOT}/data/cd/blocked.json")"
    run cd_lib 'cd_lock_take; cd_blocks_apply "empty"'
    [ "$status" -eq 1 ]
    [ "$(sha256sum "${GREMION_ROOT}/data/cd/blocked.json")" = "$before" ]
    run cd_lib 'cd_lock_take; cd_blocks_apply ".,."'
    [ "$status" -eq 1 ]
    [ "$(sha256sum "${GREMION_ROOT}/data/cd/blocked.json")" = "$before" ]
    [ -s "${GREMION_ROOT}/data/cd/blocked.json" ]
}

# a copy of the host tree with probe libraries, so the real dispatcher runs them
dispatch_copy() {
    local src="${GREMION_ROOT}/host-copy"
    rm -rf "$src"
    cp -r "$HOST_SRC" "$src"
    printf '%s' "$src"
}

@test "dispatcher: errexit stays on inside a verb (an unchecked failing command stops it, a refused state read is not an empty answer)" {
    local src
    src="$(dispatch_copy)"
    cat > "${src}/lib/cd/zz-probe.sh" <<'EOF'
cd_cmd_zz_state() { local x; x="$(cd_state_get .phase)"; echo "carried on [$x]"; }
cd_cmd_zz_false() { false; echo "carried on after false"; }
cd_cmd_zz_rc() { return 3; }
cd_cmd_zz_ok() { echo "verb ran"; }
EOF
    # no state file: the read dies, the verb must not print anything after it
    run env HOST_SRC="$src" "${src}/bin/gremion-cd" zz-state
    [ "$status" -eq 2 ]
    [[ "$output" != *"carried on"* ]]
    run env HOST_SRC="$src" "${src}/bin/gremion-cd" zz-false
    [ "$status" -eq 1 ]
    [[ "$output" != *"carried on"* ]]
    # an explicit return code still comes out unchanged, and a clean verb is 0
    run env HOST_SRC="$src" "${src}/bin/gremion-cd" zz-rc
    [ "$status" -eq 3 ]
    run env HOST_SRC="$src" "${src}/bin/gremion-cd" zz-ok
    [ "$status" -eq 0 ]
    [ "$output" = "verb ran" ]
}

@test "dispatcher: a library that does not load writes the ALERT file; the watchdog, help and version still run, every other verb is exit 2" {
    local src
    src="$(dispatch_copy)"
    # an interrupted install: a half-written library
    printf 'cd_cmd_zz_half() {\n  echo half\n' > "${src}/lib/cd/zz-half.sh"
    cd_seed_state
    run env HOST_SRC="$src" "${src}/bin/gremion-cd" watchdog
    [ "$status" -eq 0 ]
    grep -q '^stub cd_cmd_watchdog' "$SHIM_LOG"
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
    grep -q 'zz-half' "${GREMION_ROOT}/data/cd/ALERT"
    rm -f "${GREMION_ROOT}/data/cd/ALERT"
    run env HOST_SRC="$src" "${src}/bin/gremion-cd" version
    [ "$status" -eq 0 ]
    run env HOST_SRC="$src" "${src}/bin/gremion-cd" status
    [ "$status" -eq 2 ]
    [[ "$output" == *"did not load"* ]]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
    cd_stub_set cd_cmd_tick 0
    run env HOST_SRC="$src" "${src}/bin/gremion-cd" tick
    [ "$status" -eq 2 ]
    ! grep -q '^stub cd_cmd_tick' "$SHIM_LOG"
}

@test "resume: a ruleset_missing hold does not claim that a later commit ends it" {
    shim sudo
    cd_seed_state '.hold = {"kind":"ruleset_missing","reason":"r","sha12":"0123456789ab","since":"2026-11-17T01:00:00Z"}'
    run cd_prog resume
    [ "$status" -eq 0 ]
    [[ "$output" == *"ruleset"* ]]
    [[ "$output" != *"later commit"* ]]
    # a classifier hold that a commit really can end still says so
    cd_seed_state '.hold = {"kind":"ci_changed","reason":"r","sha12":"0123456789ab","since":"2026-11-17T01:00:00Z"}'
    run cd_prog resume
    [[ "$output" == *"later commit"* ]]
}

# ---------------------------------------------------------------------------
# Shell hygiene
# ---------------------------------------------------------------------------

@test "hygiene: the dispatcher sets strict mode on its second line and sources common.sh" {
    local p="${HOST_SRC}/bin/gremion-cd"
    [ -x "$p" ]
    [ "$(sed -n 2p "$p")" = "set -euo pipefail" ]
    grep -q '^\. "\$SCRIPT_DIR/\.\./lib/common\.sh"$' "$p"
    grep -q '^# shellcheck source=' "$p"
}

@test "hygiene: no lib under lib/cd sets shell options or calls exit at top level, and each sources quietly under strict mode" {
    local f n=0
    for f in "${HOST_SRC}"/lib/cd/*.sh; do
        [[ -f "$f" ]] || continue
        [[ "${f##*/}" == apply-root.sh ]] && continue
        n=$((n + 1))
        # options belong to the program, not to its library (the family rule of common.sh)
        ! grep -Eq '^set [-+][A-Za-z]' "$f" || { echo "sets shell options: $f"; return 1; }
        # a top-level exit or return (outside any function) would end the sourcing program
        ! grep -Eq '^(exit|return)([[:space:]]+[0-9$"]|[[:space:]]*$)' "$f" || { echo "top-level exit: $f"; return 1; }
        run bash -c 'set -euo pipefail; . "$1"; . "$2"; echo sourced' _ "${HOST_SRC}/lib/common.sh" "$f"
        [ "$status" -eq 0 ] || { echo "sourcing failed: $f"; return 1; }
        [ "$output" = "sourced" ] || { echo "sourcing printed: $f: $output"; return 1; }
        run bash -c 'set +e +u; before=$-; . "$1"; . "$2"; [[ "$-" == "$before" ]]' _ "${HOST_SRC}/lib/common.sh" "$f"
        [ "$status" -eq 0 ] || { echo "sourcing changed the shell options: $f"; return 1; }
    done
    [ "$n" -ge 2 ]
}

@test "hygiene: nothing under lib/cd or the dispatcher carries a real host, an address or a person (reserved names only)" {
    local f
    for f in "${HOST_SRC}"/lib/cd/*.sh "${HOST_SRC}/bin/gremion-cd" "${HOST_TEST_DIR}/cd-core.bats" "${HOST_TEST_DIR}/test_helper/cd.bash"; do
        [[ -f "$f" ]] || continue
        # an e-mail address whose domain is not a reserved one
        ! grep -Eo '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$f" \
            | grep -Ev '@(example\.org|example\.com)$|@[A-Za-z0-9.-]+\.(invalid|test)$' | grep -q . \
            || { echo "address in $f"; return 1; }
        # an IPv4 address outside 203.0.113.0/24 (and not a version string or the loopback)
        ! grep -Eo '(^|[^0-9.])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9.]|$)' "$f" \
            | grep -Ev '203\.0\.113\.|127\.0\.0\.1|0\.0\.0\.0' | grep -q . \
            || { echo "IPv4 in $f"; return 1; }
    done
}
