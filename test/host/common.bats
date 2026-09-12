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

@test "assert_absent and assert_present fail instead of answering when the file is missing" {
    local gone="${BATS_TEST_TMPDIR}/never-written"
    run assert_absent 'anything' "$gone" 'the file must exist to be judged'
    [ "$status" -ne 0 ]
    [[ "$output" == *"assert_absent: no such file"* ]]
    run assert_present 'anything' "$gone" 'the file must exist to be judged'
    [ "$status" -ne 0 ]
    [[ "$output" == *"assert_present: no such file"* ]]
}

@test "assert_absent reports the offending line and assert_present the missing pattern" {
    local f="${BATS_TEST_TMPDIR}/subject"
    printf 'alpha\ndown --volumes\n' > "$f"
    run assert_absent 'down .*(-v|--volumes)' "$f" 'volumes must never be removed'
    [ "$status" -ne 0 ]
    [[ "$output" == *"volumes must never be removed"* ]]
    [[ "$output" == *"2:down --volumes"* ]]
    run assert_present 'omega' "$f" 'omega is required'
    [ "$status" -ne 0 ]
    [[ "$output" == *"omega is required"* ]]
}

# ---------------------------------------------------------------------------
# Suite hygiene — a !-negated assertion bash throws away
#
# `! cmd` is exempt from errexit, so a negated assertion that is not its test
# body's last statement is DISCARDED: the guard reports ok over the exact
# regression it was written to catch. Nine of them had accumulated across four
# files in this suite before the whole-branch review found them, including the
# never-remove-volumes constraint and a no-forget guard over a snapshot that is
# the only copy of the pre-release data.
#
# Lesson 2 from no-host-literals.bats applies here too: a scan that reaches
# nothing reports clean. So the canary below proves the scanner still fires,
# and the suite-wide test refuses to believe a clean answer until it has
# counted the files it actually read.
# ---------------------------------------------------------------------------

@test "scan_vacuous_negations flags a discarded negation and clears the shapes that catch" {
    local f="${BATS_TEST_TMPDIR}/sample.bats"
    # The bang is substituted, never written literally: this file is itself in
    # the scanned glob, so a fixture spelled out here would be reported as a
    # real offender and the guard would be red on the day it landed. Same
    # self-reference discipline as no-host-literals.bats.
    local b='!'
    printf '%s\n' \
        '@test "mid-body: the failure is thrown away" {' \
        "    ${b} grep -q needle subject" \
        '    [ 1 -eq 1 ]' \
        '}' \
        '' \
        '@test "last statement: the body status IS the inverted status" {' \
        '    [ 1 -eq 1 ]' \
        "    ${b} grep -q needle subject" \
        '}' \
        '' \
        '@test "AND-OR list: the short circuit propagates" {' \
        "    ${b} grep -q needle subject \\" \
        '        || { echo "found it"; return 1; }' \
        '    [ 1 -eq 1 ]' \
        '}' \
        '' \
        '@test "a continued negation is judged whole, not by its first line" {' \
        "    ${b} grep -q needle \\" \
        '        subject' \
        '    [ 1 -eq 1 ]' \
        '}' \
        > "$f"
    run scan_vacuous_negations "$f"
    [ "$status" -eq 0 ]
    # Exactly two: the mid-body one on line 2 and the continued one on line 18.
    # The last-statement and AND-OR shapes must NOT be reported.
    [ "${#lines[@]}" -eq 2 ]
    [[ "${lines[0]}" == *"sample.bats:2: ${b} grep -q needle subject" ]]
    [[ "${lines[1]}" == *"sample.bats:18: ${b} grep -q needle"* ]]
}

@test "scan_vacuous_negations says nothing about a file with no negations at all" {
    local f="${BATS_TEST_TMPDIR}/clean.bats"
    printf '@test "plain" {\n    grep -q needle subject\n}\n' > "$f"
    run scan_vacuous_negations "$f"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
}

