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
    if [ -z "${BATS_TEST_COMPLETED:-}" ]; then pl_diag >&3; fi
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
    [ "$(pl_state .live.sha)" = "$C_B" ]
}
