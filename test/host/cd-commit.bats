#!/usr/bin/env bats
# test/host/cd-commit.bats -- cd-commit: infra/host/lib/cd/commit.sh, the end of a release of the
# continuous deployment program: the watch loop (the kill switch and the pause cap park inside
# it), the commit point and the prune.
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm --user 1001 -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-commit.bats
#
# Nothing here touches a real docker, curl, Traefik or network. core.sh, cmd-state.sh and notify.sh
# are the REAL libraries (the mails are read from the outbox, so a kind or a field the allow-list
# refuses shows); docker.sh is the real one in the prune tests, where docker is one recording shim.
# Every function another unit owns is a scripted fake (fixtures/cd/commit/fakes.sh) that records the
# state of the host lock at the moment it is called. The clock is the fake clock of test_helper/cd
# (cd_sleep moves it), a parked process polls in real time (GREMION_CD_PARK_POLL_S) so the clock
# stands still while it waits. Every name is a reserved example name.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'

FIX="${BATS_TEST_DIRNAME}/fixtures/cd/commit"
OLD12=aaaaaaaaaaaa
NEW12=bbbbbbbbbbbb
OLD40="$(printf 'a%.0s' $(seq 1 40))"
NEW40="$(printf 'b%.0s' $(seq 1 40))"

setup() {
    cd_setup
    export FIX
    FK="${GREMION_ROOT}/.fk"
    export FK
    mkdir -p "$FK"
    export GREMION_CD_PARK_POLL_S=0.1
    cd_write_cfg CD_WATCH_MINUTES=1 CD_COMMIT_MAX_MIN=3
    seed_root
    seed_state 0
}

teardown() {
    cd_teardown
}

# ------------------------------------------------------------------ the fake root

seed_root() {
    local f
    mkdir -p "${GREMION_ROOT}/releases/${OLD12}" "${GREMION_ROOT}/releases/${NEW12}" \
        "${GREMION_ROOT}/runtime/workers" "${GREMION_ROOT}/bin" "${GREMION_ROOT}/logs"
    ln -s "${GREMION_ROOT}/releases/${OLD12}" "${GREMION_ROOT}/current"
    printf 'pilot-%s\n' "$OLD12" > "${GREMION_ROOT}/runtime/current-tag"
    printf 'pilot-999999999999\n' > "${GREMION_ROOT}/runtime/previous-tag"
    for f in gremion-cd gremion-rollback gremion-switch; do
        printf '#!/bin/sh\necho %s\n' "$f" > "${GREMION_ROOT}/bin/${f}"
        chmod 755 "${GREMION_ROOT}/bin/${f}"
    done
    cp "${FIX}/state.env" "${FIX}/app-blue.env" "${FIX}/app-green.env" "${GREMION_ROOT}/etc/env/"
    printf 'off' > "${GREMION_ROOT}/runtime/workers/blue"
    printf 'on' > "${GREMION_ROOT}/runtime/workers/green"
}

live_json() {
    jq -cn --arg root "$GREMION_ROOT" '{sha: ("a" * 40), sha12: "aaaaaaaaaaaa", tag: "pilot-aaaaaaaaaaaa", colour: "blue",
        tree: ($root + "/releases/aaaaaaaaaaaa"), since: "2026-11-01T00:00:00Z", proof: false, modules: null, leaves: null, reconcile: null}'
}

release_json() {
    jq -cn --arg root "$GREMION_ROOT" --argjson obs "$1" --arg mode "$2" '{id: "bbbbbbbbbbbb-1", sha: ("b" * 40), sha12: "bbbbbbbbbbbb",
        tag: "pilot-bbbbbbbbbbbb", colour: "green", tree: ($root + "/releases/bbbbbbbbbbbb"), from_sha12: "aaaaaaaaaaaa", mode: $mode,
        with_state: false, stage: "watch", stage_status: "started", attempt: 1, class: null, dump_label: "pilot-bbbbbbbbbbbb",
        rollback_target: "ok", retag_prev: null, workers: "on",
        modules: {total: 2, upgraded: 1, unchanged: 1, skipped: 0, failed: 0, files_applied: 3}, leaves: null,
        switch_started: true, commit_attempts: 0, committed_at: null, timing: {snapshot_s: 42, module_s: 7},
        started_at: "2026-11-17T01:00:00Z", switched_at: "2026-11-17T01:30:00Z",
        watch: {observed_s: $obs, samples: 0, bad_streak: 0, paused_s: 0, blind: 0, requests: 7, baseline_5xx: 0,
                baseline_not_ready: 0, last_sample_epoch: 0}, failure: null}'
}

# seed_state OBSERVED [MODE] [EXTRA_JQ] -- phase watching, live = the old release, release = the new
# one with OBSERVED seconds of observed time.
seed_state() {
    local obs="${1:-0}" mode="${2:-auto}" extra="${3:-(.)}"
    cd_seed_state ".phase = \"watching\" | .live = $(live_json) | .release = $(release_json "$obs" "$mode") | ${extra}"
}

st() { jq -r "$1" "${GREMION_ROOT}/data/cd/state.json"; }

