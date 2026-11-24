#!/usr/bin/env bats
# test/host/cd-pipeline.bats -- every real library of gremion-cd together.
#
# Run: MSYS_NO_PATHCONV=1 docker run --rm --init --user 1001 -v "$(pwd -W):/repo:ro" -w /repo gremion-bats:local test/host/cd-pipeline.bats
#
# The program runs from the whole infra/host tree. Nothing of lib/cd is replaced: the helper's stub
# file only names functions, and it defines a stub where no real function exists, so a library that
# is missing or renamed shows up as a `stub ...` line in the call log. Every test ends with
# pl_no_stubs. What is shimmed is outside the family: docker and curl (one world each, files under
# $DK), git (the real one, recorded), logger, systemctl, and the programs the libraries look up by
# path (gremion-switch, gremion-render and gremion-tenant inside the release trees, gremion-
# migration-dump, gremion-isolation, gremion-verify and gremion-mail in the bin directory).
#
# What a kill -9 means here: the program is killed from outside the libraries, by a hook file that
# the docker shim evaluates at a named call (the program dies in the middle of that call), or by
# a second process. The history writer is NOT wrapped. Failures are injected by files of the world
# (a build that fails, a switch that writes and exits 1, a readyz that says no), never by chmod, so
# a run as root and a run as an unprivileged user do the same.
#
# Every address is a reserved example name; no secret-looking value is committed.

bats_require_minimum_version 1.5.0
load 'test_helper/host'
load 'test_helper/cd'
load 'test_helper/cd-github'
load 'test_helper/cd-pipeline'

setup() {
    pl_setup
}
teardown() {
    if [ -z "${BATS_TEST_COMPLETED:-}" ] || [ -n "${PL_DIAG:-}" ]; then pl_diag >&3; fi
    cd_teardown
}

# ===========================================================================================
# the harness itself
# ===========================================================================================

@test "harness: every cross-library function the helper can stub is defined by a real library" {
    run bash -c '
        . "${HOST_SRC}/lib/common.sh"
        . "${HOST_SRC}/lib/cd/core.sh"
        for f in "${HOST_SRC}"/lib/cd/*.sh; do
            n="${f##*/}"; n="${n%.sh}"
            case "$n" in core|apply-root) continue ;; esac
            . "$f"
        done
        for fn in "$@"; do declare -F "$fn" >/dev/null || echo "missing: $fn"; done' bash "${CD_STUB_FUNCS[@]}"
    echo "$output"
    [ -z "$output" ]
}

# ===========================================================================================
# a whole good release
# ===========================================================================================

