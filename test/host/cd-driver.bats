#!/usr/bin/env bats
# test/host/cd-driver.bats -- cd-driver: lib/cd/driver.sh (the tick, the boot resume, the
# pipeline composition, the failure policy, THE LINE, the requests, release-now, rollback and
# reconcile).
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-driver.bats
#
# The driver runs from a copy of the host tree that holds only common.sh, core.sh, cmd-state.sh
# and driver.sh. Every function another unit owns is the helper's stub (test_helper/cd.bash),
# widened by fixtures/cd/driver/stubs.sh with hooks, so a stage can fail, write state, probe the
# locks or kill the program. Every address is a reserved example name.
#
# The guards of THE LINE are separate checks in driver.sh, marked LINE-1 to LINE-5 there; the
# drill that watches each one go red copies the tree, removes that one check and runs the test
# (HOST_SRC points the suite at the copy).

load 'test_helper/host'
load 'test_helper/cd'

SHA_A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
SHA_B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
SHA_C=cccccccccccccccccccccccccccccccccccccccc
TAG_B=pilot-bbbbbbbbbbbb
GREEN='{"verdict":"green","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reason":"","final":true,"tip":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","walked":0}'
CLEAN='{"v":1,"app_only":true,"state_tier":[],"holds":[],"hold":null,"compose":"checked","migrations":{"total":0,"chains":{}}}'
DRV_PREV='{"sha":"dddddddddddddddddddddddddddddddddddddddd","sha12":"dddddddddddd","tag":"pilot-dddddddddddd","colour":"green","tree":"/opt/gremion/releases/dddddddddddd","startable":true}'
DRV_REL='{"id":"bbbbbbbbbbbb-1","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","sha12":"bbbbbbbbbbbb","tag":"pilot-bbbbbbbbbbbb","colour":"green","tree":"/opt/gremion/releases/bbbbbbbbbbbb","from_sha12":"aaaaaaaaaaaa","mode":"auto","with_state":false,"stage":"select","stage_status":"ok","attempt":1,"class":null,"dump_label":null,"rollback_target":null,"retag_prev":null,"workers":"off","modules":null,"leaves":null,"switch_started":false,"commit_attempts":0,"committed_at":null,"timing":{"snapshot_s":0,"module_s":0},"started_at":"2026-11-17T00:00:00Z","switched_at":null,"watch":{"observed_s":0,"samples":0,"bad_streak":0,"paused_s":0,"blind":0,"requests":0,"baseline_5xx":null,"baseline_not_ready":null,"last_sample_epoch":0},"failure":null}'
DRV_STAGES="select fetch classify retag render build snapshot migrate start gates switch watch commit reconcile"

setup() {
    cd_setup
    drv_setup
}
teardown() { cd_teardown; }

drv_setup() {
    local src="${GREMION_ROOT}/.host-driver" orig="$HOST_SRC"
    mkdir -p "${src}/lib/cd" "${src}/bin"
    cp "${orig}/lib/common.sh" "${src}/lib/"
    cp "${orig}/lib/cd/core.sh" "${orig}/lib/cd/cmd-state.sh" "${orig}/lib/cd/driver.sh" "${src}/lib/cd/"
    cp "${orig}/bin/gremion-cd" "${src}/bin/"
    export HOST_SRC="$src"
    cat "${CD_FIXTURES}/driver/stubs.sh" >> "${GREMION_CD_STUBS_DIR}/cd-stubs.sh"
    shim sudo
    # the clean answers of the stand-ins: a green candidate, a clean class, a switch that records
    # switch_started, a commit that writes committed_at
    cd_stub_set cd_gh_candidate 0 "$GREEN"
    cd_stub_set cd_classify 0 "$CLEAN"
    cd_stub_set cd_data_live_signal_read 0 ok
    export CD_STUB_HOOK_cd_traffic_switch='drv_switch_started'
    export CD_STUB_HOOK_cd_commit_promote='drv_step5'
    # a fake root whose files the driver must never move
    mkdir -p "${GREMION_ROOT}/releases/aaaaaaaaaaaa" "${GREMION_ROOT}/releases/bbbbbbbbbbbb" "${GREMION_ROOT}/etc/env"
    ln -s releases/aaaaaaaaaaaa "${GREMION_ROOT}/current"
    printf 'IMAGE_TAG=pilot-aaaaaaaaaaaa\n' > "${GREMION_ROOT}/etc/env/app-blue.env"
    printf 'IMAGE_TAG=pilot-bbbbbbbbbbbb\n' > "${GREMION_ROOT}/etc/env/app-green.env"
    printf 'blue\n' > "${GREMION_ROOT}/runtime/active-colour"
}

# -- state seeds ------------------------------------------------------------------------
drv_seed() { cd_seed_state ".live = ${CD_LIVE_JSON} | .previous = ${DRV_PREV} | ${1:-.}"; }
# drv_seed_rel STAGE STATUS [FILTER] -- a release of sha B in flight
drv_seed_rel() {
    drv_seed ".phase = \"releasing\" | .release = ${DRV_REL} | .release.stage = \"$1\" | .release.stage_status = \"$2\" | ${3:-.}"
}
# drv_seed_sw STAGE STATUS [FILTER] -- the same, after switch_started (phase watching)
drv_seed_sw() { drv_seed_rel "$1" "$2" ".phase = \"watching\" | .release.switch_started = true | ${3:-.}"; }
# drv_seed_commit STAGE STATUS [FILTER] -- committed (commit step 5 done)
drv_seed_commit() {
    drv_seed_sw "$1" "$2" ".release.committed_at = \"2026-11-17T00:30:00Z\" | .live = ((${CD_LIVE_JSON}) | .sha = \"${SHA_B}\" | .sha12 = \"bbbbbbbbbbbb\" | .tag = \"${TAG_B}\" | .colour = \"green\" | .tree = \"/opt/gremion/releases/bbbbbbbbbbbb\") | ${3:-.}"
}

# -- reading what happened ----------------------------------------------------------------
drv_state() { jq -r "$1" "${GREMION_ROOT}/data/cd/state.json"; }
drv_hist() {
    if [ ! -f "${GREMION_ROOT}/data/cd/history.jsonl" ]; then echo 0; return 0; fi
    jq -s --arg e "$1" '[.[] | select(.event == $e)] | length' "${GREMION_ROOT}/data/cd/history.jsonl"
}
drv_n() { grep -c -- "$1" "$SHIM_LOG" || true; }
drv_first() { grep -n -m1 -- "$1" "$SHIM_LOG" | cut -d: -f1 || true; }
# drv_order PATTERN... -- the first line of each pattern, in this order
drv_order() {
    local prev=0 cur p
    for p in "$@"; do
        cur="$(drv_first "$p")"
        [ -n "$cur" ] || { echo "not in the log: ${p}" >&2; cat "$SHIM_LOG" >&2; return 1; }
        [ "$cur" -gt "$prev" ] || { echo "out of order: ${p}" >&2; cat "$SHIM_LOG" >&2; return 1; }
        prev="$cur"
    done
}
drv_fingerprint() {
    {
        readlink "${GREMION_ROOT}/current"
        cat "${GREMION_ROOT}/etc/env/app-blue.env" "${GREMION_ROOT}/etc/env/app-green.env" "${GREMION_ROOT}/runtime/active-colour"
        jq -S '{live, previous}' "${GREMION_ROOT}/data/cd/state.json"
    } | sha256sum
}
drv_blocks() { if [ -f "${GREMION_ROOT}/data/cd/blocked.json" ]; then jq -r 'length' "${GREMION_ROOT}/data/cd/blocked.json"; else echo 0; fi; }
drv_mails() { grep -c "^stub cd_notify $1" "$SHIM_LOG" || true; }

# drv_wait CMD -- poll a condition for up to 10 seconds
drv_wait() {
    local i
    for i in $(seq 1 100); do
        if eval "$1" 2>/dev/null; then return 0; fi
        sleep 0.1
    done
    echo "drv_wait: never true: $1" >&2
    return 1
}
# drv_bg_tick [ARGS] -- a tick in the background (fd 3 closed)
drv_bg_tick() {
    "${HOST_SRC}/bin/gremion-cd" tick "$@" > "${GREMION_ROOT}/.bg.out" 2>&1 3>&- < /dev/null &
    DRV_BG_PID=$!
    CD_BG_PIDS+=("$DRV_BG_PID")
}
drv_hostlock_free() { ( exec 9>>"${GREMION_ROOT}/runtime/hostd.lock"; flock -n 9 ); }

# ===========================================================================================
# tick
# ===========================================================================================

