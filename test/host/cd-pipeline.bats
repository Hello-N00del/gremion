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

@test "workers: new off at the start, old off then new on at the switch, new on in the gate file at the commit" {
    pl_scn_green
    run pl_tick
    [ "$status" -eq 0 ]
    pl_no_stubs
    [ "$(cat "${GREMION_ROOT}/runtime/workers/blue")" = off ]
    [ "$(cat "${GREMION_ROOT}/runtime/workers/green")" = on ]
}
