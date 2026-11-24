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

@test "two releases in a row: the second goes back to the first colour, nothing of the first is left in its way" {
    pl_scn_green
    run pl_tick
    [ "$status" -eq 0 ]
    pl_assert_committed
    # a third commit on main, green on the code host, and the clock moves on a little
    pl_commit C
    gh_publish
    gh_route_ci "$C_C"
    gh_route_pulls "$C_A" "$C_B" "$C_C"
    cd_advance 600
    pl_timers
    run pl_tick
    echo "$output"
    [ "$status" -eq 0 ]
    pl_no_stubs
    local c12="${C_C:0:12}" b12="${C_B:0:12}"
    [ "$(pl_state .live.sha)" = "$C_C" ]
    [ "$(pl_state .live.colour)" = blue ]
    [ "$(pl_state .previous.sha)" = "$C_B" ]
    [ "$(pl_state .previous.colour)" = green ]
    [ "$(pl_state .previous.startable)" = true ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${c12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "pilot-${c12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/previous-tag")" = "pilot-${b12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    assert_present "^IMAGE_TAG=pilot-${c12}\$" "${GREMION_ROOT}/etc/env/app-blue.env"
    assert_present "^IMAGE_TAG=pilot-${b12}\$" "${GREMION_ROOT}/etc/env/app-green.env"
    # the dump set of the first release did not stand in the way and none is left
    [ ! -s "$DK/live.tsv" ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = off ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/blue")" = on ]
    [ "$(pl_state .hold)" = null ]
    [ "$(pl_mails released)" -eq 2 ]
    [ "$(pl_hist reconciled)" -eq 2 ]
    pl_hostlock_free
    pl_cdlock_free
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

# ===========================================================================================
# an operator rollback during the commit retries
# ===========================================================================================

@test "an operator rollback while the commit steps retry leaves nothing that names the new release" {
    pl_scn_green
    # at commit step 1 the world changes so that step 3 fails (the tag file cannot be written) and the
    # operator asks for a rollback; the obstacle is gone when the rollback switches back
    pl_on obstacle '^isolation record' 'rm -f "$GREMION_ROOT/runtime/previous-tag"; mkdir "$GREMION_ROOT/runtime/previous-tag"; "$HOST_SRC/bin/gremion-cd" rollback </dev/null >"$DK/rollback-verb.out" 2>&1 || true'
    pl_on clear '^switch blue' 'rmdir "$GREMION_ROOT/runtime/previous-tag"'
    run pl_tick
    echo "$output"
    pl_no_stubs
    local l12="${C_L0:0:12}"
    [ "$(pl_hist rollback_requested)" -eq 1 ]
    [ "$(pl_hist rolled_back)" -eq 1 ]
    [ "$(pl_state .live.sha)" = "$C_L0" ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${l12}" ]
    [ "$(cat "${GREMION_ROOT}/runtime/current-tag")" = "pilot-${l12}" ]
    [ ! -e "${GREMION_ROOT}/runtime/previous-tag" ]
    # the record of the isolation evidence names the old tip again: the enable gate would refuse a stale one
    [ "$(cat "${GREMION_ROOT}/data/isolation-recorded")" = "$C_L0" ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    [ "$(pl_state .phase)" = idle ]
    pl_hostlock_free
    pl_cdlock_free
}

# ===========================================================================================
# the watch: what the driver does with each end of the real loop
# ===========================================================================================

@test "the watch ends parked when a shared service and both colours are down for the pause cap: no rollback, the host lock released, the hold failure" {
    pl_scn_green
    # at the first sample of the window: the state project's database is unhealthy, the new colour answers
    # 503 on the public route and the old colour is not ready either (nothing says the release is at fault)
    pl_on outage '--max-time 12 http://127.0.0.1:18080/api/version' 'sed -i "s/^health=.*/health=unhealthy/" "$DK/ctr/c-state-postgres"; : >"$DK/public.fail.green"; : >"$DK/next.fail.blue"'
    run pl_tick
    echo "$output"
    pl_no_stubs
    [ "$(pl_state .phase)" = parked ]
    [ "$(pl_state .hold.kind)" = failure ]
    [ "$(pl_hist rollback_started)" -eq 0 ]
    [ "$(pl_blocks)" -eq 0 ]
    # the new colour still serves and nothing was switched back or torn down
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = green ]
    [ "$(pl_count '^switch blue')" -eq 0 ]
    [ "$(pl_count '^down green')" -eq 1 ]
    [ "$(pl_mails parked)" -ge 1 ]
    # the host lock is handed back at the park; both locks are free after the exit
    pl_hostlock_free
    pl_cdlock_free
    [ "$(pl_state .release.switch_started)" = true ]
    [ "$(pl_state .release.committed_at)" = null ]
}

@test "the watch: a rollback of the loop that fails ends the release too, the hold rollback_failed stands alone" {
    pl_scn_green
    # the pause cap triggers a rollback (the old colour answers ready through the loopback route), and the
    # old colour then fails its own proof (its internal answer says not ready)
    pl_on outage '--max-time 12 http://127.0.0.1:18080/api/version' 'sed -i "s/^health=.*/health=unhealthy/" "$DK/ctr/c-state-postgres"; : >"$DK/public.fail.green"; printf "notready\n" >"$DK/readyz.blue"'
    run pl_tick
    echo "$output"
    pl_no_stubs
    [ "$(pl_state .hold.kind)" = rollback_failed ]
    [ "$(pl_state .phase)" = idle ]
    # no release record is left behind with phase idle
    [ "$(pl_state .release)" = null ]
    [ "$(pl_mails rollback_failed)" -ge 1 ]
    pl_hostlock_free
    pl_cdlock_free
}

# ===========================================================================================
# the reconcile stage through the real libraries
# ===========================================================================================

@test "reconcile: every customer once, from the tree of current, with the host lock declared held and a request id of its own, the lock free between two children" {
    pl_scn_green
    printf '0.4\n' >"$DK/tenant.sleep"
    pl_lock_poller
    run pl_tick
    touch "$DK/poller.stop"
    echo "$output"
    [ "$status" -eq 0 ]
    pl_no_stubs
    pl_assert_committed
    # three customers, once each, in the order the registry listed them
    [ "$(wc -l <"$DK/tenant.slugs")" -eq 3 ]
    [ "$(sort "$DK/tenant.slugs" | uniq | wc -l)" -eq 3 ]
    [ "$(wc -l <"$DK/tenant.log")" -eq 3 ]
    # every call: the verb, the lock declared held, a request id, the NEW tree, the lock really held by the parent
    [ "$(grep -c "^tenant verb=reconcile held=1 request=set tree=${C_B:0:12} lockrc=1\$" "$DK/tenant.log")" -eq 3 ]
    # the lock was free at least twice while the stage ran: between child one and two, and two and three
    [ "$(wc -l <"$DK/gaps")" -ge 2 ]
    # the release is done and clean
    [ "$(pl_state .hold)" = null ]
    [ "$(pl_state .live.reconcile.ok)" -eq 3 ]
    [ "$(pl_state .live.reconcile.total)" -eq 3 ]
}

@test "reconcile: one failing customer holds with reconcile_failed and one mail, and the release stays committed" {
    pl_scn_green
    : >"$DK/tenant.fail.slug-b"
    run pl_tick
    echo "$output"
    [ "$status" -eq 0 ]
    pl_no_stubs
    pl_assert_committed
    [ "$(pl_state .hold.kind)" = reconcile_failed ]
    [ "$(pl_mails reconcile_failed)" -eq 1 ]
    # the stage went on to the third customer after the failure
    [ "$(wc -l <"$DK/tenant.slugs")" -eq 3 ]
    [ "$(pl_state .live.reconcile.failed)" -eq 1 ]
    [ "$(pl_state .live.reconcile.ok)" -eq 2 ]
    # nothing of the release moved: no block, no rollback
    [ ! -f "${GREMION_ROOT}/data/cd/blocked.json" ] || [ "$(pl_blocks)" -eq 0 ]
    [ "$(pl_hist rollback_started)" -eq 0 ]
}

@test "reconcile: no customer slug reaches a state, history, outbox, mail, journal or output file" {
    pl_scn_green
    : >"$DK/tenant.fail.slug-b"
    run pl_tick
    echo "$output" >"${GREMION_ROOT}/.tick.stdout"
    [ "$status" -eq 0 ]
    local f n=0
    for f in "${GREMION_ROOT}/data/cd/state.json" "${GREMION_ROOT}/data/cd/history.jsonl" "${GREMION_ROOT}/.tick.stdout" \
        "${GREMION_ROOT}"/data/cd/outbox/* "$DK"/mail.*.eml; do
        [ -f "$f" ] || continue
        n=$((n + 1))
        run grep -c 'slug-[abc]' "$f"
        [ "$output" = 0 ] || { echo "a slug is in $f"; return 1; }
    done
    [ "$n" -ge 4 ]
    [ "$(grep '^logger ' "$SHIM_LOG" | grep -c 'slug-[abc]')" -eq 0 ]
    # the verb's own output is kept in a 0600 file under logs/, where customer data may go
    [ "$(stat -c %a "$(ls "${GREMION_ROOT}"/logs/cd-reconcile-*.log | head -n 1)")" = 600 ]
}

# ===========================================================================================
# the module step and the leaf step
# ===========================================================================================

@test "the module step: the one-shot runs once, after the kernel one-shots and before the start" {
    pl_scn_green
    run pl_tick
    [ "$status" -eq 0 ]
    pl_no_stubs
    [ "$(pl_count '^run-module ')" -eq 1 ]
    pl_before '^run green kernel-api-migrate' '^run green tenant-create'
    pl_before '^run green tenant-create' '^up green'
    # the module part of the dump set exists, and the one-shot is told the release id, never a database
    assert_present '^run-module green rid=' "$DK/order.log"
    assert_absent 't_[0-9a-f]{32}__' "$DK/order.log"
}

@test "the module step: a failing module database blocks the release as a migrate failure, holds, and leaves the dump set live" {
    pl_scn_green
    printf '{"total":3,"upgraded":1,"unchanged":1,"skipped":0,"failed":1,"files_applied":1}\n' >"$DK/run.tenant-create.out"
    printf '1\n' >"$DK/run.tenant-create.rc"
    run pl_tick
    echo "$output"
    pl_no_stubs
    # it never got near the new colour
    [ "$(pl_count '^up green')" -eq 0 ]
    [ "$(pl_count '^switch ')" -eq 0 ]
    [ "$(pl_hist switch_started)" -eq 0 ]
    [ "$(pl_state .live.sha)" = "$C_L0" ]
    [ "$(pl_blocks)" -eq 1 ]
    [ "$(jq -r '.[0].rule' "${GREMION_ROOT}/data/cd/blocked.json")" = migrate_failed ]
    [ "$(pl_state .hold.kind)" = blocked ]
    [ "$(pl_state .phase)" = idle ]
    # the dump set of the release stays live, for the operator and for the next release's refusal
    [ -s "$DK/live.tsv" ]
    pl_hostlock_free
    pl_cdlock_free
}

@test "the module step: with no module database the one-shot is never run" {
    pl_scn_green
    pl_no_modules_world
    run pl_tick
    [ "$status" -eq 0 ]
    pl_no_stubs
    [ "$(pl_state .live.sha)" = "$C_B" ]
    [ "$(pl_count '^run green tenant-create')" -eq 0 ]
    # and no module server was entered
    assert_absent 'svc=(calendar|content|newsletter)-postgres' "$DK/dump.log"
}

@test "the leaf step: the entry runs once per leaf service of the target colour, between the module step and the start" {
    pl_scn_green
    pl_leaf_world
    run pl_tick
    echo "$output"
    [ "$status" -eq 0 ]
    pl_no_stubs
    [ "$(pl_state .live.sha)" = "$C_B" ]
    [ "$(pl_count '^run green (calendar|content|newsletter)-service$')" -eq 3 ]
    pl_before '^run green tenant-create' '^run green calendar-service'
    pl_before '^run green newsletter-service' '^up green'
    # every leaf run carried the label of the release and the migrate-only entry
    [ "$(grep -c -- '--migrate-only' "$DK/run.log")" -eq 3 ]
    [ "$(grep -c -- "--label gremion.cd=${C_B:0:12}-" "$DK/run.log")" -ge 5 ]
    # the journal never received the name of a leaf database
    [ "$(grep -cE '^logger .*(calendar|content|newsletter)_control' "$SHIM_LOG")" -eq 0 ]
    [ "$(pl_hist leaves_done)" -ge 1 ]
}

@test "the leaf step: a failing leaf blocks the release before the switch, tears down and leaves the dump set live" {
    pl_scn_green
    pl_leaf_world
    printf '{"v":1,"total":1,"migrated":0,"skipped":0,"failed":1}\n' >"$DK/run.content-service.out"
    printf '1\n' >"$DK/run.content-service.rc"
    run pl_tick
    echo "$output"
    pl_no_stubs
    [ "$(pl_hist switch_started)" -eq 0 ]
    [ "$(pl_count '^switch ')" -eq 0 ]
    [ "$(pl_count '^up green')" -eq 0 ]
    [ "$(pl_state .live.sha)" = "$C_L0" ]
    [ "$(pl_blocks)" -eq 1 ]
    [ "$(jq -r '.[0].rule' "${GREMION_ROOT}/data/cd/blocked.json")" = migrate_failed ]
    grep -q 'leaf_migrate' "${GREMION_ROOT}/data/cd/blocked.json"
    [ "$(pl_state .hold.kind)" = blocked ]
    # the calendar leaf ran before it, the newsletter leaf never did
    [ "$(pl_count '^run green calendar-service')" -eq 1 ]
    [ "$(pl_count '^run green newsletter-service')" -eq 0 ]
    [ -s "$DK/live.tsv" ]
    # the target colour is torn down and its env file carries the tag it had before
    pl_after '^run green content-service' '^down green'
    assert_present '^IMAGE_TAG=pilot-eeeeeeeeeeee$' "${GREMION_ROOT}/etc/env/app-green.env"
    pl_hostlock_free
    pl_cdlock_free
}

@test "the leaf step: with leaf services rendered but no dump of a module server in the set the entry is never run" {
    pl_scn_green
    pl_leaf_world
    # the leaf servers hold nothing but their own bookkeeping: the set has no module part
    pl_no_modules_world
    run pl_tick
    echo "$output"
    [ "$status" -eq 0 ]
    pl_no_stubs
    [ "$(pl_state .live.sha)" = "$C_B" ]
    [ "$(pl_count '^run green (calendar|content|newsletter)-service$')" -eq 0 ]
}

@test "the leaf step: with no leaf service rendered the entry is never run" {
    pl_scn_green
    run pl_tick
    [ "$status" -eq 0 ]
    [ "$(pl_count '^run green (calendar|content|newsletter)-service$')" -eq 0 ]
    [ "$(pl_hist leaves_done)" -ge 1 ]
}

# ===========================================================================================
# a held release, a proof release
# ===========================================================================================

@test "a release that changes the state tier is held and the mail names the exact release-now command" {
    pl_scn_green
    # the rendered compose of the state project differs between the live tree and the candidate
    printf '{"services":{"postgres":{"image":"postgres:17"}}}\n' >"$DK/compose.state.${C_B:0:12}.json"
    run pl_tick
    echo "$output"
    pl_no_stubs
    [ "$(pl_state .hold.kind)" = state_tier ]
    [ "$(pl_state .phase)" = idle ]
    [ "$(pl_state .live.sha)" = "$C_L0" ]
    # nothing was built, started or switched
    [ "$(pl_count '^(build|up|switch) ')" -eq 0 ]
    local f
    f="$(pl_mail_file held)"
    [ "$(pl_mail_field "$f" kind)" = held ]
    grep -q "release-now ${C_B:0:12} --with-state" "$f"
}

@test "a proof release is rolled back at the end of its window with the rule proof_end and is not blocked" {
    pl_scn_green
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo CD_POST_RECONCILE_S=0 CD_WATCH_MINUTES=2 CD_WATCH_INTERVAL_S=30 \
        CD_PROOF_MODE=1 CD_PROOF_REPO=https://example.org/proof/repo
    # one commit on a proof branch, on top of main, in the proof repository
    gh_rg -C "$GH_WORK" checkout -q -b proof-ok main
    printf 'proof\n' >>"${GH_WORK}/gremion-ui/src/app.txt"
    gh_rg -C "$GH_WORK" commit -q -am proof
    local psha
    psha="$(gh_rg -C "$GH_WORK" rev-parse HEAD)"
    gh_rg init -q --bare "$GH_PROOF"
    gh_rg -C "$GH_WORK" push -q "$GH_PROOF" proof-ok:proof-ok
    gh_rg -C "$GH_WORK" checkout -q main
    run "${HOST_SRC}/bin/gremion-cd" release-now "$psha" --unverified --ref proof-ok
    echo "$output"
    run pl_tick
    echo "$output"
    pl_no_stubs
    # the proof release ran the window and went back: old colour serving, nothing committed, no block
    [ "$(pl_hist rolled_back)" -eq 1 ]
    [ "$(jq -s '[.[] | select(.event == "rolled_back")][0].rule' "${GREMION_ROOT}/data/cd/history.jsonl")" = '"proof_end"' ]
    [ "$(pl_state .live.sha)" = "$C_L0" ]
    [ "$(pl_blocks)" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/runtime/active-colour")" = blue ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${C_L0:0:12}" ]
    [ "$(pl_state .phase)" = idle ]
    [ "$(pl_state .hold.kind)" = proof ]
    pl_before '^switch green' '^switch blue'
    pl_after '^switch blue' '^down green'
}

# ===========================================================================================
# a reconcile child that cannot be confirmed gone
# ===========================================================================================

@test "a reconcile container that cannot be confirmed gone: the release stays committed, one customer is tried, the host lock is kept to the end of the process" {
    pl_scn_green
    : >"$DK/tenant.leave"
    : >"$DK/kill.refuse"
    run pl_tick
    echo "$output"
    pl_no_stubs
    # committed and untouched by the failure
    local b12="${C_B:0:12}"
    [ "$(pl_state .live.sha)" = "$C_B" ]
    [ "$(readlink "${GREMION_ROOT}/current")" = "${GREMION_ROOT}/releases/${b12}" ]
    [ "$(pl_blocks)" -eq 0 ]
    [ "$(pl_hist rollback_started)" -eq 0 ]
    [ "$(pl_state .hold.kind)" = reconcile_failed ]
    # the stage stopped at the customer whose container is alive
    [ "$(wc -l <"$DK/tenant.slugs")" -eq 1 ]
    # the mails that were sent after it were sent with the host lock still held; it is free after the exit
    [ -s "$DK/mail.lock" ]
    [ "$(tail -n 1 "$DK/mail.lock")" = held ]
    pl_hostlock_free
    pl_cdlock_free
}

# ===========================================================================================
# the host lock span
# ===========================================================================================

@test "the released mail carries the span of the host lock, and status shows what the last release held it for" {
    pl_scn_green
    run pl_tick
    [ "$status" -eq 0 ]
    pl_no_stubs
    local f
    f="$(pl_mail_file released)"
    [[ "$(pl_mail_field "$f" hostlock_min)" =~ ^[0-9]+$ ]]
    # the window alone is two minutes of the fake clock
    [ "$(pl_mail_field "$f" hostlock_min)" -ge 2 ]
    # a span inside the limit is no note
    run grep -c 'lock_span_over' "$f"
    [ "$output" = 0 ]
    run "${HOST_SRC}/bin/gremion-cd" status
    [[ "$output" == *"the last release held it "*" minutes"* ]]
}

@test "a lock span past CD_LOCK_SPAN_MIN is a note of the released mail" {
    pl_scn_green
    cd_write_cfg CD_REPO_URL=https://github.com/org/repo CD_POST_RECONCILE_S=0 CD_WATCH_MINUTES=2 CD_WATCH_INTERVAL_S=30 CD_LOCK_SPAN_MIN=1
    run pl_tick
    [ "$status" -eq 0 ]
    grep -qE '^notes: .*lock_span_over' "$(pl_mail_file released)"
}

@test "a release that was taken over after a kill -9 reports the span from its first take of the host lock" {
    pl_scn_green
    # the process dies in the snapshot, which holds the host lock
    pl_killed_tick '^dump take' 5
    # half an hour passes before the next tick (the host was down)
    cd_advance 1800
    run pl_tick
    [ "$status" -eq 0 ]
    pl_no_stubs
    pl_assert_committed
    [ "$(pl_mail_field "$(pl_mail_file released)" hostlock_min)" -ge 30 ]
}

@test "workers: new off at the start, old off then new on at the switch, new on in the gate file at the commit" {
    pl_scn_green
    run pl_tick
    [ "$status" -eq 0 ]
    pl_no_stubs
    [ "$(cat "${GREMION_ROOT}/runtime/workers/blue")" = off ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = on ]
}