@test "tick: a busy cd lock exits 3 and does nothing" {
    cd_need_flock
    drv_seed
    cd_bg 'cd_lock_take; echo ready; exec sleep 300'
    run cd_prog tick
    [ "$status" -eq 3 ]
    [ "$(drv_n '^stub cd_gh_candidate')" -eq 0 ]
}

@test "tick: the kill switch with phase idle exits 0, mails once, asks for no candidate and sends no digest" {
    cd_need_flock
    drv_seed
    : > "${GREMION_ROOT}/etc/cd.disabled"
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_gh_candidate')" -eq 0 ]
    [ "$(drv_n '^stub cd_notify killswitch')" -eq 1 ]
    [ "$(drv_n '^stub cd_notify_digest')" -eq 0 ]
}

@test "tick: the kill switch with a release in flight does not exit: it parks holding both locks, and a rollback request still runs the sequence" {
    cd_need_flock
    drv_seed_sw watch started
    : > "${GREMION_ROOT}/etc/cd.disabled"
    drv_bg_tick
    drv_wait "[ \"\$(grep -c killswitch_park '${GREMION_ROOT}/data/cd/history.jsonl')\" -ge 1 ]"
    # a competing taker is refused while the process parks: it holds the host lock
    run cd_lib 'cd_hostlock_take 0'
    [ "$status" -eq 3 ]
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 3 ]
    kill -0 "$DRV_BG_PID"
    # the operator's rollback is still honoured
    run cd_lib 'cd_request_put rollback "{\"reason\":\"\"}"'
    [ "$status" -eq 0 ]
    drv_wait "! kill -0 ${DRV_BG_PID} 2>/dev/null"
    assert_recorded stub "cd_rollback_run manual_rollback"
    [ "$(drv_state '.phase')" = idle ]
    [ "$(drv_state '.release')" = null ]
}

@test "tick: the kill switch parks, and the watch goes on where it was when the file is gone" {
    cd_need_flock
    drv_seed_sw watch started
    : > "${GREMION_ROOT}/etc/cd.disabled"
    drv_bg_tick
    drv_wait "[ \"\$(grep -c killswitch_park '${GREMION_ROOT}/data/cd/history.jsonl')\" -ge 1 ]"
    rm -f "${GREMION_ROOT}/etc/cd.disabled"
    drv_wait "! kill -0 ${DRV_BG_PID} 2>/dev/null"
    assert_recorded stub "cd_commit_watch_loop"
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
}

@test "tick: requests are drained in order" {
    cd_need_flock
    drv_seed
    cd_stub_set cd_gh_candidate 0 '{"verdict":"none","sha":"","reason":"up_to_date","final":true}'
    cd_lib 'cd_request_put hold "{\"reason\":\"first\"}"'
    cd_lib 'cd_request_put resume "{\"reason\":\"second\"}"'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.hold')" = null ]
    local a b
    a="$(grep -n hold_requested "${GREMION_ROOT}/data/cd/history.jsonl" | cut -d: -f1)"
    b="$(grep -n '"resumed"' "${GREMION_ROOT}/data/cd/history.jsonl" | cut -d: -f1)"
    [ "$a" -lt "$b" ]
}

@test "tick: a held host does nothing and does not mail" {
    drv_seed '.hold = {"kind":"failure","reason":"build_failed","sha12":"bbbbbbbbbbbb","since":"2026-11-17T00:00:00Z"}'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_gh_candidate')" -eq 0 ]
    [ "$(drv_n '^stub cd_notify ')" -eq 0 ]
}

@test "tick: a clean tick calls cd_ping and cd_notify_digest" {
    drv_seed
    cd_stub_set cd_gh_candidate 0 '{"verdict":"none","sha":"","reason":"up_to_date","final":true}'
    run cd_prog tick
    [ "$status" -eq 0 ]
    assert_recorded stub "cd_notify_digest"
    assert_recorded stub "cd_ping"
    assert_recorded stub "cd_notify_flush"
}

@test "tick: a fatal state error calls cd_alert before it exits 2 (an unreadable state, a missing one)" {
    printf 'not json' > "${GREMION_ROOT}/data/cd/state.json"
    run cd_prog tick
    [ "$status" -eq 2 ]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
    rm -f "${GREMION_ROOT}/data/cd/ALERT" "${GREMION_ROOT}/data/cd/state.json"
    run cd_prog tick
    [ "$status" -eq 2 ]
    [ -s "${GREMION_ROOT}/data/cd/ALERT" ]
}

@test "tick: the poll is stored in the state (verdict, tip, time)" {
    drv_seed
    cd_stub_set cd_gh_candidate 0 '{"verdict":"none","sha":"","reason":"no_green_commit","final":true,"tip":"cccccccccccccccccccccccccccccccccccccccc"}'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.poll.verdict')" = red ]
    [ "$(drv_state '.poll.tip12')" = cccccccccccc ]
    [ "$(drv_state '.poll.last_ok')" = true ]
    # a final none is "none", a not final one is asked again ("pending")
    cd_stub_set cd_gh_candidate 0 '{"verdict":"none","sha":"","reason":"tip_unreachable","final":false}'
    run cd_prog tick
    [ "$(drv_state '.poll.verdict')" = pending ]
}

# ===========================================================================================
# the happy path and its composition
# ===========================================================================================

@test "pipeline: a green candidate runs the stages in the order of the plan and commits" {
    drv_seed
    run cd_prog tick
    [ "$status" -eq 0 ]
    drv_order '^stub cd_prepare_precheck' '^stub cd_watch_baseline' '^stub cd_prepare_fetch' '^stub cd_classify' \
        '^stub cd_prepare_retag ' '^stub cd_prepare_render' '^stub cd_prepare_build' '^stub cd_data_timer_guard' \
        '^stub cd_data_precheck' '^stub cd_data_dumpset_take' '^stub cd_data_migrate' '^stub cd_colour_start' \
        '^stub cd_wait_healthy' '^stub cd_colour_identity' '^stub cd_colour_gates' '^stub cd_traffic_switch' \
        '^stub cd_traffic_confirm' '^stub cd_commit_watch_loop' '^stub cd_commit_promote' '^stub cd_commit_prune' \
        '^stub cd_reconcile_run'
    [ "$(drv_state '.phase')" = idle ]
    [ "$(drv_state '.release')" = null ]
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
    [ "$(drv_state '.previous.sha12')" = aaaaaaaaaaaa ]
    [ "$(drv_state '.hold')" = null ]
    # the stages ran on the other colour, from the release tree and the tag of the sha
    assert_recorded stub "cd_prepare_build ${GREMION_ROOT}/releases/bbbbbbbbbbbb green ${TAG_B}"
    assert_recorded stub "cd_data_dumpset_take ${TAG_B} app"
    assert_recorded stub "cd_colour_start ${GREMION_ROOT}/releases/bbbbbbbbbbbb green ${TAG_B}"
    assert_recorded stub "cd_wait_healthy app-green"
    # the next candidate is not asked for in the same tick
    [ "$(drv_n '^stub cd_gh_candidate')" -eq 1 ]
}

@test "pipeline: every stage runs under its own heartbeat, and the beat is stopped on every path" {
    drv_seed
    export CD_STUB_HOOK_cd_prepare_build='printf "hb %s\n" "$(cut -d" " -f3 "${CD_HEARTBEAT_FILE}")" >> "$SHIM_LOG"'
    export CD_STUB_HOOK_cd_colour_gates='printf "hb %s\n" "$(cut -d" " -f3 "${CD_HEARTBEAT_FILE}")" >> "$SHIM_LOG"'
    export CD_STUB_HOOK_cd_reconcile_run='printf "hb %s\n" "$(cut -d" " -f3 "${CD_HEARTBEAT_FILE}")" >> "$SHIM_LOG"'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(grep -c '^hb build$' "$SHIM_LOG")" -eq 1 ]
    [ "$(grep -c '^hb gates$' "$SHIM_LOG")" -eq 1 ]
    [ "$(grep -c '^hb reconcile$' "$SHIM_LOG")" -eq 1 ]
    # the beat of a stage that fails is stopped too (no beat left running in this shell)
    drv_seed_rel select ok
    run cd_lib '. "${HOST_SRC}/lib/cd/driver.sh"; cd_cfg_load; cd_lock_take; _cd_drv_load; CD_DRV_ATT=1; _cd_drv_run fetch 100 false </dev/null; echo "pid=[${CD_HB_PID:-}]"'
    [[ "$output" == *"pid=[]"* ]]
    [ "$(drv_state '.hold.reason')" = fetch_failed ]
}