@test "a good release: one tick takes the release through every real library to the commit point" {
    pl_scn_green
    run pl_tick
    echo "$output"
    [ "$status" -eq 0 ]
    pl_no_stubs
    local b12="${C_B:0:12}" l12="${C_L0:0:12}"
    # the commit point: live and previous, current, the tag files, the colour that serves
    [ "$(pl_state .live.sha)" = "$C_B" ]
    [ "$(pl_state .live.colour)" = green ]
    [ "$(pl_state .previous.sha)" = "$C_L0" ]
    [ "$(pl_state .previous.colour)" = blue ]
    [ "$(pl_state .previous.startable)" = true ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${b12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "pilot-${b12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/previous-tag")" = "pilot-${l12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = green ]
    [ "$(jq -r '.loadBalancer.servers[0].url' "$DK/traefik.app@file")" = "http://gremion-ui-green:3000" ]
    # the env files: the target carries the new tag, the old colour is untouched
    assert_present "^IMAGE_TAG=pilot-${b12}\$" "${GREMION_ROOT}/etc/env/app-green.env"
    assert_present "^IMAGE_TAG=pilot-${l12}\$" "${GREMION_ROOT}/etc/env/app-blue.env"
    # the isolation record names the new tip
    [ "$(cat "${GREMION_ROOT}/data/isolation-recorded")" = "$C_B" ]
    # nothing in flight, no hold, no block, both locks free after the program
    [ "$(pl_state .phase)" = idle ]
    [ "$(pl_state .release)" = null ]
    [ "$(pl_state .hold)" = null ]
    [ "$(pl_blocks)" = 0 ]
    pl_hostlock_free
    pl_cdlock_free
    # the dump set of the release was retired at the commit
    [ ! -s "$DK/live.tsv" ]
    # the order of the whole release, read from the world's own log
    pl_before '^build green' '^run green migrate'
    pl_before '^run green kernel-api-migrate' '^run green tenant-create'
    pl_before '^run green tenant-create' '^up green'
    pl_before '^up green' '^isolation run'
    pl_before '^verify' '^switch green'
    pl_before '^switch green' '^isolation record'
    pl_before '^isolation record' '^down blue'
    # one released mail and one reconciled mail
    [ "$(pl_mails released)" -eq 1 ]
    [ "$(pl_mails reconciled)" -eq 1 ]
    [ "$(pl_hist reconciled)" -eq 1 ]
}

@test "a release whose readiness fails never writes the switch file" {
    pl_scn_green
    printf 'notready\n' >"$DK/readyz.green"
    run pl_tick
    echo "$output"
    pl_no_stubs
    [ "$(pl_count '^switch ')" -eq 0 ]
    [ "$(pl_hist switch_started)" -eq 0 ]
    [ ! -e "${GREMION_ROOT}/etc/edge/active.yml" ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    [ "$(pl_state .live.sha)" = "$C_L0" ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${C_L0:0:12}" ]
    # the new colour is torn down, the old one still runs, the tag of the target env file is back
    pl_after '^up green' '^down green'
    [ "$(pl_count '^down blue')" -eq 0 ]
    assert_present '^IMAGE_TAG=pilot-eeeeeeeeeeee$' "${GREMION_ROOT}/etc/env/app-green.env"
    [ "$(pl_state .phase)" = idle ]
    [ "$(pl_state .release)" = null ]
    [ "$(pl_blocks)" = 1 ]
    [ "$(pl_state .hold.kind)" = blocked ]
    pl_hostlock_free
    pl_cdlock_free
    # the dump set of the failed release stays live: the next release must not delete it
    [ -s "$DK/live.tsv" ]
}

@test "a release that fails in the window rolls back, blocks and holds" {
    pl_scn_green
    # the new colour answers 503 on the public route once it serves
    : >"$DK/public.fail.green"
    run pl_tick
    echo "$output"
    pl_no_stubs
    local b12="${C_B:0:12}" l12="${C_L0:0:12}"
    [ "$(pl_state .live.sha)" = "$C_L0" ]
    [ "$(pl_state .live.colour)" = blue ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    [ "$(jq -r '.loadBalancer.servers[0].url' "$DK/traefik.app@file")" = "http://gremion-ui-blue:3000" ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${l12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "pilot-${l12}" ]
    # the order: the switch to green, the switch back to blue, THEN the new colour goes down
    pl_before '^switch green' '^switch blue'
    pl_after '^switch blue' '^down green'
    [ "$(pl_count '^isolation record')" -eq 0 ] || [ "$(cat "${GREMION_ROOT}/data/isolation-recorded")" = "$C_L0" ]
    [ "$(pl_state .phase)" = idle ]
    [ "$(pl_state .release)" = null ]
    [ "$(pl_state .hold.kind)" = blocked ]
    [ "$(pl_blocks)" = 1 ]
    [ "$(jq -r '.[0].sha' "${GREMION_ROOT}/data/cd/blocked.json")" = "$C_B" ]
    [ "$(pl_mails rolled_back)" -eq 1 ]
    # the workers: new off, old on
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = off ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/blue")" = on ]
    pl_hostlock_free
    pl_cdlock_free
}

@test "the switch call writes the edge file for the new colour and exits 1: the old colour serves, the new one stops only after the confirm" {
    pl_scn_green
    printf 'write_then_fail\n' >"$DK/switch.mode.green"
    run pl_tick
    echo "$output"
    pl_no_stubs
    local l12="${C_L0:0:12}"
    # the end state: the file, active-colour and Traefik agree on the old colour
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    assert_present '^active=blue$' "${GREMION_ROOT}/etc/edge/active.yml"
    [ "$(jq -r '.loadBalancer.servers[0].url' "$DK/traefik.app@file")" = "http://gremion-ui-blue:3000" ]
    [ "$(jq -r '.loadBalancer.servers[0].url' "$DK/traefik.public@file")" = "http://gremion-public-blue:3000" ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${l12}" ]
    [ "$(pl_state .live.sha)" = "$C_L0" ]
    # the order of the calls: the new colour goes down only after the switch back, and the old colour never
    pl_before '^switch green mode=write_then_fail' '^switch blue mode=ok'
    pl_after '^switch blue mode=ok' '^down green'
    [ "$(pl_count '^down blue')" -eq 0 ]
    # nothing before the switch tore anything down: the only `down green` before it is the start's own
    # leftover clean-up, which comes before `up green`
    [ "$(awk '/^up green/ { u = NR } /^switch green/ { s = NR } /^down green/ { if (NR > u && u > 0 && (s == 0 || NR < s)) bad++ } END { print bad + 0 }' "$DK/order.log")" -eq 0 ]
    # the block names the failed switch, the hold stands, the release is over
    [ "$(pl_blocks)" -eq 1 ]
    [ "$(jq -r '.[0].rule' "${GREMION_ROOT}/data/cd/blocked.json")" = post_switch_verify ]
    [ "$(pl_state .hold.kind)" = blocked ]
    [ "$(pl_state .phase)" = idle ]
    [ "$(pl_mails rolled_back)" -eq 1 ]
    pl_hostlock_free
    pl_cdlock_free
}

# ===========================================================================================
# the dump set of a whole release
# ===========================================================================================

@test "the dump set: a main-server part and a module part, each module take with its own server and role, no other server entered, a blocked database skipped" {
    export PL_BOARD=1
    pl_scn_green
    pl_board_world
    # a blocked gate database on the calendar server: in the registry, on the server, never dumped
    printf 't_%s__calendar|1100\n' "$PL_H3" >>"$DK/srv.calendar-postgres.dbs"
    printf 't_%s__calendar|blocked\n' "$PL_H3" >>"$DK/rows.module_database"
    run pl_tick
    echo "$output"
    [ "$status" -eq 0 ]
    pl_no_stubs
    [ "$(pl_state .live.sha)" = "$C_B" ]
    local label="pilot-${C_B:0:12}" line svc usr n
    # every take is for this release's label; the main-server takes carry no service, the module takes
    # carry both the service and the role of THEIR server
    n=0
    while read -r cmd rel db sv us; do
        [ "$cmd" = take ] || continue
        n=$((n + 1))
        [ "$rel" = "rel=${label}" ]
        svc="${sv#svc=}"
        usr="${us#usr=}"
        case "$svc" in
            '') [ -z "$usr" ] ;;
            calendar-postgres) [ "$usr" = cal_admin ] ;;
            content-postgres) [ "$usr" = con_admin ] ;;
            newsletter-postgres) [ "$usr" = nl_admin ] ;;
            board-postgres) [ "$usr" = brd_admin ] ;;
            *) echo "a take on an unexpected server: $svc"; return 1 ;;
        esac
    done <"$DK/dump.log"
    [ "$n" -ge 10 ]
    # board is entered once its declaration is in the tree
    [ "$(grep -c '^take .*svc=board-postgres' "$DK/dump.log")" -ge 1 ]
    # the servers of messaging (database: null in its declaration), governance and Nextcloud: never entered
    assert_absent 'svc=messaging-postgres' "$DK/exec.log"
    assert_absent 'svc=governance-postgres' "$DK/exec.log"
    assert_absent 'svc=nextcloud-postgres' "$DK/exec.log"
    assert_absent 'svc=(messaging|governance|nextcloud)-postgres' "$DK/dump.log"
    # the blocked gate database was never taken, and the history says one was skipped
    assert_absent "${PL_H3}" "$DK/dump.log"
    [ "$(jq -s '[.[] | select(.event == "dumpset_taken")][0].blocked_skipped' "${GREMION_ROOT}/data/cd/history.jsonl")" = 1 ]
    # the role-enforcing shim saw a role of its own server on every query: no exec on a server with another server's role
    # (the shim answers 2 to a wrong role and the release would have stopped), and none was refused
    [ "$(pl_hist stage_failed)" -eq 0 ]
    # the journal never received the name of a module database
    [ "$(grep -cE '^logger .*t_[0-9a-f]{32}__(calendar|content|publishing|board)' "$SHIM_LOG")" -eq 0 ]
}

