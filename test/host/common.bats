#!/usr/bin/env bats
# Tests for infra/host/lib/common.sh and the host-suite bats helper.
# Run: bats test/host/common.bats
#
# Unit only: nothing here touches docker, nft, ssh or a real /opt/gremion.

load 'test_helper/host'

setup() {
    setup_host_root
    COMMON_SH="${HOST_SRC}/lib/common.sh"
}

teardown() {
    teardown_host_root
}

# Run a snippet with common.sh sourced, in a clean subshell.
# Usage: run_with 'load_env "$1"' <args...>
run_with() {
    local snippet="$1"; shift
    run bash -c '
        set -euo pipefail
        . "$0"
        '"$snippet"'
    ' "$COMMON_SH" "$@"
}

# ---------------------------------------------------------------------------
# The helper itself (test_helper/host.bash)
# ---------------------------------------------------------------------------

@test "setup_host_root creates the section-A layout under a throwaway GREMION_ROOT" {
    [[ -n "$GREMION_ROOT" ]]
    [[ "$GREMION_ROOT" != "/opt/gremion" ]]
    local d
    for d in etc/env etc/secrets etc/edge releases bin backups runtime logs; do
        [[ -d "${GREMION_ROOT}/${d}" ]] \
            || { echo "missing layout directory: ${d}"; return 1; }
    done
}

@test "shim records the calls a program makes and keeps the real tool untouched" {
    shim docker 'echo stub-docker'
    run docker network inspect gremion_edge
    [ "$status" -eq 0 ]
    [ "$output" = "stub-docker" ]
    assert_recorded docker "network inspect gremion_edge"
}

@test "assert_recorded fails when the call was never made" {
    shim nft
    run assert_recorded nft "list ruleset"
    [ "$status" -ne 0 ]
    [[ "$output" == *"no recorded 'nft' call containing: list ruleset"* ]]
}

@test "refute_recorded fails when the call WAS made" {
    shim ssh
    ssh -o StrictHostKeyChecking=yes example.org true
    run refute_recorded ssh "example.org"
    [ "$status" -ne 0 ]
}

# ---------------------------------------------------------------------------
# common.sh — shape
# ---------------------------------------------------------------------------

@test "common.sh exists and sources without side effects" {
    [[ -f "$COMMON_SH" ]]
    run bash -c 'set -euo pipefail; . "$0"; echo sourced' "$COMMON_SH"
    [ "$status" -eq 0 ]
    [ "$output" = "sourced" ]
}