@test "locks: the host lock is taken at snapshot after the timer guard, held to the commit point, free in the reconcile stage; the cd lock is held to the end" {
    cd_need_flock
    drv_seed
    export CD_STUB_HOOK_cd_data_timer_guard='drv_probe before_guard'
    export CD_STUB_HOOK_cd_data_dumpset_take='drv_probe at_dump; printf "held=%s\n" "${GREMION_HOST_LOCK_HELD:-}" >> "$SHIM_LOG"'
    export CD_STUB_HOOK_cd_prepare_build='drv_probe at_build'
    export CD_STUB_HOOK_cd_commit_prune='drv_probe at_prune'
    export CD_STUB_HOOK_cd_reconcile_run='drv_probe at_reconcile'
    run cd_prog tick
    [ "$status" -eq 0 ]
    grep -q '^probe at_build host=FREE cd=HELD$' "$SHIM_LOG"
    grep -q '^probe before_guard host=FREE cd=HELD$' "$SHIM_LOG"
    grep -q '^probe at_dump host=HELD cd=HELD$' "$SHIM_LOG"
    grep -q '^held=1$' "$SHIM_LOG"
    grep -q '^probe at_prune host=HELD cd=HELD$' "$SHIM_LOG"
    grep -q '^probe at_reconcile host=FREE cd=HELD$' "$SHIM_LOG"
    drv_order '^probe at_prune' '^stub cd_reconcile_run'
    # after the tick both are free
    drv_hostlock_free
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 0 ]
}

@test "locks: a crash (kill -9) at snapshot leaves no lock behind, and the next tick can take it" {
    cd_need_flock
    drv_seed
    export CD_STUB_HOOK_cd_data_dumpset_take='drv_killme'
    run cd_prog tick
    [ "$status" -eq 137 ]
    drv_hostlock_free
    run cd_lib 'cd_lock_take && cd_hostlock_take 0'
    [ "$status" -eq 0 ]
}

@test "reconcile composition: promote, prune, the host lock released, THEN the stage under the cd lock, then the cd lock is released" {
    cd_need_flock
    drv_seed
    export CD_STUB_HOOK_cd_reconcile_run='drv_probe in_stage; cd_stage_ok reconcile >/dev/null; printf "stage=%s\n" "$(cd_state_get ".release.stage")" >> "$SHIM_LOG"'
    run cd_prog tick
    [ "$status" -eq 0 ]
    drv_order '^stub cd_commit_promote' '^stub cd_commit_prune' '^probe in_stage'
    grep -q '^probe in_stage host=FREE cd=HELD$' "$SHIM_LOG"
    grep -q '^stage=reconcile$' "$SHIM_LOG"
    # the host lock is not taken again for the stage by the driver
    [ "$(drv_state '.phase')" = idle ]
    run cd_lib 'cd_lock_take'
    [ "$status" -eq 0 ]
}

@test "reconcile composition: a failing stage is no rollback, no block, nothing moved; hold reconcile_failed, one mail, phase idle" {
    drv_seed
    export CD_STUB_HOOK_cd_reconcile_run='cd_hold_set reconcile_failed canary bbbbbbbbbbbb; cd_notify reconcile_failed sha12=bbbbbbbbbbbb reason=canary; return 1'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
    [ "$(drv_blocks)" -eq 0 ]
    [ "$(drv_state '.hold.kind')" = reconcile_failed ]
    [ "$(drv_state '.hold.reason')" = canary ]
    [ "$(drv_state '.phase')" = idle ]
    [ "$(drv_state '.release')" = null ]
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
    [ "$(drv_mails reconcile_failed)" -eq 1 ]
    [ "$(readlink "${GREMION_ROOT}/current")" = releases/aaaaaaaaaaaa ]
    [ "$(drv_n '^stub cd_colour_down')" -eq 0 ]
}

@test "reconcile composition: a stage that fails without setting its hold still ends as hold reconcile_failed, never a rollback (guard: not routed into the commit failure policy)" {
    drv_seed
    cd_stub_set cd_reconcile_run 1
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.hold.kind')" = reconcile_failed ]
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
    [ "$(drv_blocks)" -eq 0 ]
    [ "$(drv_n '^stub cd_colour_down')" -eq 0 ]
}

@test "reconcile composition: CD_RECONCILE=0 skips the stage" {
    cd_write_cfg CD_RECONCILE=0
    drv_seed
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_reconcile_run')" -eq 0 ]
    [ "$(drv_state '.phase')" = idle ]
    [ "$(drv_hist reconcile_skipped)" -eq 1 ]
}

@test "reconcile composition: a kill at the stage boundary and one mid-stage do not run the stage again: the next tick holds reconcile_failed (interrupted), and --resume-only does the same without the host lock" {
    cd_need_flock
    # mid-stage
    drv_seed
    export CD_STUB_HOOK_cd_reconcile_run='drv_killme'
    run cd_prog tick
    [ "$status" -eq 137 ]
    [ "$(drv_n '^stub cd_reconcile_run')" -eq 1 ]
    [ "$(drv_state '.release.stage')" = reconcile ]
    unset CD_STUB_HOOK_cd_reconcile_run
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_reconcile_run')" -eq 1 ]
    [ "$(drv_state '.hold.kind')" = reconcile_failed ]
    [ "$(drv_state '.hold.reason')" = interrupted ]
    [ "$(drv_state '.phase')" = idle ]
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
    # at the boundary (commit ok, reconcile not begun): the boot unit ends it, takes no host lock
    drv_seed_commit commit ok
    : > "$SHIM_LOG"
    hold_host_lock 20
    run cd_prog tick --resume-only
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_reconcile_run')" -eq 0 ]
    [ "$(drv_state '.hold.reason')" = interrupted ]
    [ "$(drv_state '.phase')" = idle ]
}

# ===========================================================================================
# --resume-only
# ===========================================================================================

@test "resume-only: with phase idle it exits 0 at once, without a lock" {
    cd_need_flock
    drv_seed
    cd_bg 'cd_lock_take; echo ready; exec sleep 300'
    run cd_prog tick --resume-only
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_gh_candidate')" -eq 0 ]
}

@test "resume-only: with a release in flight it takes the host lock first and resumes in the same process" {
    cd_need_flock
    drv_seed_rel build ok
    export CD_STUB_HOOK_cd_data_timer_guard='drv_probe at_guard'
    run cd_prog tick --resume-only
    [ "$status" -eq 0 ]
    # the lock was already held when the first stage after the build began
    drv_order '^stub cd_data_timer_guard' '^stub cd_commit_promote'
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
    [ "$(drv_n '^stub cd_gh_candidate')" -eq 0 ]
}

@test "resume-only: a watching release takes the lock before the loop, and the kill switch parks it holding the lock" {
    cd_need_flock
    drv_seed_sw watch started
    export CD_STUB_HOOK_cd_commit_watch_loop='drv_probe in_loop'
    run cd_prog tick --resume-only
    [ "$status" -eq 0 ]
    grep -q '^probe in_loop host=HELD cd=HELD$' "$SHIM_LOG"
    drv_seed_sw watch started
    : > "${GREMION_ROOT}/etc/cd.disabled"
    drv_bg_tick --resume-only
    drv_wait "[ \"\$(grep -c killswitch_park '${GREMION_ROOT}/data/cd/history.jsonl')\" -ge 1 ]"
    run cd_lib 'cd_hostlock_take 0'
    [ "$status" -eq 3 ]
    kill "$DRV_BG_PID"
}

@test "resume-only: a committed release in stage commit has steps 6 to 10 finished and is then ended as interrupted, the stage is not run" {
    cd_need_flock
    drv_seed_commit commit started
    export CD_STUB_HOOK_cd_commit_prune='drv_probe at_prune'
    run cd_prog tick --resume-only
    [ "$status" -eq 0 ]
    drv_order '^stub cd_commit_promote' '^stub cd_commit_prune'
    [ "$(drv_n '^stub cd_reconcile_run')" -eq 0 ]
    [ "$(drv_state '.hold.reason')" = interrupted ]
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
    drv_hostlock_free
}

# ===========================================================================================
# the start gates
# ===========================================================================================

@test "start gates: a refusal of the precheck starts nothing, says why, and is recorded once per change" {
    drv_seed
    export CD_STUB_HOOK_cd_prepare_precheck='CD_PREPARE_WHY=policy_ack; return 2'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [[ "$output" == *"policy_ack"* ]]
    [ "$(drv_n '^stub cd_prepare_fetch')" -eq 0 ]
    [ "$(drv_state '.release')" = null ]
    [ "$(drv_hist start_refused)" -eq 1 ]
    run cd_prog tick
    [ "$(drv_hist start_refused)" -eq 1 ]
    export CD_STUB_HOOK_cd_prepare_precheck='CD_PREPARE_WHY=quiet_window; return 3'
    run cd_prog tick
    [ "$(drv_hist start_refused)" -eq 2 ]
    [[ "$output" == *"quiet_window"* ]]
}