# ===========================================================================================
# kill -9 at every stage boundary, then the resume
# ===========================================================================================

# pl_kill_case REGEX NTH [plain] -- the tick dies in the call that matches; then the boot unit's
# `tick --resume-only` takes the release over (or, with plain, the timer's plain tick)
pl_kill_case() {
    local pat="$1" nth="$2"
    local -a args
    shift 2
    pl_scn_green
    pl_killed_tick "$pat" "$nth"
    # the interrupted state is a release in flight, not an idle host
    [ "$(pl_state .phase)" != idle ]
    if [ "${1:-}" = plain ]; then args=(); else args=(--resume-only); fi
    run pl_tick "${args[@]}"
    echo "$output"
    [ "$status" -eq 0 ]
    pl_no_stubs
    [ "$(pl_state .phase)" = idle ]
    [ "$(pl_state .release)" = null ]
}

# the boot unit finishes the release it finds and never starts the reconcile stage: the release is
# committed, one `released` mail, and the hold `reconcile_failed` (reason interrupted) asks the operator
# for the customer reconcile
pl_assert_boot_end() {
    pl_assert_committed
    # never a rollback
    [ "$(pl_hist rollback_started)" -eq 0 ]
    [ "$(pl_state .hold.kind)" = reconcile_failed ]
    [ "$(pl_state .hold.reason)" = interrupted ]
    [ ! -s "$DK/tenant.slugs" ]
    [ "$(pl_mails released)" -eq 1 ]
}