@test "every infra/host/bin program sets strict mode, sources common.sh and carries a shellcheck source directive" {
    # The directive is a standalone '# shellcheck source=' line, never folded
    # into a combined 'source=… disable=SC1091' comment: Task 14's guard regex
    # anchors on the standalone form and a combined one reads as absent.
    local p n=0
    for p in "${HOST_SRC}"/bin/*; do
        [[ -f "$p" ]] || continue
        n=$((n + 1))
        grep -q '^set -euo pipefail$' "$p" \
            || { echo "no strict mode: $p"; return 1; }
        grep -q '^\. "\$SCRIPT_DIR/\.\./lib/common\.sh"$' "$p" \
            || { echo "does not source ../lib/common.sh: $p"; return 1; }
        grep -q '^# shellcheck source=' "$p" \
            || { echo "no # shellcheck source= directive: $p"; return 1; }
    done
    [ "$n" -ge 1 ]
}

# ---------------------------------------------------------------------------
# common.sh — primitives
# ---------------------------------------------------------------------------

@test "gremion_root defaults to /opt/gremion and honours GREMION_ROOT" {
    run bash -c 'set -euo pipefail; unset GREMION_ROOT; . "$0"; gremion_root' "$COMMON_SH"
    [ "$status" -eq 0 ]
    [ "$output" = "/opt/gremion" ]

    run bash -c 'set -euo pipefail; GREMION_ROOT=/srv/x; . "$0"; gremion_root' "$COMMON_SH"
    [ "$output" = "/srv/x" ]
}

@test "die exits with the requested code and writes to stderr" {
    run_with 'die "boom" 3'
    [ "$status" -eq 3 ]
    [[ "$output" == *"boom"* ]]

    run_with 'die "boom"'
    [ "$status" -eq 1 ]
}

@test "need_cmd exits 2 and names every missing command" {
    run_with 'need_cmd bash definitely-absent-aaa definitely-absent-bbb'
    [ "$status" -eq 2 ]
    [[ "$output" == *"definitely-absent-aaa"* ]]
    [[ "$output" == *"definitely-absent-bbb"* ]]
}

@test "assert reports the post-condition and exits 1 when it does not hold" {
    run_with 'assert "true is true" true; echo after'
    [ "$status" -eq 0 ]
    [[ "$output" == *"true is true"* ]]
    [[ "$output" == *"after"* ]]

    run_with 'assert "false is true" false; echo after'
    [ "$status" -eq 1 ]
    [[ "$output" == *"false is true"* ]]
    [[ "$output" != *"after"* ]]
}

# ---------------------------------------------------------------------------
# common.sh — load_env
# ---------------------------------------------------------------------------

@test "load_env exports every KEY=VALUE" {
    printf 'A=1\nB=two words\n\n# comment\nC=\n' > "${GREMION_ROOT}/t.env"
    run_with 'load_env "$1"; echo "[$A][$B][$C]"' "${GREMION_ROOT}/t.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"[1][two words][]"* ]]
}

@test "load_env strips a trailing CR and one layer of matching quotes" {
    printf 'A="quoted"\r\nB=%s\n' "'single'" > "${GREMION_ROOT}/t.env"
    run_with 'load_env "$1"; printf "[%s][%s]\n" "$A" "$B"' "${GREMION_ROOT}/t.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"[quoted][single]"* ]]
}

@test "load_env rejects a duplicate key with exit 2 (StuRaOS #476 class)" {
    printf 'A=1\nB=2\nA=3\n' > "${GREMION_ROOT}/t.env"
    run_with 'load_env "$1"' "${GREMION_ROOT}/t.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"duplicate key"* ]]
    [[ "$output" == *"A"* ]]
}

@test "load_env rejects a CHANGE_ME_ value with exit 2" {
    printf 'PLATFORM_DOMAIN=CHANGE_ME_OPERATOR_platform_domain\n' > "${GREMION_ROOT}/t.env"
    run_with 'load_env "$1"' "${GREMION_ROOT}/t.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"PLATFORM_DOMAIN"* ]]
    [[ "$output" == *"sentinel"* ]]
}

@test "load_env accepts CHANGE_ME_ values under ALLOW_SENTINELS=1" {
    printf 'PLATFORM_DOMAIN=CHANGE_ME_OPERATOR_platform_domain\n' > "${GREMION_ROOT}/t.env"
    run_with 'ALLOW_SENTINELS=1 load_env "$1"; echo "[$PLATFORM_DOMAIN]"' "${GREMION_ROOT}/t.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"[CHANGE_ME_OPERATOR_platform_domain]"* ]]
}

@test "load_env exits 2 on a missing file" {
    run_with 'load_env "$1"' "${GREMION_ROOT}/absent.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"no such env file"* ]]
}

@test "load_env exits 2 on a line that is not KEY=VALUE" {
    printf 'A=1\nthis is not an assignment\n' > "${GREMION_ROOT}/t.env"
    run_with 'load_env "$1"' "${GREMION_ROOT}/t.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"not KEY=VALUE"* ]]
}

# ---------------------------------------------------------------------------
# common.sh — atomic_write
# ---------------------------------------------------------------------------

@test "atomic_write writes the body and leaves no .tmp behind" {
    run_with 'printf "hello\n" | atomic_write "$1" 600' "${GREMION_ROOT}/out.txt"
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/out.txt")" = "hello" ]
    [[ ! -e "${GREMION_ROOT}/out.txt.tmp" ]]
}

@test "atomic_write replaces an existing file wholesale" {
    printf 'old content that is much longer\n' > "${GREMION_ROOT}/out.txt"
    run_with 'printf "new\n" | atomic_write "$1" 600' "${GREMION_ROOT}/out.txt"
    [ "$status" -eq 0 ]
    [ "$(cat "${GREMION_ROOT}/out.txt")" = "new" ]
}

@test "atomic_write applies the mode when the filesystem carries modes" {
    if ! fs_carries_modes "$GREMION_ROOT"; then
        skip "filesystem does not carry POSIX modes (proven on the host instead)"
    fi
    run_with 'printf "x\n" | atomic_write "$1" 600' "${GREMION_ROOT}/out.txt"
    [ "$status" -eq 0 ]
    [ "$(stat -c '%a' "${GREMION_ROOT}/out.txt")" = "600" ]
}

@test "atomic_write exits 2 when the parent directory is absent" {
    run_with 'printf "x\n" | atomic_write "$1" 600' "${GREMION_ROOT}/nope/out.txt"
    [ "$status" -eq 2 ]
    [[ "$output" == *"directory does not exist"* ]]
}

@test "fs_carries_modes in common.sh agrees with the test helper" {
    local expected=1
    fs_carries_modes "$GREMION_ROOT" && expected=0
    run_with 'fs_carries_modes "$1"' "$GREMION_ROOT"
    [ "$status" -eq "$expected" ]
}