@test "start gates: the hold gates the tick, an operator hold is not cleared by a tick" {
    drv_seed '.hold = {"kind":"operator","reason":"requested","sha12":"","since":"2026-11-17T00:00:00Z"}'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_prepare_precheck')" -eq 0 ]
    [ "$(drv_state '.hold.kind')" = operator ]
}

# ===========================================================================================
# classifier holds
# ===========================================================================================

@test "classifier holds: a held candidate mails once with its command; the same candidate on the next tick mails nothing and does no work; resume leaves the hold in place" {
    drv_seed
    cd_stub_set cd_classify 0 '{"v":1,"holds":[{"kind":"state_tier","reason":"edge"}],"hold":{"kind":"state_tier","reason":"edge"},"migrations":{"total":0}}'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.hold.kind')" = state_tier ]
    [ "$(drv_state '.hold.sha12')" = bbbbbbbbbbbb ]
    [ "$(drv_state '.release')" = null ]
    [ "$(drv_mails held)" -eq 1 ]
    grep -q "^stub cd_notify held .*command=gremion-cd release-now bbbbbbbbbbbb --with-state" "$SHIM_LOG"
    [ "$(drv_n '^stub cd_prepare_build')" -eq 0 ]
    : > "$SHIM_LOG"
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_mails held)" -eq 0 ]
    [ "$(drv_n '^stub cd_prepare_fetch')" -eq 0 ]
    # resume leaves a classifier hold alone
    cd_lib 'cd_request_put resume "{\"reason\":\"x\"}"'
    run cd_prog tick
    [ "$(drv_state '.hold.kind')" = state_tier ]
    [ "$(drv_hist resume_refused)" -eq 1 ]
}

@test "classifier holds: a NEW clean candidate clears the hold by itself and starts" {
    drv_seed '.hold = {"kind":"state_tier","reason":"edge","sha12":"cccccccccccc","since":"2026-11-17T00:00:00Z"}'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.hold')" = null ]
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
    [ "$(drv_n '^stub cd_commit_promote')" -eq 1 ]
}

@test "classifier holds: every hold of the classifier is a hold, not only the first (a candidate that holds twice)" {
    drv_seed
    cd_stub_set cd_classify 0 '{"v":1,"holds":[{"kind":"unsupported_chain","reason":"chain_unadopted:board"},{"kind":"state_tier","reason":"edge"}],"hold":{"kind":"unsupported_chain","reason":"chain_unadopted:board"},"migrations":{"total":0}}'
    run cd_prog tick
    [ "$(drv_state '.hold.kind')" = unsupported_chain ]
    [ "$(drv_state '.hold.reason')" = "chain_unadopted:board" ]
    # no command for a hold stage 1 cannot apply
    [ "$(grep -c 'command=' "$SHIM_LOG")" -eq 0 ]
}

# ===========================================================================================
# blocks
# ===========================================================================================

@test "blocks: a candidate that contains an open block is not started (the hold blocked), and a plain resume is refused" {
    drv_seed
    cd_stub_set cd_gh_candidate 0 '{"verdict":"hold","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reason":"blocked","final":false}'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.hold.kind')" = blocked ]
    [ "$(drv_n '^stub cd_prepare_fetch')" -eq 0 ]
    [ "$(drv_state '.poll.verdict')" = pending ]
    cd_lib "cd_lock_take; cd_block_add ${SHA_C} build_failed x"
    run cd_prog resume
    [ "$status" -eq 2 ]
}

@test "blocks: resume --accept-descendants --reason closes the blocks and the next candidate starts" {
    cd_need_flock
    drv_seed '.hold = {"kind":"blocked","reason":"build_failed","sha12":"cccccccccccc","since":"2026-11-17T00:00:00Z"}'
    cd_lib "cd_lock_take; cd_block_add ${SHA_C} build_failed x"
    run cd_prog resume --accept-descendants --reason "the fix is in"
    [ "$status" -eq 0 ]
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(jq -r '[.[] | select(.cleared == null)] | length' "${GREMION_ROOT}/data/cd/blocked.json")" -eq 0 ]
    [ "$(drv_state '.hold')" = null ]
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
}

@test "blocks: release-now of a descendant, once committed, closes the blocks it contains as superseded and clears the hold" {
    cd_need_flock
    cd_git_fixture
    local c3_12="${C3:0:12}" green
    green="{\"verdict\":\"green\",\"sha\":\"${C3}\",\"reason\":\"\",\"final\":true,\"tip\":\"${C3}\"}"
    drv_seed '.hold = {"kind":"blocked","reason":"build_failed","sha12":"cccccccccccc","since":"2026-11-17T00:00:00Z"}'
    cd_lib "cd_lock_take; cd_block_add ${C2} build_failed x"
    cd_stub_set cd_gh_candidate 0 "$green"
    run cd_prog release-now "$c3_12"
    [ "$status" -eq 0 ]
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.live.sha12')" = "$c3_12" ]
    [ "$(drv_state '.hold')" = null ]
    [ "$(jq -r '.[0].cleared.reason' "${GREMION_ROOT}/data/cd/blocked.json")" = "superseded by ${c3_12}" ]
    # the candidate walk was told that the candidate may contain a block
    grep -q "^stub cd_gh_candidate --allow-blocked --allow-batch ${c3_12}\$" "$SHIM_LOG"
}

# ===========================================================================================
# the failure policy, one test per row
# ===========================================================================================

@test "policy: an infrastructure failure (fetch, disk, build infra, dump) retries with a backoff, mails stopped, writes no block and no hold, and tears the colour down" {
    drv_seed
    cd_stub_set cd_prepare_fetch 4
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.phase')" = idle ]
    [ "$(drv_state '.release')" = null ]
    [ "$(drv_state '.hold')" = null ]
    [ "$(drv_blocks)" -eq 0 ]
    [ "$(drv_mails stopped)" -eq 1 ]
    [ "$(drv_n '^stub cd_colour_down')" -eq 1 ]
    [ "$(drv_n '^stub cd_prepare_retag_restore')" -eq 1 ]
    # inside the backoff the candidate is not started again
    cd_stub_set cd_prepare_fetch 0
    run cd_prog tick
    [ "$(drv_n '^stub cd_prepare_fetch')" -eq 1 ]
    [[ "$output" == *backoff* ]]
    # after it, it is
    cd_advance 61
    run cd_prog tick
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
}

@test "policy: the third infrastructure failure of one commit holds failure" {
    drv_seed
    cd_stub_set cd_prepare_fetch 4
    run cd_prog tick
    cd_advance 61
    run cd_prog tick
    cd_advance 301
    run cd_prog tick
    [ "$(drv_n '^stub cd_prepare_fetch')" -eq 3 ]
    cd_advance 901
    run cd_prog tick
    [ "$(drv_state '.hold.kind')" = failure ]
    [ "$(drv_state '.hold.reason')" = infra_retries ]
    [ "$(drv_n '^stub cd_prepare_fetch')" -eq 3 ]
    [ "$(drv_blocks)" -eq 0 ]
}

@test "policy: a retag failure and a render failure hold failure, with no block" {
    drv_seed
    cd_stub_set cd_prepare_retag 2
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.hold.kind')" = failure ]
    [ "$(drv_state '.hold.reason')" = retag_failed ]
    [ "$(drv_blocks)" -eq 0 ]
    [ "$(drv_mails stopped)" -eq 1 ]
    [ "$(drv_n '^stub cd_prepare_retag_restore')" -eq 1 ]
    drv_seed
    cd_stub_set cd_prepare_retag 0
    cd_stub_set cd_prepare_render 1
    run cd_prog tick
    [ "$(drv_state '.hold.kind')" = failure ]
    [ "$(drv_state '.hold.reason')" = render_failed ]
    [ "$(drv_blocks)" -eq 0 ]
}