@test "no !-negated assertion in the host suite has its failure discarded" {
    # Globbed, not listed: a file nobody scans is a file nobody guards.
    local files=( "${HOST_TEST_DIR}"/*.bats )
    [ "${#files[@]}" -ge 10 ]    # vacuity: the file list must not have emptied
    run scan_vacuous_negations "${files[@]}"
    [ "$status" -eq 0 ]
    if [ -n "$output" ]; then
        echo "these !-negated assertions can never fail — move each one to the" >&2
        echo "end of its test body, or use assert_absent/refute_recorded:" >&2
        echo "$output" >&2
        return 1
    fi
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

@test "assert prints the failed command's output before it dies" {
    # A post-condition that fails while swallowing the command's own diagnosis
    # buys a second trip to the host to find out why. The wrapped command's
    # stdout AND stderr are captured and echoed, prefixed, before the FAIL.
    cat > "${GREMION_ROOT}/noisy" <<'PROBE'
#!/usr/bin/env bash
echo "stdout-evidence"
echo "stderr-evidence" >&2
exit 3
PROBE
    chmod +x "${GREMION_ROOT}/noisy"
    run_with 'assert "the noisy probe holds" "$1"; echo after' "${GREMION_ROOT}/noisy"
    [ "$status" -eq 1 ]
    [[ "$output" == *"the noisy probe holds"* ]]
    [[ "$output" == *"stdout-evidence"* ]]
    [[ "$output" == *"stderr-evidence"* ]]
    [[ "$output" != *"after"* ]]
}

@test "assert bounds the captured output to the last 40 lines" {
    cat > "${GREMION_ROOT}/verbose" <<'PROBE'
#!/usr/bin/env bash
seq 1 100
exit 1
PROBE
    chmod +x "${GREMION_ROOT}/verbose"
    run_with 'assert "the verbose probe holds" "$1"' "${GREMION_ROOT}/verbose"
    [ "$status" -eq 1 ]
    [[ "$output" == *"| 100"* ]]
    [[ "$output" == *"| 61"* ]]
    [[ "$output" != *"| 60"* ]]
}

@test "assert stays quiet about the command's output when the post-condition holds" {
    run_with 'assert "the quiet probe holds" bash -c "echo should-not-be-shown"'
    [ "$status" -eq 0 ]
    [[ "$output" == *"the quiet probe holds"* ]]
    [[ "$output" != *"should-not-be-shown"* ]]
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

@test "atomic_write fails and installs nothing when the temp path cannot be written" {
    # A directory at <path>.tmp makes cat's redirection fail. Under plain
    # errexit that already ended the function; inside `if ! ...`, where bash
    # ignores errexit, it fell through to chmod + mv, renamed that directory
    # to <path> and returned 0 -- the caller's branch never fired. The check
    # therefore runs in that context, and asserts the post-condition on disk
    # rather than the message: whether the pipeline failed anyway depended on
    # a race between the writer and the closing pipe.
    mkdir -p "${GREMION_ROOT}/out.txt.tmp"
    run_with 'if ! printf "x\n" | atomic_write "$1" 600; then echo REFUSED; exit 1; fi; echo ACCEPTED' \
        "${GREMION_ROOT}/out.txt"
    [ "$status" -ne 0 ]
    [[ "$output" == *REFUSED* ]]
    [ ! -e "${GREMION_ROOT}/out.txt" ]
}

@test "atomic_write fails and installs nothing when a directory occupies the target path" {
    # `mv -f file dir` moves the file INTO the directory and returns 0, so the
    # caller heard "written" while <path> stayed a directory holding a stray
    # <name>.tmp. Same errexit-ignored context as above.
    mkdir -p "${GREMION_ROOT}/out.txt"
    run_with 'if ! printf "x\n" | atomic_write "$1" 600; then echo REFUSED; exit 1; fi; echo ACCEPTED' \
        "${GREMION_ROOT}/out.txt"
    [ "$status" -ne 0 ]
    [[ "$output" == *REFUSED* ]]
    [ -d "${GREMION_ROOT}/out.txt" ]
    [ ! -e "${GREMION_ROOT}/out.txt/out.txt.tmp" ]
    [ ! -e "${GREMION_ROOT}/out.txt.tmp" ]
}

@test "atomic_write does not write through a symlink left at its temp path" {
    # A stale symlink at <path>.tmp would receive the body at ITS target and
    # then be renamed into place as a link, not a mode-controlled file.
    ln -s "${GREMION_ROOT}/elsewhere" "${GREMION_ROOT}/out.txt.tmp"
    run_with 'printf "x\n" | atomic_write "$1" 600' "${GREMION_ROOT}/out.txt"
    [ "$status" -eq 0 ]
    [ ! -e "${GREMION_ROOT}/elsewhere" ]
    [ ! -L "${GREMION_ROOT}/out.txt" ]
    [ -f "${GREMION_ROOT}/out.txt" ]
    [ "$(cat "${GREMION_ROOT}/out.txt")" = "x" ]
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

@test "fs_carries_modes dies when chmod itself fails instead of reporting no modes" {
    # The probe answers exactly one question: does this filesystem PERSIST a
    # mode it was given? A chmod that never ran answers nothing. Reading that
    # as "no modes here" is how every 0600/0700 post-condition quietly stops
    # being asserted on a host that does carry modes — the guard is still
    # installed, still green, and enforcing nothing.
    # The stub fails ONLY the mode probe and execs the real chmod for everything
    # else, so nothing but the probe changes behaviour.
    local real_chmod; real_chmod="$(command -v chmod)"
    shim chmod "case \"\$*\" in *.mode-probe.*) exit 1 ;; esac; exec ${real_chmod} \"\$@\""
    run_with 'if fs_carries_modes "$1"; then echo "probe=yes"; else echo "probe=no"; fi' \
        "$GREMION_ROOT"
    [ "$status" -eq 1 ]
    [[ "$output" == *"chmod"* ]]
    [[ "$output" != *"probe="* ]]
}

@test "the helper's fs_carries_modes fails the calling test instead of skipping when chmod fails" {
    # Same failure mode on the test side, where reading it as "no modes" turns
    # a real mode assertion into a permanent `skip` nobody reads.
    local real_chmod; real_chmod="$(command -v chmod)"
    shim chmod "case \"\$*\" in *.mode-probe.*) exit 1 ;; esac; exec ${real_chmod} \"\$@\""
    run bash -c '
        set -euo pipefail
        . "$0"
        if fs_carries_modes "$1"; then echo "probe=yes"; else echo "probe=no"; fi
    ' "${HOST_TEST_DIR}/test_helper/host.bash" "$GREMION_ROOT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"chmod"* ]]
    [[ "$output" != *"probe="* ]]
}