@test "kill -9 in the fetch, then the boot resume: the release commits" {
    pl_kill_case 'git clone --quiet --no-checkout' 1
    pl_assert_boot_end
}

@test "kill -9 in the classify, then the boot resume: the release commits" {
    pl_kill_case 'config --format json --no-env-resolution' 1
    pl_assert_boot_end
}

@test "kill -9 in the render, then the boot resume: the release commits" {
    pl_kill_case '^render --release' 1
    pl_assert_boot_end
}

@test "kill -9 in the build, then the boot resume: the release commits" {
    pl_kill_case 'app-green.env --profile . build$' 1
    pl_assert_boot_end
}

@test "kill -9 in the snapshot (the first take), then the boot resume: the release commits" {
    pl_kill_case '^dump take' 1
    pl_assert_boot_end
}

@test "kill -9 in the snapshot (the fifth take), then the boot resume: the release commits" {
    pl_kill_case '^dump take' 5
    pl_assert_boot_end
}

@test "kill -9 in the migrate (the first one-shot), then the boot resume: the release commits" {
    pl_kill_case 'gremion.cd=.* migrate$' 1
    pl_assert_boot_end
}

@test "kill -9 in the module step, then the boot resume: the release commits" {
    pl_kill_case 'tenant-create module-upgrade' 1
    pl_assert_boot_end
}

@test "kill -9 in the start, then the boot resume: the release commits" {
    pl_kill_case 'app-green.env up -d' 1
    pl_assert_boot_end
}

@test "kill -9 in the gates, then the boot resume: the release commits" {
    pl_kill_case '^isolation run' 1
    pl_assert_boot_end
}

@test "kill -9 in the switch call, then the boot resume: the switch is read from the edge and the release commits" {
    pl_kill_case '^switch green' 1
    pl_assert_boot_end
    # the first call never ran, so the edge was asked again and the switch happened once
    [ "$(pl_count '^switch green')" -eq 1 ]
}

@test "kill -9 in the watch, then the boot resume: the window goes on and the release commits" {
    pl_kill_case '--resolve .* -o /dev/null' 4
    pl_assert_boot_end
}

@test "a timer tick after a kill -9 takes the release over and ends in the state of the uninterrupted run, the reconcile included" {
    pl_kill_case 'app-green.env --profile . build$' 1 plain
    pl_assert_committed
    [ "$(pl_state .hold)" = null ]
    [ "$(pl_hist reconciled)" -eq 1 ]
    [ "$(wc -l <"$DK/tenant.slugs")" -eq 3 ]
    [ "$(pl_mails released)" -eq 1 ]
}

@test "a timer tick after a kill -9 in the watch commits and reconciles" {
    pl_kill_case '--resolve .* -o /dev/null' 4 plain
    pl_assert_committed
    [ "$(pl_state .hold)" = null ]
    [ "$(pl_hist reconciled)" -eq 1 ]
}

@test "kill -9 in the commit before the commit point, then the boot resume: the switch back, no block, the hold failure" {
    pl_kill_case '^isolation record' 1
    local l12="${C_L0:0:12}"
    [ "$(pl_state .live.sha)" = "$C_L0" ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${l12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "pilot-${l12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    # nothing the commit steps 1 to 4 wrote still names the new release
    [ "$(cat "${GREMION_ROOT}/data/isolation-recorded")" = "$C_L0" ]
    [ "$(pl_state .hold.kind)" = failure ]
    [ "$(pl_state .hold.reason)" = commit_stuck ]
    [ "$(pl_hist rolled_back)" -eq 1 ]
    [ "$(pl_blocks)" -eq 0 ]
}

@test "kill -9 in the commit after the commit point, then the boot resume: the steps after it finish forward" {
    pl_kill_case 'app-blue.env down' 1
    pl_assert_boot_end
    pl_after '^kill-9' '^down blue'
}

@test "kill -9 in the reconcile stage, then the boot resume: the hold reconcile_failed, the release stays committed" {
    pl_scn_green
    pl_killed_tick '^tenant reconcile' 2
    run pl_tick --resume-only
    echo "$output"
    [ "$status" -eq 0 ]
    pl_no_stubs
    pl_assert_committed
    [ "$(pl_state .hold.kind)" = reconcile_failed ]
    [ "$(pl_state .hold.reason)" = interrupted ]
    [ "$(pl_hist rollback_started)" -eq 0 ]
    [ "$(pl_blocks)" -eq 0 ]
}

@test "workers: new off at the start, old off then new on at the switch, new on in the gate file at the commit" {
    pl_scn_green
    run pl_tick
    [ "$status" -eq 0 ]
    pl_no_stubs
    [ "$(cat "${GREMION_ROOT}/runtime/workers/blue")" = off ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = on ]
}