@test "policy: a build failure of the commit blocks, holds, mails rejected, tears down, restores the tag, and never calls the rollback" {
    drv_seed
    cd_stub_set cd_prepare_build 1
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(jq -r '.[0].rule' "${GREMION_ROOT}/data/cd/blocked.json")" = build_failed ]
    [ "$(jq -r '.[0].sha' "${GREMION_ROOT}/data/cd/blocked.json")" = "$SHA_B" ]
    [ "$(drv_state '.hold.kind')" = blocked ]
    [ "$(drv_state '.release')" = null ]
    [ "$(drv_mails rejected)" -eq 1 ]
    drv_order '^stub cd_colour_down' '^stub cd_prepare_retag_restore' '^stub cd_notify rejected'
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
    # the live colour's files did not move
    [ "$(readlink "${GREMION_ROOT}/current")" = releases/aaaaaaaaaaaa ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
}

@test "policy: the host lock is let go by a failed release" {
    cd_need_flock
    drv_seed
    cd_stub_set cd_data_migrate 1
    run cd_prog tick
    [ "$status" -eq 0 ]
    drv_hostlock_free
}

@test "policy: the module step maps as the plan says: exit 1 blocks migrate_failed (module_upgrade), 4 retries with no block, a timeout (2) holds failure with no block; none of them is a rollback" {
    drv_seed
    export CD_STUB_HOOK_cd_data_migrate='CD_MODULES_REASON=module_upgrade; return 1'
    run cd_prog tick
    [ "$(jq -r '.[0].rule' "${GREMION_ROOT}/data/cd/blocked.json")" = migrate_failed ]
    [ "$(jq -r '.[0].detail' "${GREMION_ROOT}/data/cd/blocked.json")" = module_upgrade ]
    [ "$(drv_state '.hold.kind')" = blocked ]
    # code 4: an infrastructure retry
    rm -f "${GREMION_ROOT}/data/cd/blocked.json"
    drv_seed
    export CD_STUB_HOOK_cd_data_migrate='CD_MODULES_REASON=module_infra; return 4'
    run cd_prog tick
    [ "$(drv_state '.hold')" = null ]
    [ "$(drv_blocks)" -eq 0 ]
    [ "$(drv_mails stopped)" -ge 1 ]
    # a timeout is code 2: a failure hold, no block
    rm -f "${GREMION_ROOT}/data/cd/retry"
    drv_seed
    export CD_STUB_HOOK_cd_data_migrate='CD_MODULES_REASON=module_timeout; return 2'
    run cd_prog tick
    [ "$(drv_state '.hold.kind')" = failure ]
    [ "$(drv_state '.hold.reason')" = module_timeout ]
    [ "$(drv_blocks)" -eq 0 ]
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
}

@test "policy: the leaf step maps the same way: exit 1 blocks migrate_failed (leaf_migrate), 4 retries, leaf_timeout and leaf_container_alive hold failure with no block; every one ends before the switch and never reaches the rollback" {
    drv_seed
    export CD_STUB_HOOK_cd_data_migrate='CD_LEAVES_REASON=leaf_run_failed; return 1'
    run cd_prog tick
    [ "$(jq -r '.[0].rule' "${GREMION_ROOT}/data/cd/blocked.json")" = migrate_failed ]
    [ "$(jq -r '.[0].detail' "${GREMION_ROOT}/data/cd/blocked.json")" = leaf_migrate ]
    rm -f "${GREMION_ROOT}/data/cd/blocked.json"
    drv_seed
    export CD_STUB_HOOK_cd_data_migrate='CD_LEAVES_REASON=leaf_infra; return 4'
    run cd_prog tick
    [ "$(drv_state '.hold')" = null ]
    [ "$(drv_blocks)" -eq 0 ]
    local why
    for why in leaf_timeout leaf_container_alive; do
        rm -f "${GREMION_ROOT}/data/cd/retry"
        drv_seed
        export CD_STUB_HOOK_cd_data_migrate="CD_LEAVES_REASON=${why}; return 2"
        run cd_prog tick
        [ "$(drv_state '.hold.kind')" = failure ]
        [ "$(drv_state '.hold.reason')" = "$why" ]
        [ "$(drv_blocks)" -eq 0 ]
    done
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
    [ "$(drv_n '^stub cd_traffic_switch')" -eq 0 ]
}

@test "policy: start, readiness and isolation failures of the commit block under their own rule" {
    drv_seed
    cd_stub_set cd_colour_start 1
    run cd_prog tick
    [ "$(jq -r '.[0].rule' "${GREMION_ROOT}/data/cd/blocked.json")" = start_failed ]
    rm -f "${GREMION_ROOT}/data/cd/blocked.json"
    drv_seed
    cd_stub_set cd_colour_start 0
    export CD_STUB_HOOK_cd_colour_gates='CD_COLOUR_REASON=public_ready; return 1'
    run cd_prog tick
    [ "$(jq -r '.[0].rule' "${GREMION_ROOT}/data/cd/blocked.json")" = readiness_failed ]
    rm -f "${GREMION_ROOT}/data/cd/blocked.json"
    drv_seed
    export CD_STUB_HOOK_cd_colour_gates='CD_COLOUR_REASON=isolation_run; return 1'
    run cd_prog tick
    [ "$(jq -r '.[0].rule' "${GREMION_ROOT}/data/cd/blocked.json")" = isolation_failed ]
    [ "$(drv_n '^stub cd_traffic_switch')" -eq 0 ]
}

@test "policy: a failure at or after switch_started (a failed switch call included) calls the rollback and never the teardown; the old colour's workers are not touched" {
    drv_seed
    export CD_STUB_HOOK_cd_traffic_switch='drv_switch_started; return 1'
    run cd_prog tick
    [ "$status" -eq 0 ]
    assert_recorded stub "cd_rollback_run post_switch_verify"
    [ "$(drv_n '^stub cd_colour_down')" -eq 0 ]
    [ "$(drv_n '^stub cd_prepare_retag_restore')" -eq 0 ]
    [ "$(drv_n '^stub cd_colour_workers')" -eq 0 ]
    [ "$(drv_state '.phase')" = idle ]
    [ "$(drv_state '.release')" = null ]
    # the confirm failing is the same
    drv_seed
    cd_stub_set cd_traffic_confirm 1
    export CD_STUB_HOOK_cd_traffic_switch='drv_switch_started'
    : > "$SHIM_LOG"
    run cd_prog tick
    assert_recorded stub "cd_rollback_run post_switch_verify"
    [ "$(drv_n '^stub cd_colour_down')" -eq 0 ]
}

# ===========================================================================================
# the switch composition: the workers
# ===========================================================================================

@test "switch: after a confirmed switch the old colour's worker file goes off and THEN the new colour's goes on" {
    drv_seed
    run cd_prog tick
    [ "$status" -eq 0 ]
    drv_order '^stub cd_traffic_confirm' '^stub cd_colour_workers blue off' '^stub cd_colour_workers green on' '^stub cd_commit_watch_loop'
    [ "$(drv_n '^stub cd_colour_workers')" -eq 2 ]
}

@test "switch: a kill between the two worker writes is resumed from the truth, and the new colour's file is turned on" {
    drv_seed
    export CD_STUB_HOOK_cd_colour_workers='[[ "$*" == "green on" ]] && drv_killme || true'
    run cd_prog tick
    [ "$status" -eq 137 ]
    [ "$(drv_state '.release.stage')" = switch ]
    unset CD_STUB_HOOK_cd_colour_workers
    # what serves, read from the file and the API: the new colour
    cd_stub_set cd_traffic_truth 0 "file=green traefik=green"
    : > "$SHIM_LOG"
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
    [ "$(drv_n '^stub cd_traffic_switch')" -eq 0 ]
    assert_recorded stub "cd_colour_workers green on"
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
}

@test "switch: a kill between the switch call and the state write, with the old colour still serving, runs the switch again; unreadable or split truth is the switch back" {
    drv_seed_sw switch started
    cd_stub_set cd_traffic_truth 0 "file=blue traefik=blue"
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_traffic_switch')" -eq 1 ]
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
    drv_seed_sw switch started
    : > "$SHIM_LOG"
    cd_stub_set cd_traffic_truth 1 "file=blue traefik=green"
    run cd_prog tick
    assert_recorded stub "cd_rollback_run commit_stuck"
    [ "$(drv_n '^stub cd_traffic_switch')" -eq 0 ]
}

# ===========================================================================================
# THE LINE, committed side. One test per path; each path has its own check in driver.sh
# ===========================================================================================

drv_assert_untouched() {
    # no rollback, no block, nothing of the live colour moved, the new colour not stopped
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
    [ "$(drv_blocks)" -eq 0 ]
    [ "$(drv_n '^stub cd_colour_down')" -eq 0 ]
    [ "$(readlink "${GREMION_ROOT}/current")" = releases/aaaaaaaaaaaa ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    [ "$(cat "${GREMION_ROOT}/etc/env/app-green.env")" = IMAGE_TAG=pilot-bbbbbbbbbbbb ]
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
}

@test "THE LINE (1): a crash after commit step 5, then tick: the release is finished forward, never rolled back" {
    drv_seed_commit commit started
    run cd_prog tick
    [ "$status" -eq 0 ]
    drv_assert_untouched
    drv_order '^stub cd_commit_promote' '^stub cd_commit_prune' '^stub cd_reconcile_run'
    [ "$(drv_state '.phase')" = idle ]
    [ "$(drv_state '.hold')" = null ]
}

@test "THE LINE (2): a kill -9 after commit step 5, then tick --resume-only: finished forward, ended as interrupted, never rolled back" {
    cd_need_flock
    drv_seed_sw commit started
    export CD_STUB_HOOK_cd_commit_promote='drv_step5; drv_killme'
    run cd_prog tick --resume-only
    [ "$status" -eq 137 ]
    [ "$(drv_state '.release.committed_at | type')" = string ]
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
    unset CD_STUB_HOOK_cd_commit_promote
    : > "$SHIM_LOG"
    run cd_prog tick --resume-only
    [ "$status" -eq 0 ]
    drv_assert_untouched
    [ "$(drv_state '.hold.reason')" = interrupted ]
}

@test "THE LINE (3): the third attempt of a stage of a committed release holds stuck_stage, and never rolls back" {
    drv_seed_commit commit started '.release.attempt = 2'
    run cd_prog tick
    [ "$status" -eq 0 ]
    drv_assert_untouched
    [ "$(drv_state '.hold.kind')" = stuck_stage ]
    [ "$(drv_n '^stub cd_commit_promote')" -eq 0 ]
    [ "$(drv_state '.release')" = null ]
}

@test "THE LINE (4): a failing retry of commit step 6 or 7 holds failure (post_commit_commit), and a failing reconcile stage holds reconcile_failed; neither rolls back or blocks" {
    drv_seed_commit commit started
    cd_stub_set cd_commit_promote 1
    run cd_prog tick
    [ "$status" -eq 0 ]
    drv_assert_untouched
    [ "$(drv_state '.hold.kind')" = failure ]
    [ "$(drv_state '.hold.reason')" = post_commit_commit ]
    [ "$(drv_n '^stub cd_reconcile_run')" -eq 0 ]
    drv_seed_commit commit ok
    cd_stub_set cd_commit_promote 0
    cd_stub_set cd_reconcile_run 1
    : > "$SHIM_LOG"
    run cd_prog tick
    drv_assert_untouched
    [ "$(drv_state '.hold.kind')" = reconcile_failed ]
}

@test "THE LINE (5): a cd_failure_policy call for every stage and kind of a committed release rolls nothing back, blocks nothing and moves nothing" {
    local stage kind
    for stage in $DRV_STAGES; do
        for kind in commit infra host; do
            drv_seed_commit "$stage" failed
            : > "$SHIM_LOG"
            rm -f "${GREMION_ROOT}/data/cd/blocked.json"
            run cd_lib ". \"\${HOST_SRC}/lib/cd/driver.sh\"; cd_cfg_load; cd_lock_take; cd_failure_policy ${stage} ${kind} some_code"
            [ "$status" -eq 0 ] || { echo "${stage} ${kind}: ${output}" >&2; return 1; }
            drv_assert_untouched || { echo "${stage} ${kind}" >&2; return 1; }
            case "$stage" in
                reconcile) [ "$(drv_state '.hold.kind')" = reconcile_failed ] ;;
                *) [ "$(drv_state '.hold.kind')" = failure ] ;;
            esac
        done
    done
}