# fp -- a fingerprint of what a release must not move before the commit point: the `current`
# link, the installed host programs, state.env and the other env files, the worker gate files.
fp() {
    (
        cd "$GREMION_ROOT"
        readlink current
        sha256sum bin/* etc/env/*.env runtime/workers/* runtime/current-tag runtime/previous-tag
    )
}
fp_programs() {
    (cd "$GREMION_ROOT" && sha256sum bin/* etc/env/state.env)
}

# ------------------------------------------------------------------ the loaders

cdc_prelude() {
    cat <<'EOF'
. "${HOST_SRC}/lib/common.sh"
. "${HOST_SRC}/lib/cd/core.sh"
. "${HOST_SRC}/lib/cd/cmd-state.sh"
. "${HOST_SRC}/lib/cd/notify.sh"
if [ -n "${CDC_REAL_DOCKER:-}" ]; then . "${HOST_SRC}/lib/cd/docker.sh"; fi
. "${HOST_SRC}/lib/cd/commit.sh"
. "${FIX}/fakes.sh"
. "${GREMION_CD_STUBS_DIR}/cd-stubs.sh"
cd_paths_init
cd_cfg_load
case "${CDC_LOCKS:-both}" in
    both) cd_lock_take; cd_hostlock_take ;;
    cd) cd_lock_take ;;
esac
EOF
}

# cdc_lib 'snippet' -- a fresh bash with the libraries and the fakes, both locks taken (CDC_LOCKS=cd
# takes the cd lock only, none neither). No errexit: a driver calls a stage as `fn || rc=$?`.
cdc_lib() {
    local snippet="$1"
    shift
    bash -c "$(cdc_prelude)
${snippet}" cdc-lib "$@"
}

# cdc_strict 'snippet' -- the same under set -euo pipefail, the shell of the real program.
cdc_strict() {
    local snippet="$1"
    shift
    bash -c "set -euo pipefail
$(cdc_prelude)
${snippet}" cdc-strict "$@"
}

# cdc_bg 'snippet' -- in the background, with bats' fd 3 closed; the snippet prints "ready" first.
cdc_bg() {
    local snippet="$1" i
    CD_BG_OUT="$(mktemp "${GREMION_ROOT}/.bg.XXXXXX")"
    bash -c "$(cdc_prelude)
${snippet}" cdc-bg > "$CD_BG_OUT" 2>&1 3>&- < /dev/null &
    CD_BG_PID=$!
    CD_BG_PIDS+=("$CD_BG_PID")
    for i in $(seq 1 100); do
        grep -q '^ready' "$CD_BG_OUT" 2>/dev/null && return 0
        sleep 0.1
    done
    echo "cdc_bg: never ready; output:" >&2
    cat "$CD_BG_OUT" >&2
    return 1
}

# wait_for 'command' [tenths] -- poll until the command succeeds.
wait_for() {
    local i
    for i in $(seq 1 "${2:-100}"); do
        if eval "$1" >/dev/null 2>&1; then return 0; fi
        sleep 0.1
    done
    echo "wait_for: never: $1" >&2
    return 1
}

mails() { ls "${GREMION_ROOT}/data/cd/outbox/" 2>/dev/null | grep -c -- "-$1" || true; }
calls() { grep -c -- "$1" "$SHIM_LOG" || true; }
verdicts() { printf '%s\n' "$@" > "$FK/verdicts"; }

# ================================================================== the watch loop

@test "the loop samples every interval and the window ends only when the observed time reaches the window" {
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$? t=$(cd_now)"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0 t=$((1700000000 + 60))"* ]]
    [ "$(calls 'fake cd_watch_eval')" -eq 4 ]
    [ "$(calls 'fake cd_watch_sample')" -eq 4 ]
    [ "$(st '.release.watch.observed_s')" = 60 ]
    [ "$(st '.phase')" = watching ]
    [ "$(st '.release.committed_at')" = null ]
    run refute_recorded fake cd_rollback_run
    [ "$status" -eq 0 ]
}

@test "paused samples add no observed time, so the window grows by them" {
    verdicts ok paused paused ok ok ok
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ "$(calls 'fake cd_watch_eval')" -eq 6 ]
    [ "$(st '.release.watch.paused_s')" = 30 ]
    [ "$(st '.release.watch.observed_s')" = 60 ]
}

@test "the loop sleeps the interval minus the sample's own duration and at least one second" {
    echo 5 > "$FK/sample.advance"
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$? t=$(cd_now)"'
    [[ "$output" == *"rc=0 t=$((1700000000 + 60))"* ]]
    seed_state 0
    cd_fake_now 1700000000
    echo 20 > "$FK/sample.advance"
    rm -f "$FK/eval.n" "$FK/sample.n"
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$? t=$(cd_now)"'
    [[ "$output" == *"rc=0 t=$((1700000000 + 84))"* ]]
}

@test "a trigger calls cd_rollback_run with its rule and the loop ends; a bad sample alone does not" {
    verdicts ok bad trigger:watch_5xx
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [ "$(calls 'fake cd_watch_eval')" -eq 3 ]
    [ "$(cat "$FK/rollback.rules")" = watch_5xx ]
    [ "$(st '.phase')" = idle ]
}

@test "a rollback request is taken before the next sample, a hold request is not consumed and does not stop the loop" {
    run cd_lib 'cd_request_put hold "{\"reason\":\"x\"}"; cd_request_put rollback "{}"'
    [ "$status" -eq 0 ]
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [ "$(cat "$FK/rollback.rules")" = manual_rollback ]
    [ "$(calls 'fake cd_watch_sample')" -eq 0 ]
    ls "${GREMION_ROOT}/runtime/cd/requests/processed/" | grep -q -- '-rollback.json'
    ls "${GREMION_ROOT}/runtime/cd/requests/" | grep -q -- '-hold.json'
}

@test "a hold request alone leaves the loop running to the end of the window and stays queued" {
    run cd_lib 'cd_request_put hold "{\"reason\":\"x\"}"'
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ "$(calls 'fake cd_watch_eval')" -eq 4 ]
    ls "${GREMION_ROOT}/runtime/cd/requests/" | grep -q -- '-hold.json'
}

@test "the worker gate flips an evaluation asks for are written old colour off first, then new colour on" {
    verdicts "ok;flip green on;flip blue off"
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    local first
    first="$(grep -n 'fake cd_colour_workers' "$SHIM_LOG" | head -n 2 | cut -d' ' -f3-4 | tr '\n' ',')"
    [ "$first" = "blue off,green on," ]
}

@test "a failed old-colour write stops the new colour from being turned on in that pass" {
    echo 99 > "$FK/cd_colour_workers.fails"
    verdicts "ok;flip green on;flip blue off"
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    assert_recorded fake "cd_colour_workers blue off"
    run refute_recorded fake "cd_colour_workers green on"
    [ "$status" -eq 0 ]
}

@test "samples that give no verdict never trigger a rollback and end the loop with 4 after eight in a row" {
    echo 1 > "$FK/eval.rc"
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=4"* ]]
    [ "$(calls 'fake cd_watch_eval')" -eq 8 ]
    run refute_recorded fake cd_rollback_run
    [ "$status" -eq 0 ]
    [ "$(st '.phase')" = watching ]
}

@test "a sample that cannot be taken is no verdict either" {
    echo 4 > "$FK/sample.rc"
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=4"* ]]
    [ "$(calls 'fake cd_watch_sample')" -eq 8 ]
}

@test "the loop refuses a committed release, a missing release, an idle phase and a missing lock, touching nothing" {
    local before
    before="$(fp)"
    seed_state 0 auto '.release.committed_at = "2026-11-17T02:00:00Z"'
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=2"* ]]
    seed_state 0 auto '.phase = "idle"'
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=2"* ]]
    seed_state 0
    CDC_LOCKS=cd run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=2"* ]]
    CDC_LOCKS=none run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=2"* ]]
    [ "$(calls 'fake cd_watch_sample')" -eq 0 ]
    [ "$(fp)" = "$before" ]
}

@test "a resume after a crash keeps the observed time of the window" {
    seed_state 45
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ "$(calls 'fake cd_watch_eval')" -eq 1 ]
    [ "$(st '.release.watch.observed_s')" = 60 ]
}

@test "a proof release whose window ends clean is rolled back with proof_end and never committed" {
    seed_state 60 proof
    local before
    before="$(fp)"
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [ "$(cat "$FK/rollback.rules")" = proof_end ]
    [ "$(calls 'fake cd_watch_sample')" -eq 0 ]
    [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
    [ "$(fp)" = "$before" ]
}

@test "a proof release is refused by the commit point itself and nothing moves" {
    seed_state 60 proof
    local before live
    before="$(fp)"
    live="$(st '.live')"
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=2"* ]]
    [ "$(fp)" = "$before" ]
    [ "$(st '.live')" = "$live" ]
    [ "$(st '.release.committed_at')" = null ]
    [ "$(calls 'fake cd_colour_isolation_record')" -eq 0 ]
}

@test "rollback_target unusable: a trigger mails, does not call the rollback and parks the release" {
    seed_state 0 auto '.release.rollback_target = "unusable"'
    verdicts ok trigger:watch_crash
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$? lock=$(_fk_lockstate)"'
    [[ "$output" == *"rc=3 lock=free"* ]]
    run refute_recorded fake cd_rollback_run
    [ "$status" -eq 0 ]
    [ "$(st '.phase')" = parked ]
    [ "$(st '.hold.kind')" = failure ]
    [ "$(st '.hold.reason')" = rollback_unusable ]
    [ "$(mails rollback_failed)" -ge 1 ]
    [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
}

# ------------------------------------------------------------------ the pause cap and parked

@test "a parked verdict sets the phase and the hold failure, queues a critical mail and releases the host lock" {
    verdicts ok parked
    run cdc_lib 'cd_commit_watch_loop; echo "rc=$? lock=$(_fk_lockstate)"'
    [[ "$output" == *"rc=3 lock=free"* ]]
    [ "$(st '.phase')" = parked ]
    [ "$(st '.hold.kind')" = failure ]
    [ "$(st '.hold.reason')" = watch_pause_cap ]
    [ "$(st '.release.committed_at')" = null ]
    [ "$(mails parked)" -eq 1 ]
    grep -q '^rule: watch_pause_cap' "${GREMION_ROOT}"/data/cd/outbox/*-parked*.eml
    [ "$(calls 'fake cd_rollback_run')" -eq 0 ]
}

@test "resume re-enters the watch with a fresh pause budget and takes the host lock again" {
    seed_state 30 auto '.phase = "parked" | .release.watch.paused_s = 900 | .hold = {kind: "failure", reason: "watch_pause_cap", sha12: "bbbbbbbbbbbb", since: "2026-11-17T01:45:00Z"}'
    CDC_LOCKS=cd run cdc_lib 'cd_commit_watch_loop; echo "rc=$? hostlock=${CD_HOSTLOCK_PID:-none}"'
    [[ "$output" == *"rc=0"* ]]
    [ "$(st '.phase')" = watching ]
    [ "$(st '.release.watch.paused_s')" = 0 ]
    [ "$(st '.hold')" = null ]
    [ "$(calls 'fake cd_watch_eval')" -eq 2 ]
    [ "$(st '.release.watch.observed_s')" = 60 ]
}

@test "resume stays parked when the host lock is busy" {
    seed_state 30 auto '.phase = "parked"'
    hold_host_lock 20
    cd_write_cfg CD_WATCH_MINUTES=1 CD_LOCK_WAIT_S=1
    CDC_LOCKS=cd run cdc_lib 'cd_commit_watch_loop; echo "rc=$?"'
    [[ "$output" == *"rc=3"* ]]
    [ "$(st '.phase')" = parked ]
    [ "$(calls 'fake cd_watch_sample')" -eq 0 ]
}

@test "a parked release does not run the commit point" {
    seed_state 60 auto '.phase = "parked"'
    local before
    before="$(fp)"
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=2"* ]]
    [ "$(fp)" = "$before" ]
    [ "$(st '.release.committed_at')" = null ]
    [ "$(calls 'fake cd_colour_isolation_record')" -eq 0 ]
}

# ------------------------------------------------------------------ the kill switch

@test "kill switch in the watch: the process stays alive holding both locks, stops evaluating, keeps the heartbeat, resumes with the same observed time" {
    cd_write_cfg CD_WATCH_MINUTES=2 CD_COMMIT_MAX_MIN=3
    seed_state 0
    echo 3 > "$FK/killat"
    cdc_bg 'echo ready; rc=0; cd_commit_watch_loop || rc=$?; echo "rc=$rc"'
    wait_for "ls '${GREMION_ROOT}'/data/cd/outbox/*-killswitch*.eml"
    # held by the parked process: neither lock can be taken by anyone else
    run cd_lib 'cd_hostlock_take'
    [ "$status" -eq 3 ]
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 3 ]
    local n observed
    n="$(calls 'fake cd_watch_eval')"
    observed="$(st '.release.watch.observed_s')"
    [ "$n" -eq 3 ]
    [ "$observed" = 45 ]
    sleep 0.6
    [ "$(calls 'fake cd_watch_eval')" -eq "$n" ]
    grep -q '^notes: rollback_off_lock_held' "${GREMION_ROOT}"/data/cd/outbox/*-killswitch*.eml
    # the heartbeat is rewritten while it waits
    cd_fake_now 1700000999
    wait_for "grep -q '^1700000999 ' '${GREMION_ROOT}/runtime/cd/heartbeat'"
    run cd_lib 'cd_hostlock_take'
    [ "$status" -eq 3 ]
    [ "$(mails killswitch)" -eq 1 ]
    # the file goes away: the watch goes on where it was
    rm -f "${GREMION_ROOT}/etc/cd.disabled"
    wait_for "grep -q '^rc=' '$CD_BG_OUT'" 150
    grep -q '^rc=0' "$CD_BG_OUT"
    [ "$(st '.release.watch.observed_s')" = 120 ]
    [ "$(calls 'fake cd_watch_eval')" -eq 8 ]
    run grep -c 'lock=free' "$SHIM_LOG"
    [ "$output" = 0 ]
}

@test "kill switch in the watch: a rollback request while it waits runs the sequence with the host lock held" {
    echo 2 > "$FK/killat"
    cdc_bg 'echo ready; rc=0; cd_commit_watch_loop || rc=$?; echo "rc=$rc"'
    wait_for "ls '${GREMION_ROOT}'/data/cd/outbox/*-killswitch*.eml"
    run cd_lib 'cd_request_put rollback "{}"'
    wait_for "grep -q '^rc=' '$CD_BG_OUT'" 100
    grep -q '^rc=1' "$CD_BG_OUT"
    [ "$(cat "$FK/rollback.rules")" = manual_rollback ]
    run grep -c 'fake cd_rollback_run manual_rollback | lock=held' "$SHIM_LOG"
    [ "$output" = 1 ]
}

@test "kill switch at the commit stage: it waits in place with both locks, then the commit goes on" {
    echo 1 > "$FK/cd_colour_isolation_record.fails"
    : > "${GREMION_ROOT}/etc/cd.disabled"
    seed_state 60
    cdc_bg 'echo ready; rc=0; cd_commit_promote || rc=$?; echo "rc=$rc"'
    wait_for "ls '${GREMION_ROOT}'/data/cd/outbox/*-killswitch*.eml"
    run cd_lib 'cd_hostlock_take'
    [ "$status" -eq 3 ]
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 3 ]
    [ "$(st '.release.committed_at')" = null ]
    rm -f "${GREMION_ROOT}/etc/cd.disabled"
    wait_for "grep -q '^rc=' '$CD_BG_OUT'" 150
    grep -q '^rc=0' "$CD_BG_OUT"
    [ "$(st '.release.committed_at')" != null ]
    run grep -c 'lock=free' "$SHIM_LOG"
    [ "$output" = 0 ]
}

# ================================================================== the commit point

@test "commit point, one pass: the steps run in order and the state moves in ONE write" {
    seed_state 60
    cat > "$GREMION_ROOT/.wrap.sh" <<'EOF'
eval "_orig_$(declare -f cd_state_set)"
cd_state_set() { printf '%s\n' "${1//$'\n'/ }" >> "$FK/state-writes.log"; _orig_cd_state_set "$@"; }
EOF
    run cdc_lib ". '${GREMION_ROOT}/.wrap.sh'; cd_commit_promote; echo \"rc=\$?\""
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0"* ]]
    # the pointers
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${NEW12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "pilot-${NEW12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/previous-tag")" = "pilot-${OLD12}" ]
    # the state: live = new, previous = old, startable, committed, the counts copied
    [ "$(st '.live.sha12')" = "$NEW12" ]
    [ "$(st '.live.colour')" = green ]
    [ "$(st '.live.proof')" = false ]
    [ "$(st '.live.modules.total')" = 2 ]
    [ "$(st '.previous.sha12')" = "$OLD12" ]
    [ "$(st '.previous.colour')" = blue ]
    [ "$(st '.previous.startable')" = true ]
    [ "$(st '.release.committed_at')" != null ]
    # step 5 is ONE write that holds the live, the previous and the committed marker together
    [ "$(grep -c 'committed_at' "$FK/state-writes.log")" -eq 1 ]
    grep 'committed_at' "$FK/state-writes.log" | grep -q '\.previous = .*\.live = .*\.release\.committed_at ='
    # the order of the calls
    local order
    order="$(grep -o 'fake [a-z_]*' "$SHIM_LOG" | cut -d' ' -f2 | tr '\n' ' ')"
    [ "$order" = "cd_colour_isolation_record executor_unit_action cd_data_dumpset_retire cd_colour_down " ]
}

@test "step 1: an isolation record that fails leaves current unmoved and the commit pending, retried every 60 seconds with the host lock never free" {
    echo 3 > "$FK/cd_colour_isolation_record.fails"
    seed_state 60
    cd_write_cfg CD_WATCH_MINUTES=1 CD_COMMIT_MAX_MIN=30
    run cdc_lib 'cd_commit_promote; echo "rc=$? t=$(cd_now)"'
    [[ "$output" == *"rc=0 t=$((1700000000 + 180))"* ]]
    [ "$(calls 'fake cd_colour_isolation_record')" -eq 4 ]
    # the three failed attempts saw the old tree, the successful one is the last that did
    run grep 'fake cd_colour_isolation_record' "$SHIM_LOG"
    [ "$(printf '%s\n' "$output" | head -n 3 | grep -c "cur=${OLD12}")" -eq 3 ]
    run grep -c 'lock=free' "$SHIM_LOG"
    [ "$output" = 0 ]
    # a mail goes out after three failed attempts, one
    [ "$(mails stopped)" -eq 1 ]
    grep -q '^reason: commit_step_1' "${GREMION_ROOT}"/data/cd/outbox/*-stopped*.eml
    [ "$(st '.release.commit_attempts')" = 4 ]
}

@test "at CD_COMMIT_MAX_MIN the sequence rolls back with commit_stuck, no block, and nothing was committed" {
    echo 999 > "$FK/cd_colour_isolation_record.fails"
    seed_state 60
    run cdc_lib 'cd_commit_promote; echo "rc=$? t=$(cd_now)"'
    [[ "$output" == *"rc=1 t=$((1700000000 + 180))"* ]]
    [ "$(cat "$FK/rollback.rules")" = commit_stuck ]
    [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${OLD12}" ]
    run grep -c 'lock=free' "$SHIM_LOG"
    [ "$output" = 0 ]
}

@test "step 2 is a symlink swap that is read back, and a failing step 3 leaves step 2 done and step 4 and 5 undone" {
    seed_state 60
    cd_write_cfg CD_WATCH_MINUTES=1 CD_COMMIT_MAX_MIN=1
    rm -f "${GREMION_ROOT}/runtime/previous-tag"
    mkdir "${GREMION_ROOT}/runtime/previous-tag"
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [ "$(cat "$FK/rollback.rules")" = commit_stuck ]
    run refute_recorded fake executor_unit_action
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "pilot-${OLD12}" ]
    # the rollback here is a fake: current stays where step 2 put it, which is what the real
    # sequence moves back (its step 7); the fake proves step 2 ran and 3 to 5 did not
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${NEW12}" ]
}

@test "a retry after steps 2 to 4 ran writes the previous tag from the state, never the new tag from the file" {
    seed_state 60
    ln -sfn "${GREMION_ROOT}/releases/${NEW12}" "${GREMION_ROOT}/current"
    printf 'pilot-%s\n' "$NEW12" > "${GREMION_ROOT}/runtime/current-tag"
    printf 'pilot-%s\n' "$OLD12" > "${GREMION_ROOT}/runtime/previous-tag"
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ "$(cat "${GREMION_ROOT}/runtime/previous-tag")" = "pilot-${OLD12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "pilot-${NEW12}" ]
    [ "$(st '.release.committed_at')" != null ]
    [ "$(st '.previous.tag')" = "pilot-${OLD12}" ]
}

@test "step 4: an executor restart that fails is a warning only" {
    echo 99 > "$FK/executor_unit_action.fails"
    seed_state 60
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ "$(st '.release.committed_at')" != null ]
}

@test "a state write that fails at step 5 leaves the commit pending: the retry runs the whole sequence again" {
    seed_state 60
    cat > "$GREMION_ROOT/.wrap.sh" <<'EOF'
eval "_orig_$(declare -f cd_state_set)"
cd_state_set() {
    if [[ "$1" == *committed_at* && ! -e "$FK/step5.once" ]]; then : > "$FK/step5.once"; return 1; fi
    _orig_cd_state_set "$@"
}
EOF
    run cdc_lib ". '${GREMION_ROOT}/.wrap.sh'; cd_commit_promote; echo \"rc=\$? t=\$(cd_now)\""
    [[ "$output" == *"rc=0 t=$((1700000000 + 60))"* ]]
    [ "$(calls 'fake cd_colour_isolation_record')" -eq 2 ]
    [ "$(st '.release.committed_at')" != null ]
}

@test "step 6: switched is called for the release label and its failure is retried every 60 seconds with the lock held, a mail after three failures" {
    echo 4 > "$FK/cd_data_dumpset_retire.fails"
    seed_state 60
    cd_write_cfg CD_WATCH_MINUTES=1 CD_COMMIT_MAX_MIN=30
    run cdc_lib 'cd_commit_promote; echo "rc=$? t=$(cd_now)"'
    [[ "$output" == *"rc=0 t=$((1700000000 + 240))"* ]]
    assert_recorded fake "cd_data_dumpset_retire pilot-${NEW12}"
    [ "$(mails stopped)" -eq 1 ]
    grep -q '^reason: post_commit_6' "${GREMION_ROOT}"/data/cd/outbox/*-stopped*.eml
    run grep -c 'lock=free' "$SHIM_LOG"
    [ "$output" = 0 ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${NEW12}" ]
}

@test "step 6 given up at the cap: the hold failure post_commit_6, a mail, current and live unchanged, no rollback and no block" {
    echo 999 > "$FK/cd_data_dumpset_retire.fails"
    seed_state 60
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [ "$(st '.hold.kind')" = failure ]
    [ "$(st '.hold.reason')" = post_commit_6 ]
    [ "$(st '.live.sha12')" = "$NEW12" ]
    [ "$(st '.release.committed_at')" != null ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${NEW12}" ]
    [ "$(calls 'fake cd_rollback_run')" -eq 0 ]
    [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
    [ "$(mails stopped)" -eq 2 ]
    [ "$(calls 'fake cd_colour_down')" -eq 0 ]
}

@test "step 7 given up at the cap: the hold failure post_commit_7, no rollback and no block, the colour of the old release was the one asked to stop" {
    echo 999 > "$FK/cd_colour_down.fails"
    seed_state 60
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [ "$(st '.hold.reason')" = post_commit_7 ]
    [ "$(calls 'fake cd_rollback_run')" -eq 0 ]
    [ ! -e "${GREMION_ROOT}/data/cd/blocked.json" ]
    assert_recorded fake "cd_colour_down ${GREMION_ROOT}/releases/${OLD12} blue"
    [ "$(st '.live.sha12')" = "$NEW12" ]
}

@test "a kill after step 5 resumes forward: nothing moves current back and no rollback runs" {
    seed_state 60
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    : > "$SHIM_LOG"
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${NEW12}" ]
    [ "$(st '.live.sha12')" = "$NEW12" ]
    [ "$(calls 'fake cd_rollback_run')" -eq 0 ]
    [ "$(calls 'fake cd_colour_isolation_record')" -eq 0 ]
    [ "$(calls 'fake cd_colour_down')" -eq 1 ]
    # a committed release whose step 6 keeps failing is still never rolled back
    echo 999 > "$FK/cd_data_dumpset_retire.fails"
    : > "$SHIM_LOG"
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [ "$(calls 'fake cd_rollback_run')" -eq 0 ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${NEW12}" ]
}

@test "step 7 stops the old colour and nothing else: the worker files and the env files stay as they are" {
    seed_state 60
    local before
    before="$(cd "$GREMION_ROOT" && sha256sum etc/env/*.env runtime/workers/*)"
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ "$(cd "$GREMION_ROOT" && sha256sum etc/env/*.env runtime/workers/*)" = "$before" ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = on ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/blue")" = off ]
    [ "$(calls 'fake cd_colour_workers')" -eq 0 ]
    [ "$(calls 'fake cd_colour_down')" -eq 1 ]
    [ -d "${GREMION_ROOT}/releases/${OLD12}" ]
}

@test "cd_commit_promote releases no lock and queues the released mail once, as step 8" {
    seed_state 60
    cdc_bg 'cd_commit_promote; echo "rc=$?"; echo ready; exec sleep 30'
    wait_for "grep -q '^rc=0' '$CD_BG_OUT'"
    run cd_lib 'cd_hostlock_take'
    [ "$status" -eq 3 ]
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 3 ]
    [ "$(mails released)" -eq 1 ]
    # a resumed finish does not queue it again
    kill -9 "$CD_BG_PID"
    sleep 0.3
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ "$(mails released)" -eq 1 ]
    local body
    body="$(sed '1,/^$/d' "${GREMION_ROOT}"/data/cd/outbox/*-released*.eml)"
    [[ "$body" == *"kind: released"* ]]
    [[ "$body" == *"modules_total: 2"* ]]
    [[ "$body" == *"observed_min: 1"* ]]
    [[ "$body" == *"dump_label: pilot-${NEW12}"* ]]
    [[ "$body" != *"@"* ]]
}

@test "the released mail carries the reconcile sentence when CD_RECONCILE is 0 and the lock span when the driver says how long it was held" {
    cd_write_cfg CD_WATCH_MINUTES=1 CD_RECONCILE=0 CD_LOCK_SPAN_MIN=60
    seed_state 60
    run cdc_lib 'CD_HOSTLOCK_SINCE=$(( $(cd_now) - 7200 )); cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    local body
    body="$(sed '1,/^$/d' "${GREMION_ROOT}"/data/cd/outbox/*-released*.eml)"
    [[ "$body" == *"reconcile_not_run"* ]]
    [[ "$body" == *"lock_span_over"* ]]
    [[ "$body" == *"hostlock_min: 120"* ]]
}

@test "a rollback request that arrives while the commit retries runs the sequence" {
    echo 999 > "$FK/cd_colour_isolation_record.fails"
    seed_state 60
    cd_write_cfg CD_WATCH_MINUTES=1 CD_COMMIT_MAX_MIN=30
    run cd_lib 'cd_request_put rollback "{}"'
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=1"* ]]
    [ "$(cat "$FK/rollback.rules")" = manual_rollback ]
}

@test "the commit point refuses without a window, without both locks and without a live release, and moves nothing" {
    local before
    before="$(fp)"
    seed_state 30
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=2"* ]]
    seed_state 60
    CDC_LOCKS=cd run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=2"* ]]
    seed_state 60 auto '.live = null'
    run cdc_lib 'cd_commit_promote; echo "rc=$?"'
    [[ "$output" == *"rc=2"* ]]
    [ "$(fp)" = "$before" ]
    [ "$(calls 'fake cd_colour_isolation_record')" -eq 0 ]
}

@test "under set -euo pipefail the watch, the commit and the prune finish without tripping errexit" {
    seed_state 0
    run cdc_strict 'cd_commit_watch_loop; cd_commit_promote; echo done'
    [ "$status" -eq 0 ]
    [[ "$output" == *done* ]]
    [ "$(st '.live.sha12')" = "$NEW12" ]
}

# ------------------------------------------------------------------ the F1 trio

@test "a whole release against a fake root: current, the host programs and state.env are byte-identical until the commit step, the programs and state.env after it as well" {
    local before progs
    before="$(fp)"
    progs="$(fp_programs)"
    run cdc_lib 'cd_commit_watch_loop; echo "loop=$?"'
    [[ "$output" == *"loop=0"* ]]
    [ "$(fp)" = "$before" ]
    run cdc_lib 'cd_commit_promote; echo "promote=$?"'
    [[ "$output" == *"promote=0"* ]]
    [ "$(fp_programs)" = "$progs" ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${NEW12}" ]
    # the only things that moved: current, the two tag files and the state
    [ "$(cd "$GREMION_ROOT" && sha256sum etc/env/*.env runtime/workers/*)" = "$(echo "$before" | grep -E 'etc/env|workers')" ]
}

# ================================================================== the prune

# The docker shim for the prune tests. State is files under $DK:
#   running        the running container ids, one per line
#   ctr.<id>       "<image ref> sha256:<image id>" of a container
#   images         "<repo>:<tag> <id12>" per image, as `docker images` prints them
#   config.fail.<project>   `compose config` of that project fails
#   images.fail ps.fail     the listing fails
#   rmi.fail.<ref with / and : as _>  the removal of that reference fails
shim_docker_prune() {
    shim docker "$(cat <<'EOF'
case "$1" in
  compose)
    envf=''; prev=''; star=no
    for a in "$@"; do
        [ "$prev" = "--env-file" ] && envf="$a"
        [ "$prev" = "--profile" ] && [ "$a" = "*" ] && star=yes
        prev="$a"
    done
    proj="$(basename "$envf" .env)"
    tag="$(sed -n 's/^IMAGE_TAG=//p' "$envf")"
    case " $* " in
      *" config "*"--images"*)
        [ -f "$DK/config.fail.$proj" ] && exit 1
        [ -f "$DK/config.empty.$proj" ] && exit 0
        printf 'gremion-ui:%s\ngremion-public:%s\n' "$tag" "$tag"
        [ "$star" = yes ] && printf 'gremion-migrate:%s\n' "$tag"
        [ "$proj" = state ] && echo 'postgres:16'
        exit 0 ;;
    esac
    exit 0 ;;
  ps)
    [ -f "$DK/ps.fail" ] && exit 1
    [ -f "$DK/running" ] && cat "$DK/running"
    exit 0 ;;
  inspect)
    id="${@: -1}"
    cat "$DK/ctr.$id"
    exit 0 ;;
  images)
    [ -f "$DK/images.fail" ] && exit 1
    cat "$DK/images"
    exit 0 ;;
  rmi)
    ref="${@: -1}"
    key="$(printf '%s' "$ref" | tr '/:' '__')"
    [ -f "$DK/rmi.fail.$key" ] && exit 1
    exit 0 ;;
  info)
    printf '%s\n' "$DK/dockerroot"
    exit 0 ;;
esac
exit 0
EOF
)"
    shim df 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1000000000 1 %s 1%% /\n" "$(cat "$DK/df.kb")"'
}

# seed_prune -- a live release (green, pilot-bbbb), a previous one (blue, pilot-aaaa), a state
# project that still carries an older tag (pilot-1111), a running container of the live colour.
seed_prune() {
    DK="${SHIM_DIR}/dk"
    export DK
    mkdir -p "$DK/dockerroot"
    shim_docker_prune
    export STACK=teststack
    # after the commit point: live = new (green), previous = old (blue)
    seed_state 60 auto ".live = (.release | {sha, sha12, tag, colour, tree, since: \"2026-11-17T02:00:00Z\", proof: false, modules: null, leaves: null, reconcile: null}) | .previous = {sha: (\"a\" * 40), sha12: \"aaaaaaaaaaaa\", tag: \"pilot-aaaaaaaaaaaa\", colour: \"blue\", tree: \"${GREMION_ROOT}/releases/aaaaaaaaaaaa\", startable: true} | .release.committed_at = \"2026-11-17T02:00:00Z\""
    sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=pilot-${NEW12}/" "${GREMION_ROOT}/etc/env/app-green.env"
    echo c1 > "$DK/running"
    echo "gremion-ui:pilot-${NEW12} sha256:$(printf 'b%.0s' $(seq 1 64))" > "$DK/ctr.c1"
    printf '%s\n' \
        "gremion-ui:pilot-${NEW12} bbbbbbbbbbbb" "gremion-public:pilot-${NEW12} bbbbbbbbbbbb" "gremion-migrate:pilot-${NEW12} bbbbbbbbbbbb" \
        "gremion-ui:pilot-${OLD12} aaaaaaaaaaaa" "gremion-public:pilot-${OLD12} aaaaaaaaaaaa" "gremion-migrate:pilot-${OLD12} aaaaaaaaaaaa" \
        "gremion-ui:pilot-111111111111 111111111111" "gremion-public:pilot-111111111111 111111111111" "gremion-migrate:pilot-111111111111 111111111111" \
        "gremion-ui:pilot-dddddddddddd dddddddddddd" "gremion-migrate:pilot-dddddddddddd dddddddddddd" \
        "gremion-ui:pilot-eeeeeeeeeeee eeeeeeeeeeee" \
        "gremion-ui:latest cccccccccccc" "postgres:16 ffffffffffff" "gremion-ui:pilot-short 999999999999" > "$DK/images"
    echo 104857600 > "$DK/df.kb"
}

removed_refs() { grep '^docker rmi ' "$SHIM_LOG" | cut -d' ' -f3; }

@test "prune: the keep set is the union of the images of ALL THREE env files; an older tag in state.env keeps that tag's images" {
    seed_prune
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"rc=0"* ]]
    local gone
    gone="$(removed_refs | sort | tr '\n' ' ')"
    [ "$gone" = "gremion-migrate:pilot-dddddddddddd gremion-ui:pilot-dddddddddddd gremion-ui:pilot-eeeeeeeeeeee " ]
}

@test "prune: the one-shot images that only appear under the profile star are kept, and the star is on the argv of the three config calls" {
    seed_prune
    sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=pilot-dddddddddddd/" "${GREMION_ROOT}/etc/env/state.env"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    run bash -c "grep -c \"config --images\" '$SHIM_LOG'"
    [ "$output" -ge 3 ]
    run bash -c "grep 'config --images' '$SHIM_LOG' | grep -c -- \"--profile \\*\""
    [ "$output" -ge 3 ]
    # pilot-dddd is now the state project's tag: its one-shot is in the keep set only through the star
    run removed_refs
    [[ "$output" != *"pilot-dddddddddddd"* ]]
    [[ "$output" == *"pilot-eeeeeeeeeeee"* ]]
}

@test "prune: image prune -a and rmi -f never appear, and only pilot-<12 hex> tags outside the keep set are removed" {
    seed_prune
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune'
    [ "$(removed_refs | wc -l)" -eq 3 ]
    run refute_recorded docker "image prune"
    [ "$status" -eq 0 ]
    run refute_recorded docker "rmi -f"
    [ "$status" -eq 0 ]
    run refute_recorded docker "--force"
    [ "$status" -eq 0 ]
    run removed_refs
    [[ "$output" != *"latest"* ]]
    [[ "$output" != *"postgres"* ]]
    [[ "$output" != *"pilot-short"* ]]
    [[ "$output" != *"pilot-${NEW12}"* ]]
    [[ "$output" != *"pilot-${OLD12}"* ]]
    [[ "$output" != *"pilot-111111111111"* ]]
}

@test "prune: an image a running container uses is never removed, whatever its tag" {
    seed_prune
    echo "gremion-ui:pilot-dddddddddddd sha256:$(printf 'd%.0s' $(seq 1 64))" > "$DK/ctr.c1"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    run removed_refs
    [[ "$output" != *"gremion-ui:pilot-dddddddddddd"* ]]
    [[ "$output" != *"gremion-migrate:pilot-dddddddddddd"* ]]
    [[ "$output" == *"pilot-eeeeeeeeeeee"* ]]
}

@test "prune fails closed: a project that cannot be listed, one that lists nothing, no running container, an image list that fails each remove nothing" {
    seed_prune
    touch "$DK/config.fail.app-green"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [[ "$output" == *"rc=4"* ]]
    rm -f "$DK/config.fail.app-green"
    touch "$DK/config.empty.state"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [[ "$output" == *"rc=4"* ]]
    rm -f "$DK/config.empty.state"
    : > "$DK/running"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [[ "$output" == *"rc=4"* ]]
    echo c1 > "$DK/running"
    touch "$DK/images.fail"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [[ "$output" == *"rc=4"* ]]
    touch "$DK/ps.fail"
    rm -f "$DK/images.fail"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [[ "$output" == *"rc=4"* ]]
    run removed_refs
    [ -z "$output" ]
    [ -d "${GREMION_ROOT}/releases/${OLD12}" ]
}

@test "prune: release trees other than live, previous, in flight and what current names are removed, and only short-SHA directories" {
    seed_prune
    mkdir -p "${GREMION_ROOT}/releases/cccccccccccc" "${GREMION_ROOT}/releases/notasha" "${GREMION_ROOT}/releases/.fetch-x"
    ln -s "${GREMION_ROOT}/releases/${OLD12}" "${GREMION_ROOT}/releases/dddddddddddd"
    ln -sfn "${GREMION_ROOT}/releases/cccccccccccc" "${GREMION_ROOT}/current"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ -d "${GREMION_ROOT}/releases/${OLD12}" ]
    [ -d "${GREMION_ROOT}/releases/${NEW12}" ]
    [ -d "${GREMION_ROOT}/releases/cccccccccccc" ]
    [ -d "${GREMION_ROOT}/releases/notasha" ]
    [ -d "${GREMION_ROOT}/releases/.fetch-x" ]
    [ -L "${GREMION_ROOT}/releases/dddddddddddd" ]
    mkdir "${GREMION_ROOT}/releases/123456789abc"
    ln -sfn "${GREMION_ROOT}/releases/${NEW12}" "${GREMION_ROOT}/current"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [ ! -e "${GREMION_ROOT}/releases/123456789abc" ]
    [ ! -e "${GREMION_ROOT}/releases/cccccccccccc" ]
    [ -d "${GREMION_ROOT}/releases/${OLD12}" ]
}

@test "prune: the build cache is pruned with the configured keep size when the disk is low and left alone when it is not" {
    seed_prune
    cd_write_cfg CD_WATCH_MINUTES=1 CD_BUILD_CACHE_KEEP_GB=7 CD_MIN_FREE_GB=15
    echo 5242880 > "$DK/df.kb"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    assert_recorded docker "builder prune -f --keep-storage 7GB"
    : > "$SHIM_LOG"
    echo 104857600 > "$DK/df.kb"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    run refute_recorded docker "builder prune"
    [ "$status" -eq 0 ]
}

@test "prune: failed-release logs older than 14 days are removed, recent ones and other files stay" {
    seed_prune
    local now=1700000000 old recent
    old="${GREMION_ROOT}/logs/cd-failed-${NEW12}.log"
    recent="${GREMION_ROOT}/logs/cd-failed-${OLD12}.log"
    : > "$old"
    : > "$recent"
    : > "${GREMION_ROOT}/logs/cd-rollback-pilot-${NEW12}-1690000000.log"
    : > "${GREMION_ROOT}/logs/isolation.log"
    touch -d "@$((now - 15 * 86400))" "$old" "${GREMION_ROOT}/logs/cd-rollback-pilot-${NEW12}-1690000000.log" "${GREMION_ROOT}/logs/isolation.log"
    touch -d "@$((now - 13 * 86400))" "$recent"
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    [[ "$output" == *"rc=0"* ]]
    [ ! -e "$old" ]
    [ ! -e "${GREMION_ROOT}/logs/cd-rollback-pilot-${NEW12}-1690000000.log" ]
    [ -e "$recent" ]
    [ -e "${GREMION_ROOT}/logs/isolation.log" ]
}

@test "prune writes counts to the history and names no image reference" {
    seed_prune
    run cdc_lib '. "${HOST_SRC}/lib/cd/docker.sh"; cd_commit_prune; echo "rc=$?"'
    run grep prune_done "${GREMION_ROOT}/data/cd/history.jsonl"
    [ "$status" -eq 0 ]
    [[ "$output" == *'"images":3'* ]]
    [[ "$output" != *"gremion-ui"* ]]
}