@test "THE LINE (backstop): the one door to cd_rollback_run refuses a committed release and touches nothing" {
    drv_seed_commit watch failed
    run cd_lib ". \"\${HOST_SRC}/lib/cd/driver.sh\"; cd_cfg_load; cd_lock_take; _cd_drv_rollback_auto watch_5xx watch"
    [ "$status" -eq 0 ]
    drv_assert_untouched
    [ "$(drv_state '.hold.kind')" = failure ]
}

@test "THE LINE, before committed_at: the same crashes and failures still roll back (a kill between commit steps 4 and 5, a failing promote, a third attempt after the switch)" {
    drv_seed_sw commit started
    run cd_prog tick
    [ "$status" -eq 0 ]
    assert_recorded stub "cd_rollback_run commit_stuck"
    [ "$(drv_n '^stub cd_commit_promote')" -eq 0 ]
    drv_seed_sw watch ok
    cd_stub_set cd_commit_promote 1
    : > "$SHIM_LOG"
    run cd_prog tick
    assert_recorded stub "cd_rollback_run commit_stuck"
    [ "$(drv_blocks)" -eq 0 ]
    drv_seed_sw watch started '.release.attempt = 2'
    : > "$SHIM_LOG"
    run cd_prog tick
    assert_recorded stub "cd_rollback_run commit_stuck"
    [ "$(drv_n '^stub cd_commit_watch_loop')" -eq 0 ]
}

# ===========================================================================================
# resume
# ===========================================================================================

drv_final() { jq -S '{phase, hold, live: (.live | {sha12, tag, colour}), previous: (.previous | {sha12, colour}), release}' "${GREMION_ROOT}/data/cd/state.json"; }

@test "resume: a kill in each stage (and at the boundary after it) resumes to the end state of the uninterrupted run" {
    local stage fn want got hook
    drv_seed
    run cd_prog tick
    [ "$status" -eq 0 ]
    want="$(drv_final)"
    for stage in fetch classify retag render build snapshot migrate start gates watch; do
        case "$stage" in
            fetch) fn=cd_prepare_fetch ;;
            classify) fn=cd_classify ;;
            retag) fn=cd_prepare_retag ;;
            render) fn=cd_prepare_render ;;
            build) fn=cd_prepare_build ;;
            snapshot) fn=cd_data_dumpset_take ;;
            migrate) fn=cd_data_migrate ;;
            start) fn=cd_colour_start ;;
            gates) fn=cd_colour_gates ;;
            watch) fn=cd_commit_watch_loop ;;
        esac
        drv_seed
        hook="CD_STUB_HOOK_${fn}"
        export "${hook}=drv_killme"
        run cd_prog tick
        [ "$status" -eq 137 ] || { echo "${stage}: ${status}" >&2; return 1; }
        [ "$(drv_state '.phase')" != idle ]
        unset "${hook}"
        run cd_prog tick
        [ "$status" -eq 0 ] || { echo "${stage}: resume ${status} ${output}" >&2; return 1; }
        got="$(drv_final)"
        [ "$got" = "$want" ] || { echo "${stage}: end state differs" >&2; diff <(echo "$want") <(echo "$got") >&2; return 1; }
    done
}

@test "resume: a stage that is started with no process is run again, and its third attempt holds stuck_stage (a teardown, no block)" {
    drv_seed_rel build started '.release.attempt = 1'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_prepare_build')" -eq 1 ]
    drv_seed_rel build started '.release.attempt = 2'
    : > "$SHIM_LOG"
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_prepare_build')" -eq 0 ]
    [ "$(drv_state '.hold.kind')" = stuck_stage ]
    [ "$(drv_state '.release')" = null ]
    [ "$(drv_blocks)" -eq 0 ]
    [ "$(drv_n '^stub cd_colour_down')" -eq 1 ]
}

@test "resume: a waiting stage (the timer guard says 3) does not fail, hold or mail; the release goes on at a later tick" {
    cd_need_flock
    drv_seed_rel build ok
    cd_stub_set cd_data_timer_guard 3
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.release.stage')" = build ]
    [ "$(drv_state '.hold')" = null ]
    [ "$(drv_n '^stub cd_notify ')" -eq 0 ]
    [ "$(drv_n '^stub cd_data_dumpset_take')" -eq 0 ]
    drv_hostlock_free
    cd_stub_set cd_data_timer_guard 0
    run cd_prog tick
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
}

@test "resume: a failed stage recorded before a crash goes through the policy at the next tick" {
    drv_seed_rel build failed '.release.failure = {"kind":"commit","stage":"build","code":"build_failed","at":"2026-11-17T00:00:00Z"}'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(jq -r '.[0].rule' "${GREMION_ROOT}/data/cd/blocked.json")" = build_failed ]
    [ "$(drv_state '.release')" = null ]
}

@test "resume: phase rolling_back resumes the sequence with the rule it recorded, and a committed release only with manual_rollback" {
    drv_seed_sw watch failed '.phase = "rolling_back" | .release.failure = {"kind":"commit","stage":"watch","code":"watch_5xx","at":"2026-11-17T00:00:00Z"}'
    run cd_prog tick
    [ "$status" -eq 0 ]
    assert_recorded stub "cd_rollback_run watch_5xx"
    [ "$(drv_state '.phase')" = idle ]
    drv_seed_commit commit failed '.phase = "rolling_back" | .release.failure = {"kind":"commit","stage":"watch","code":"watch_5xx","at":"2026-11-17T00:00:00Z"}'
    : > "$SHIM_LOG"
    run cd_prog tick
    assert_recorded stub "cd_rollback_run manual_rollback"
}

# ===========================================================================================
# the watch
# ===========================================================================================

@test "watch: a loop that ran a rollback ended the release (the commit is not run); a parked release ends the process quietly" {
    drv_seed_sw watch started
    export CD_STUB_HOOK_cd_commit_watch_loop='cd_hold_set blocked watch_5xx bbbbbbbbbbbb; cd_state_set ".phase = \"idle\" | .release = null"; return 0'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_commit_promote')" -eq 0 ]
    [ "$(drv_state '.live.sha12')" = aaaaaaaaaaaa ]
    drv_seed_sw watch started
    export CD_STUB_HOOK_cd_commit_watch_loop='cd_state_set ".phase = \"parked\""; return 0'
    : > "$SHIM_LOG"
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_commit_promote')" -eq 0 ]
    [ "$(drv_state '.phase')" = parked ]
    [ "$(drv_state '.release.stage')" = watch ]
}

@test "watch: a parked release is resumed by resume, which takes the host lock and re-enters the watch with a fresh pause budget" {
    cd_need_flock
    drv_seed_sw watch started '.phase = "parked" | .release.watch.paused_s = 900 | .hold = {"kind":"failure","reason":"watch_pause_cap","sha12":"bbbbbbbbbbbb","since":"2026-11-17T00:00:00Z"}'
    cd_lib 'cd_request_put resume "{\"reason\":\"\"}"'
    export CD_STUB_HOOK_cd_commit_watch_loop='drv_probe in_loop; printf "paused=%s\n" "$(cd_state_get ".release.watch.paused_s")" >> "$SHIM_LOG"'
    run cd_prog tick
    [ "$status" -eq 0 ]
    grep -q '^probe in_loop host=HELD cd=HELD$' "$SHIM_LOG"
    grep -q '^paused=0$' "$SHIM_LOG"
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
    [ "$(drv_state '.hold')" = null ]
}

# ===========================================================================================
# the rollback verb
# ===========================================================================================

@test "rollback: before the switch it aborts the release, tears down, holds operator, and writes no block" {
    drv_seed_rel build ok
    run cd_prog rollback --reason "stop it"
    [ "$status" -eq 0 ]
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.hold.kind')" = operator ]
    [ "$(drv_state '.release')" = null ]
    [ "$(drv_blocks)" -eq 0 ]
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
    [ "$(drv_n '^stub cd_prepare_build')" -eq 0 ]
    [ "$(drv_n '^stub cd_colour_down')" -eq 1 ]
}

@test "rollback: during the watch it runs the sequence" {
    drv_seed_sw watch ok
    run cd_prog rollback
    [ "$status" -eq 0 ]
    run cd_prog tick
    [ "$status" -eq 0 ]
    assert_recorded stub "cd_rollback_run manual_rollback"
    [ "$(drv_state '.phase')" = idle ]
    [ "$(drv_n '^stub cd_commit_promote')" -eq 0 ]
}

@test "rollback: after the commit point it goes back one release when previous is startable, and refuses with the message when it is not" {
    cd_need_flock
    drv_seed
    run cd_prog rollback
    [ "$status" -eq 0 ]
    run cd_prog tick
    [ "$status" -eq 0 ]
    assert_recorded stub "cd_rollback_run manual_rollback"
    drv_hostlock_free
    drv_seed '.previous.startable = false'
    : > "$SHIM_LOG"
    run cd_prog rollback
    [ "$status" -eq 2 ]
    [[ "$output" == *"cannot start"* ]]
    [[ "$output" == *"gremion-rollback"* ]]
    [ "$(drv_n '^stub cd_rollback_run')" -eq 0 ]
}

@test "rollback: with the kill switch present it still works" {
    cd_need_flock
    drv_seed
    : > "${GREMION_ROOT}/etc/cd.disabled"
    run cd_prog rollback
    [ "$status" -eq 0 ]
    run cd_prog tick
    [ "$status" -eq 0 ]
    assert_recorded stub "cd_rollback_run manual_rollback"
}

@test "rollback: a manual rollback of a committed release in flight goes through manual_rollback only" {
    drv_seed_commit commit ok
    cd_lib 'cd_request_put rollback "{\"reason\":\"\"}"'
    run cd_prog tick
    [ "$status" -eq 0 ]
    assert_recorded stub "cd_rollback_run manual_rollback"
    [ "$(drv_n '^stub cd_reconcile_run')" -eq 0 ]
}

# ===========================================================================================
# release-now: one test per row of the section 8 table
# ===========================================================================================

drv_rn() { # drv_rn ARGS... -- the verb, then a tick
    run cd_prog release-now "$@"
    [ "$status" -eq 0 ] || return 1
    run cd_prog tick
}

@test "release-now: ci_changed, chain_class_changed and batch_too_large are taken bare" {
    local k
    for k in ci_changed chain_class_changed; do
        drv_seed
        cd_stub_set cd_classify 0 "{\"v\":1,\"holds\":[{\"kind\":\"${k}\",\"reason\":\"x\"}],\"hold\":{\"kind\":\"${k}\",\"reason\":\"x\"},\"migrations\":{\"total\":0}}"
        : > "$SHIM_LOG"
        drv_rn bbbbbbbbbbbb
        [ "$status" -eq 0 ]
        [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ] || { echo "${k}" >&2; return 1; }
    done
    drv_seed
    cd_stub_set cd_classify 0 "$CLEAN"
    : > "$SHIM_LOG"
    drv_rn bbbbbbbbbbbb
    grep -q '^stub cd_gh_candidate --allow-blocked --allow-batch bbbbbbbbbbbb$' "$SHIM_LOG"
}

@test "release-now: the blocked sha itself is refused unless --force-blocked is given" {
    drv_seed
    cd_stub_set cd_gh_candidate 0 '{"verdict":"hold","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reason":"blocked","final":false}'
    drv_rn bbbbbbbbbbbb
    [ "$(drv_state '.live.sha12')" = aaaaaaaaaaaa ]
    [ "$(drv_n '^stub cd_prepare_fetch')" -eq 0 ]
    grep -q '^stub cd_gh_candidate --allow-blocked --allow-batch bbbbbbbbbbbb$' "$SHIM_LOG"
    : > "$SHIM_LOG"
    cd_stub_set cd_gh_candidate 0 "$GREEN"
    drv_rn bbbbbbbbbbbb --force-blocked
    grep -q '^stub cd_gh_candidate --force-blocked --allow-batch bbbbbbbbbbbb$' "$SHIM_LOG"
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
}

@test "release-now: range_unverified is refused bare, taken with --accept-range --reason, and a missing reason is refused" {
    drv_seed
    cd_stub_set cd_gh_candidate 0 '{"verdict":"hold","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reason":"range_unverified","final":true}'
    drv_rn bbbbbbbbbbbb
    [ "$(drv_state '.live.sha12')" = aaaaaaaaaaaa ]
    run cd_prog release-now bbbbbbbbbbbb --accept-range
    [ "$status" -eq 2 ]
    run cd_prog release-now bbbbbbbbbbbb --reason "x"
    [ "$status" -eq 2 ]
    cd_stub_set cd_gh_candidate 0 "$GREEN"
    : > "$SHIM_LOG"
    drv_rn bbbbbbbbbbbb --accept-range --reason "reviewed by hand"
    grep -q '^stub cd_gh_candidate --allow-blocked --allow-batch --accept-range reviewed by hand bbbbbbbbbbbb$' "$SHIM_LOG"
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
}

@test "release-now: state_tier is refused bare and taken with --with-state (the host and state stages then run)" {
    cd_stub_set cd_classify 0 '{"v":1,"holds":[{"kind":"state_tier","reason":"edge"}],"hold":{"kind":"state_tier","reason":"edge"},"migrations":{"total":0}}'
    drv_seed
    drv_rn bbbbbbbbbbbb
    [ "$(drv_state '.live.sha12')" = aaaaaaaaaaaa ]
    [ "$(drv_n '^stub cd_prepare_build')" -eq 0 ]
    [ "$(drv_state '.release')" = null ]
    : > "$SHIM_LOG"
    drv_seed
    drv_rn bbbbbbbbbbbb --with-state
    [ "$(drv_state '.live.sha12')" = bbbbbbbbbbbb ]
    drv_order '^stub cd_classify' '^stub cd_adopt_apply_host' '^stub cd_adopt_apply_state' '^stub cd_prepare_retag '
}

@test "release-now: unsupported_chain, contract_migration, waived_migration and classify_failed are refused even with every flag, --with-state on an unsupported_chain included" {
    local k
    for k in unsupported_chain contract_migration waived_migration classify_failed; do
        drv_seed
        cd_stub_set cd_classify 0 "{\"v\":1,\"holds\":[{\"kind\":\"${k}\",\"reason\":\"x\"},{\"kind\":\"state_tier\",\"reason\":\"edge\"}],\"hold\":{\"kind\":\"${k}\",\"reason\":\"x\"},\"migrations\":{\"total\":0}}"
        : > "$SHIM_LOG"
        drv_rn bbbbbbbbbbbb --with-state --force-blocked --accept-range --reason "why"
        [ "$(drv_state '.live.sha12')" = aaaaaaaaaaaa ] || { echo "$k was taken" >&2; return 1; }
        [ "$(drv_n '^stub cd_prepare_build')" -eq 0 ]
    done
}

@test "release-now: not_ancestor and ruleset_missing (the candidate walk's holds) are refused with every flag" {
    local k
    for k in not_ancestor ruleset_missing; do
        drv_seed
        cd_stub_set cd_gh_candidate 0 "{\"verdict\":\"hold\",\"sha\":\"${SHA_B}\",\"reason\":\"${k}\",\"final\":false}"
        drv_rn bbbbbbbbbbbb --with-state --force-blocked
        [ "$(drv_state '.live.sha12')" = aaaaaaaaaaaa ]
        [ "$(drv_n '^stub cd_prepare_fetch')" -eq 0 ]
    done
}

@test "release-now: a hold that only resume ends refuses the verb (reconcile_failed names gremion-cd reconcile too)" {
    local k
    for k in operator failure proof rollback_failed killswitch stuck_stage reconcile_failed; do
        drv_seed ".hold = {\"kind\":\"${k}\",\"reason\":\"x\",\"sha12\":\"\",\"since\":\"2026-11-17T00:00:00Z\"}"
        run cd_prog release-now bbbbbbbbbbbb
        [ "$status" -eq 2 ] || { echo "$k" >&2; return 1; }
        [[ "$output" == *resume* ]]
    done
    [[ "$output" == *"gremion-cd reconcile"* ]]
}

@test "release-now: --unverified is refused with CD_PROOF_MODE=0, and a proof release whose class shows a migration file is refused" {
    drv_seed
    run cd_prog release-now "$SHA_B" --ref proof/x --unverified
    [ "$status" -eq 2 ]
    cd_write_cfg CD_PROOF_MODE=1 CD_PROOF_REPO=https://example.org/org/proof
    cd_stub_set cd_classify 0 '{"v":1,"holds":[],"hold":null,"migrations":{"total":1,"chains":{}}}'
    : > "$SHIM_LOG"
    run cd_prog release-now "$SHA_B" --ref proof/x --unverified
    [ "$status" -eq 0 ]
    run cd_prog tick
    [ "$status" -eq 0 ]
    assert_recorded stub "cd_gh_proof_source ${SHA_B} proof/x"
    [ "$(drv_n '^stub cd_prepare_build')" -eq 0 ]
    [ "$(drv_state '.release')" = null ]
    # a clean one runs as a proof release (mode proof, fetched from the proof ref)
    cd_stub_set cd_classify 0 "$CLEAN"
    : > "$SHIM_LOG"
    cd_prog release-now "$SHA_B" --ref proof/x --unverified
    run cd_prog tick
    assert_recorded stub "cd_prepare_fetch ${SHA_B} proof/x"
}

@test "release-now: the normal checks still run: a candidate with no verdict (unknown) does not start" {
    drv_seed
    cd_stub_set cd_gh_candidate 0 '{"verdict":"unknown","sha":"","reason":"runs_unavailable","final":false}'
    drv_rn bbbbbbbbbbbb
    [ "$(drv_n '^stub cd_prepare_fetch')" -eq 0 ]
    [ "$(drv_state '.live.sha12')" = aaaaaaaaaaaa ]
    # and the start gates still apply (a refusal of the precheck)
    cd_stub_set cd_gh_candidate 0 "$GREEN"
    export CD_STUB_HOOK_cd_prepare_precheck='CD_PREPARE_WHY=quiet_window; return 3'
    drv_rn bbbbbbbbbbbb
    [ "$(drv_n '^stub cd_prepare_fetch')" -eq 0 ]
}

@test "release-now: refused while a release is in flight; the verb validates its arguments" {
    drv_seed_rel build ok
    run cd_prog release-now bbbbbbbbbbbb
    [ "$status" -eq 3 ]
    drv_seed
    run cd_prog release-now
    [ "$status" -eq 2 ]
    run cd_prog release-now notasha
    [ "$status" -eq 2 ]
    run cd_prog release-now bbbbbbbbbbbb --nope
    [ "$status" -eq 2 ]
    run cd_prog release-now bbbbbbbbbbbb --ref x
    [ "$status" -eq 2 ]
}

# ===========================================================================================
# the reconcile verb
# ===========================================================================================

@test "reconcile verb: refused while a release is in flight (3) and in parked (2); the stage is not run" {
    drv_seed_rel build ok
    run cd_prog reconcile
    [ "$status" -eq 3 ]
    drv_seed_sw watch started '.phase = "parked"'
    run cd_prog reconcile
    [ "$status" -eq 2 ]
    [ "$(drv_n '^stub cd_reconcile_run')" -eq 0 ]
}

@test "reconcile verb: in idle it takes the cd lock, re-runs the stage for the live release and clears reconcile_failed only when every customer is ok" {
    cd_need_flock
    drv_seed '.hold = {"kind":"reconcile_failed","reason":"canary","sha12":"aaaaaaaaaaaa","since":"2026-11-17T00:00:00Z"}'
    export CD_STUB_HOOK_cd_reconcile_run='drv_probe in_stage'
    cd_stub_set cd_reconcile_run 1
    run cd_prog reconcile
    [ "$status" -eq 1 ]
    grep -q '^probe in_stage host=FREE cd=HELD$' "$SHIM_LOG"
    [ "$(drv_state '.hold.kind')" = reconcile_failed ]
    cd_stub_set cd_reconcile_run 0
    run cd_prog reconcile
    [ "$status" -eq 0 ]
    [ "$(drv_state '.hold')" = null ]
    # whatever CD_RECONCILE says
    cd_write_cfg CD_RECONCILE=0
    drv_seed
    : > "$SHIM_LOG"
    run cd_prog reconcile
    [ "$status" -eq 0 ]
    [ "$(drv_n '^stub cd_reconcile_run')" -eq 1 ]
}

@test "reconcile verb: tick and release-now refuse while the hold stands, and resume clears it" {
    drv_seed '.hold = {"kind":"reconcile_failed","reason":"probe","sha12":"aaaaaaaaaaaa","since":"2026-11-17T00:00:00Z"}'
    run cd_prog tick
    [ "$(drv_n '^stub cd_gh_candidate')" -eq 0 ]
    run cd_prog release-now bbbbbbbbbbbb
    [ "$status" -eq 2 ]
    cd_stub_set cd_data_dumpset_live 0
    run cd_prog resume
    [ "$status" -eq 0 ]
    run cd_prog tick
    [ "$(drv_state '.hold')" = null ]
}

@test "reconcile verb: a busy cd lock is 3" {
    cd_need_flock
    drv_seed
    cd_bg 'cd_lock_take; echo ready; exec sleep 300'
    run cd_prog reconcile
    [ "$status" -eq 3 ]
    [ "$(drv_n '^stub cd_reconcile_run')" -eq 0 ]
}

# ===========================================================================================
# the real-data boundary
# ===========================================================================================

@test "boundary: nothing the driver records or mails names a host, an address or a slug-shaped free text; an operator reason stays in the scrubbed history" {
    drv_seed
    cd_lib 'cd_request_put hold "{\"reason\":\"ops@example.org said so\"}"'
    cd_stub_set cd_gh_candidate 0 '{"verdict":"none","sha":"","reason":"up_to_date","final":true}'
    run cd_prog tick
    [ "$status" -eq 0 ]
    [ "$(drv_state '.hold.reason')" = requested ]
    run grep -c 'ops@example.org' "${GREMION_ROOT}/data/cd/history.jsonl" "${GREMION_ROOT}/data/cd/state.json"
    [[ "$output" != *":1"* ]]
}
