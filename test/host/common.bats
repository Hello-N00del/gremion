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

@test "control_panel_key_of: one line is read (quotes and CR dropped), an absent key or file is empty, and a key on two lines is REFUSED like load_env refuses it" {
    printf 'CONTROL_PANEL_ORIGIN="https://control.example.org"\r\nOTHER=1\n' > "${GREMION_ROOT}/t.env"
    run_with 'control_panel_origin_of "$1"' "${GREMION_ROOT}/t.env"
    [ "$status" -eq 0 ]
    [ "$output" = "https://control.example.org" ]
    run_with 'control_panel_host_of "$1"' "${GREMION_ROOT}/t.env"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    run_with 'control_panel_host_of "$1"' "${GREMION_ROOT}/no-such.env"
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    # a duplicate is a refusal, not "the last line wins": which line was meant cannot be told
    printf 'CONTROL_PANEL_ORIGIN=https://a.example.org\nX=1\nCONTROL_PANEL_ORIGIN=https://b.example.org\n' > "${GREMION_ROOT}/dup.env"
    run_with 'control_panel_origin_of "$1"' "${GREMION_ROOT}/dup.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"CONTROL_PANEL_ORIGIN is set on 2 lines"* ]] || { echo "$output"; return 1; }
    [[ "$output" != *"b.example.org"* ]]
    printf 'CONTROL_PANEL_HOST=a.example.org\nCONTROL_PANEL_HOST=\n' > "${GREMION_ROOT}/dup-host.env"
    run_with 'control_panel_host_of "$1"' "${GREMION_ROOT}/dup-host.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"CONTROL_PANEL_HOST is set on 2 lines"* ]]
    # the way every caller uses it: an assignment under set -e stops the caller
    run_with 'v="$(control_panel_origin_of "$1")"; echo reached' "${GREMION_ROOT}/dup.env"
    [ "$status" -eq 2 ]
    [[ "$output" != *"reached"* ]]
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

# -- load_env against a REAL gremion-init-secrets render (TASK-028, B15 1-2) --
#
# The fixtures above are hand-written; these run the actual renderer into the
# throwaway root and then damage one line, so the gate is measured against the
# files a host really loads. ALLOW_SENTINELS=1 because a fresh render still
# carries the operator's CHANGE_ME_OPERATOR_ keys; the refusals under test are
# the ones that flag does NOT waive.

render_real_env() {
    "${HOST_SRC}/bin/gremion-init-secrets" --root "$GREMION_ROOT" --stack teststack >/dev/null
}

# set_key <file> <KEY> <value> -- replace the single KEY= line in place.
set_key() {
    sed -i "s|^$2=.*|$2=$3|" "$1"
    grep -q "^$2=$3\$" "$1" || { echo "set_key: $2 not rewritten in $1"; return 1; }
}

@test "load_env loads an untouched real render (sentinels allowed)" {
    render_real_env
    local f
    for f in state app-blue app-green mail ops; do
        run_with 'ALLOW_SENTINELS=1 load_env "$1"' "${GREMION_ROOT}/etc/env/${f}.env"
        [ "$status" -eq 0 ] || { echo "${f}.env: $output"; return 1; }
    done
}

@test "load_env refuses a duplicate key in a real rendered app-blue.env, naming the key" {
    render_real_env
    local f="${GREMION_ROOT}/etc/env/app-blue.env"
    printf 'COLOUR=green\n' >> "$f"
    run_with 'ALLOW_SENTINELS=1 load_env "$1"' "$f"
    [ "$status" -eq 2 ]
    [[ "$output" == *"duplicate key"* ]]
    [[ "$output" == *"COLOUR"* ]]
}

@test "load_env refuses an EMPTY value for a key app.env.tmpl marks CHANGE_ME_GEN_" {
    render_real_env
    local f="${GREMION_ROOT}/etc/env/app-blue.env"
    set_key "$f" AUTH_SECRET ''
    run_with 'ALLOW_SENTINELS=1 load_env "$1"' "$f"
    [ "$status" -eq 2 ]
    [[ "$output" == *"AUTH_SECRET"* ]]
    [[ "$output" == *"empty"* ]]
}

@test "load_env refuses an EMPTY value for a key state.env.tmpl marks CHANGE_ME_GEN_ (embedded in a URL)" {
    render_real_env
    local f="${GREMION_ROOT}/etc/env/state.env"
    set_key "$f" GREMION_PUBLIC_DB_URL ''
    run_with 'ALLOW_SENTINELS=1 load_env "$1"' "$f"
    [ "$status" -eq 2 ]
    [[ "$output" == *"GREMION_PUBLIC_DB_URL"* ]]
}

@test "load_env keeps accepting an empty key the template does NOT mark secret (SEED_TOKEN)" {
    render_real_env
    local f="${GREMION_ROOT}/etc/env/state.env"
    grep -q '^SEED_TOKEN=$' "$f"
    run_with 'ALLOW_SENTINELS=1 load_env "$1"; echo "[${SEED_TOKEN}]"' "$f"
    [ "$status" -eq 0 ]
    [[ "$output" == *"[]"* ]]
}

@test "load_env takes the template as an explicit second argument" {
    printf 'SECRET_A=\nPLAIN=\n' > "${GREMION_ROOT}/t.env"
    printf 'SECRET_A=CHANGE_ME_GEN_hex32_a\nPLAIN=\n' > "${GREMION_ROOT}/t.env.tmpl"
    run_with 'load_env "$1" "$2"' "${GREMION_ROOT}/t.env" "${GREMION_ROOT}/t.env.tmpl"
    [ "$status" -eq 2 ]
    [[ "$output" == *"SECRET_A"* ]]
    [[ "$output" != *"PLAIN"* ]]
}

@test "load_env fails closed when a host env file's template cannot be found" {
    render_real_env
    run_with 'GREMION_ENV_TEMPLATE_DIR="$2" ALLOW_SENTINELS=1 load_env "$1"' \
        "${GREMION_ROOT}/etc/env/state.env" "${GREMION_ROOT}/no-such-dir"
    [ "$status" -eq 2 ]
    [[ "$output" == *"template"* ]]
}

# The INSTALLED layout: bootstrap puts only bin/ and lib/ under the root, so no
# template sits beside lib/. The active release's copy is used when present...
install_lib_only() {
    mkdir -p "${GREMION_ROOT}/lib"
    cp "$COMMON_SH" "${GREMION_ROOT}/lib/common.sh"
    printf '%s' "${GREMION_ROOT}/lib/common.sh"
}

@test "installed layout: the template under <root>/current is used, so an empty secret is still refused" {
    render_real_env
    local lib; lib="$(install_lib_only)"
    mkdir -p "${GREMION_ROOT}/current/infra/host/templates"
    cp -r "${HOST_SRC}/templates/env" "${GREMION_ROOT}/current/infra/host/templates/env"
    set_key "${GREMION_ROOT}/etc/env/state.env" AUTH_SECRET ''
    run bash -c 'set -euo pipefail; . "$0"; ALLOW_SENTINELS=1 load_env "$1"' \
        "$lib" "${GREMION_ROOT}/etc/env/state.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"AUTH_SECRET"* ]]
}

# ...and with no release at all it says LOUDLY that the one check did not run,
# while every other refusal still holds.
@test "installed layout, no release: a loud WARN, the other refusals still run" {
    render_real_env
    local lib; lib="$(install_lib_only)"
    run bash -c 'set -euo pipefail; . "$0"; ALLOW_SENTINELS=1 load_env "$1"; echo LOADED' \
        "$lib" "${GREMION_ROOT}/etc/env/state.env"
    [ "$status" -eq 0 ]
    [[ "$output" == *"WARN"* ]]
    [[ "$output" == *"empty-secret check did NOT run"* ]]
    [[ "$output" == *"LOADED"* ]]
    printf 'STACK=dup\n' >> "${GREMION_ROOT}/etc/env/state.env"
    run bash -c 'set -euo pipefail; . "$0"; ALLOW_SENTINELS=1 load_env "$1"' \
        "$lib" "${GREMION_ROOT}/etc/env/state.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"duplicate key"* ]]
}

@test "an explicit template argument that does not exist is a refusal, never a skip" {
    printf 'A=1\n' > "${GREMION_ROOT}/t.env"
    run_with 'load_env "$1" "$2"' "${GREMION_ROOT}/t.env" "${GREMION_ROOT}/absent.tmpl"
    [ "$status" -eq 2 ]
    [[ "$output" == *"absent.tmpl"* ]]
}

@test "an ALLOW_SENTINELS=1 line inside the file does not waive the sentinel refusal (review finding)" {
    printf 'ALLOW_SENTINELS=1\nACME_EMAIL=CHANGE_ME_OPERATOR_acme_email\n' > "${GREMION_ROOT}/t.env"
    run_with 'load_env "$1"' "${GREMION_ROOT}/t.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"ALLOW_SENTINELS"* ]]
}

@test "load_env refuses keys that steer the shell or the loader itself" {
    local k
    for k in ALLOW_SENTINELS GREMION_ENV_TEMPLATE_DIR PATH IFS BASH_ENV LD_PRELOAD GREMION_EXIT_ASSERT GREMION_EXIT_USAGE GREMION_LIB_DIR C_BAD; do
        printf 'A=1\n%s=x\n' "$k" > "${GREMION_ROOT}/t.env"
        run_with 'load_env "$1"' "${GREMION_ROOT}/t.env"
        [ "$status" -eq 2 ] || { echo "$k was accepted"; return 1; }
        [[ "$output" == *"$k"* ]]
    done
}

@test "a whitespace-only value counts as empty for a template-marked secret" {
    render_real_env
    local f="${GREMION_ROOT}/etc/env/app-blue.env"
    set_key "$f" AUTH_SECRET '"  "'
    run_with 'ALLOW_SENTINELS=1 load_env "$1"' "$f"
    [ "$status" -eq 2 ]
    [[ "$output" == *"AUTH_SECRET"* ]]
}

@test "load_env never echoes a malformed line (it may hold a secret)" {
    printf 'A=1\nexport LEAKY=fake-secret-value-0000\n' > "${GREMION_ROOT}/t.env"
    run_with 'load_env "$1"' "${GREMION_ROOT}/t.env"
    [ "$status" -eq 2 ]
    [[ "$output" == *"not KEY=VALUE"* ]]
    [[ "$output" == *"line 2"* ]]
    [[ "$output" != *"fake-secret-value-0000"* ]]
}

@test "the load_env header states the #476 defect the right way round (first occurrence read)" {
    run grep -c 'read the FIRST occurrence' "$COMMON_SH"
    [ "$output" -ge 1 ]
    run grep -c 'silently read the LAST occurrence' "$COMMON_SH"
    [ "$output" -eq 0 ]
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

# ---------------------------------------------------------------------------
# SECONDARY_TENANT_HOSTS: the optional allow-list of extra customer hosts (core-only customers)
# ---------------------------------------------------------------------------

@test "secondary_hosts_problem: empty is fine, a clean list is fine, and every malformed entry is named by its position and reason" {
    run_with 'secondary_hosts_problem "" plat.example.org pilot.example.org control.plat.example.org'
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    run_with 'secondary_hosts_problem "canary.example.org,test.example.net" plat.example.org pilot.example.org control.plat.example.org'
    [ "$status" -eq 0 ]
    [ -z "$output" ]
    local bad want
    while IFS='|' read -r bad want; do
        run_with 'secondary_hosts_problem "$1" plat.example.org pilot.example.org control.plat.example.org' "$bad"
        [ "$status" -eq 1 ] || { echo "accepted: ${bad}"; return 1; }
        [[ "$output" == *"entry 1"* ]] || { echo "no position for ${bad}: ${output}"; return 1; }
        [[ "$output" == *"$want"* ]] || { echo "wrong reason for ${bad}: ${output}"; return 1; }
    done <<'CASES'
https://canary.example.org|scheme
canary.example.org:8443|port
canary.example.org/path|path
*.example.org|wildcard
Canary.Example.org|not lowercase
canary.example.org.|trailing dot
canary|single label
203.0.113.7|IP address
plat.example.org|platform domain
www.plat.example.org|platform host
pilot.example.org|PILOT_TENANT_HOST
turn.pilot.example.org|video relay
control.plat.example.org|control panel
CASES
}

@test "secondary_hosts_problem: a duplicate, a leading, doubled or trailing comma, and white space are refused" {
    run_with 'secondary_hosts_problem "a.example.org,b.example.org,a.example.org" plat.example.org pilot.example.org control.plat.example.org'
    [ "$status" -eq 1 ]
    [[ "$output" == *"duplicate"* ]] || { echo "$output"; return 1; }
    local bad
    for bad in ',a.example.org' 'a.example.org,' 'a.example.org,,b.example.org' 'a.example.org, b.example.org' ' a.example.org'; do
        run_with 'secondary_hosts_problem "$1" plat.example.org pilot.example.org control.plat.example.org' "$bad"
        [ "$status" -eq 1 ] || { echo "accepted: '${bad}'"; return 1; }
    done
}

@test "secondary_hosts_has: exact whole-entry match after lowercasing, never a substring or a glob" {
    run_with 'secondary_hosts_has "canary.example.org,test.example.net" "Canary.Example.org"'
    [ "$status" -eq 0 ]
    run_with 'secondary_hosts_has "canary.example.org,test.example.net" test.example.net'
    [ "$status" -eq 0 ]
    local other
    for other in example.org canary.example.or 'canary.example.org,test.example.net' '*' '*.example.org' 'xcanary.example.org' ''; do
        run_with 'secondary_hosts_has "canary.example.org,test.example.net" "$1"' "$other"
        [ "$status" -eq 1 ] || { echo "matched: '${other}'"; return 1; }
    done
    run_with 'secondary_hosts_has "" canary.example.org'
    [ "$status" -eq 1 ]
    run_with 'secondary_hosts_has "a.example.org,,b.example.org" ""'
    [ "$status" -eq 1 ]
}

@test "secondary_host_module_allowed: only board and calendar are allowed on a secondary host; everything else, a module of the shared services or one that mails the primary host's links first, is refused" {
    local m
    for m in board calendar; do
        run_with 'secondary_host_module_allowed "$1"' "$m"
        [ "$status" -eq 0 ] || { echo "refused: ${m}"; return 1; }
    done
    for m in content publishing newsletter messaging messages files votes elections finance vault handover unknown-module ''; do
        run_with 'secondary_host_module_allowed "$1"' "$m"
        [ "$status" -eq 1 ] || { echo "allowed: '${m}'"; return 1; }
    done
}

# ---------------------------------------------------------------------------
# SECONDARY_TENANT_MODULES (state.env, optional): the opt-in for shared-service modules of a secondary-host customer
# ---------------------------------------------------------------------------

@test "secondary_host_module_allowed with SECONDARY_TENANT_MODULES: only the listed ids of the fixed opt-in set join board and calendar, and the key absent or empty changes nothing" {
    local m
    # the key absent and empty: exactly the two core modules (the test above), nothing else
    for m in files votes messaging publishing content; do
        run_with 'secondary_host_module_allowed "$1"' "$m"
        [ "$status" -eq 1 ] || { echo "allowed without the key: ${m}"; return 1; }
        SECONDARY_TENANT_MODULES='' run_with 'secondary_host_module_allowed "$1"' "$m"
        [ "$status" -eq 1 ] || { echo "allowed with an empty key: ${m}"; return 1; }
    done
    # files and votes opted in: those two join, nothing else does
    for m in board calendar files votes; do
        SECONDARY_TENANT_MODULES='files votes' run_with 'secondary_host_module_allowed "$1"' "$m"
        [ "$status" -eq 0 ] || { echo "refused with the opt-in: ${m}"; return 1; }
    done
    for m in messaging messages publishing newsletter content elections finance vault ''; do
        SECONDARY_TENANT_MODULES='files votes' run_with 'secondary_host_module_allowed "$1"' "$m"
        [ "$status" -eq 1 ] || { echo "allowed beyond the opt-in: '${m}'"; return 1; }
    done
    # a single id opts in that id only
    SECONDARY_TENANT_MODULES='votes' run_with 'secondary_host_module_allowed "$1"' files
    [ "$status" -eq 1 ]
    SECONDARY_TENANT_MODULES='messaging' run_with 'secondary_host_module_allowed "$1"' messaging
    [ "$status" -eq 0 ]
}

@test "secondary_host_module_allowed: an id outside the fixed opt-in set is never allowed, whatever the key says (publishing stays out: its mail links name the primary host)" {
    local m
    for m in publishing newsletter content elections finance vault handover some-new-module 'files,votes' 'FILES'; do
        SECONDARY_TENANT_MODULES="${m} files" run_with 'secondary_host_module_allowed "$1"' "$m"
        [ "$status" -eq 1 ] || { echo "allowed through the key: '${m}'"; return 1; }
    done
}

@test "secondary_optin_manifest_id maps catalogue ids to manifest ids as the two secondary lists do: files, votes, messaging->messages, nothing else" {
    run_with 'secondary_optin_manifest_id files'
    [ "$status" -eq 0 ]; [ "$output" = files ]
    run_with 'secondary_optin_manifest_id votes'
    [ "$status" -eq 0 ]; [ "$output" = votes ]
    run_with 'secondary_optin_manifest_id messaging'
    [ "$status" -eq 0 ]; [ "$output" = messages ]
    local m
    for m in messages publishing newsletter content board calendar '' unknown; do
        run_with 'secondary_optin_manifest_id "$1"' "$m"
        [ "$status" -eq 1 ] || { echo "mapped: '${m}'"; return 1; }
    done
}

@test "secondary_tenant_modules_problem: an empty list is fine; a clean files/votes list is fine; unknown, not-yet-allowed, duplicate, comma-separated and upper-case entries are named by position" {
    run_with 'secondary_tenant_modules_problem "" "" "" "" ""'
    [ "$status" -eq 0 ]; [ -z "$output" ]
    run_with 'secondary_tenant_modules_problem "files votes" "canary.example.org" "" "" ""'
    [ "$status" -eq 0 ]; [ -z "$output" ]
    run_with 'secondary_tenant_modules_problem "votes" "canary.example.org" "" "" ""'
    [ "$status" -eq 0 ]
    local bad
    for bad in 'some-new-module' 'newsletter' 'content' 'elections' 'messages' 'FILES' 'files,votes' 'files votes files' ; do
        run_with 'secondary_tenant_modules_problem "$1" "canary.example.org" "off" "namespaced" "namespaced"' "$bad"
        [ "$status" -eq 1 ] || { echo "accepted '${bad}'"; return 1; }
        [[ "$output" == *"entry "* ]] || { echo "no position for '${bad}': ${output}"; return 1; }
    done
    run_with 'secondary_tenant_modules_problem "files votes files" "canary.example.org" "" "" ""'
    [[ "$output" == *"entry 3"* && "$output" == *"duplicate of entry 1"* ]] || { echo "$output"; return 1; }
    run_with 'secondary_tenant_modules_problem "publishing" "canary.example.org" "" "" ""'
    [[ "$output" == *"entry 1"* && "$output" == *"publishing"* && "$output" == *"mail"* ]] || { echo "$output"; return 1; }
}

@test "secondary_tenant_modules_problem: the key without SECONDARY_TENANT_HOSTS is refused" {
    run_with 'secondary_tenant_modules_problem "files" "" "" "" ""'
    [ "$status" -eq 1 ]
    [[ "$output" == *"SECONDARY_TENANT_HOSTS"* ]] || { echo "$output"; return 1; }
}

@test "secondary_tenant_modules_problem: messaging needs SYNAPSE_JWT_LOGIN=off and MATRIX_IDENTITY=namespaced on BOTH colours, and names the missing switch" {
    run_with 'secondary_tenant_modules_problem "messaging" "canary.example.org" "off" "namespaced" "namespaced"'
    [ "$status" -eq 0 ]; [ -z "$output" ]
    run_with 'secondary_tenant_modules_problem "files messaging" "canary.example.org" "off" "namespaced" "namespaced"'
    [ "$status" -eq 0 ]
    run_with 'secondary_tenant_modules_problem "messaging" "canary.example.org" "" "namespaced" "namespaced"'
    [ "$status" -eq 1 ]; [[ "$output" == *"SYNAPSE_JWT_LOGIN"* && "$output" != *"MATRIX_IDENTITY"* ]] || { echo "$output"; return 1; }
    run_with 'secondary_tenant_modules_problem "messaging" "canary.example.org" "on" "namespaced" "namespaced"'
    [ "$status" -eq 1 ]; [[ "$output" == *"SYNAPSE_JWT_LOGIN"* ]] || { echo "$output"; return 1; }
    run_with 'secondary_tenant_modules_problem "messaging" "canary.example.org" "off" "" "namespaced"'
    [ "$status" -eq 1 ]; [[ "$output" == *"MATRIX_IDENTITY"* && "$output" == *"app-blue.env"* && "$output" != *"app-green.env"* ]] || { echo "$output"; return 1; }
    run_with 'secondary_tenant_modules_problem "messaging" "canary.example.org" "off" "namespaced" "shared"'
    [ "$status" -eq 1 ]; [[ "$output" == *"MATRIX_IDENTITY"* && "$output" == *"app-green.env"* && "$output" != *"app-blue.env"* ]] || { echo "$output"; return 1; }
    run_with 'secondary_tenant_modules_problem "messaging" "canary.example.org" "" "" ""'
    [ "$status" -eq 1 ]; [[ "$output" == *"SYNAPSE_JWT_LOGIN"* && "$output" == *"app-blue.env"* && "$output" == *"app-green.env"* ]] || { echo "$output"; return 1; }
    # files and votes need neither switch
    run_with 'secondary_tenant_modules_problem "files votes" "canary.example.org" "" "" ""'
    [ "$status" -eq 0 ]
}

# secondary_optin_load <state.env>: the one reader the create and the module guard share. It reads state.env (and
# the two app files beside it for the messaging switch), refuses a bad opt-in, and sets SECONDARY_TENANT_MODULES
# to the validated list, whatever the caller's environment held.
@test "secondary_optin_load: key absent leaves the opt-in empty, even when the caller's environment names one" {
    local d="${BATS_TEST_TMPDIR}/optin"; mkdir -p "$d"
    printf 'SECONDARY_TENANT_HOSTS=canary.example.org\n' > "$d/state.env"
    SECONDARY_TENANT_MODULES='files votes' run_with 'secondary_optin_load "$1"; printf "[%s]" "$SECONDARY_TENANT_MODULES"' "$d/state.env"
    [ "$status" -eq 0 ]; [ "$output" = '[]' ] || { echo "$output"; return 1; }
    run_with 'secondary_optin_load "$1"; printf "[%s]" "$SECONDARY_TENANT_MODULES"' "$d/no-such-file.env"
    [ "$status" -eq 0 ]; [ "$output" = '[]' ] || { echo "$output"; return 1; }
}

@test "secondary_optin_load: reads the key from the file (quotes stripped) and the allow function then accepts exactly those ids" {
    local d="${BATS_TEST_TMPDIR}/optin"; mkdir -p "$d"
    printf 'SECONDARY_TENANT_HOSTS=canary.example.org\nSECONDARY_TENANT_MODULES="files votes"\n' > "$d/state.env"
    run_with 'secondary_optin_load "$1"; for m in files votes messaging board; do secondary_host_module_allowed "$m" && printf "%s " "$m"; done' "$d/state.env"
    [ "$status" -eq 0 ]; [ "$output" = 'files votes board ' ] || { echo "[$output]"; return 1; }
}

@test "secondary_optin_load: a refused opt-in returns 1 with the opt-in empty and the reason in SECONDARY_OPTIN_WHY (no host, no value), and messaging reads its switches from state.env and both app files beside it" {
    local d="${BATS_TEST_TMPDIR}/optin"; mkdir -p "$d"
    printf 'SECONDARY_TENANT_HOSTS=canary.example.org\nSECONDARY_TENANT_MODULES=bogus\n' > "$d/state.env"
    run_with 'rc=0; secondary_optin_load "$1" || rc=$?; printf "%s|[%s]|%s" "$rc" "$SECONDARY_TENANT_MODULES" "$SECONDARY_OPTIN_WHY"' "$d/state.env"
    [ "$status" -eq 0 ]; [[ "$output" == "1|[]|entry 1"* &&"$output" != *"canary.example.org"* && "$output" != *"bogus"* ]] || { echo "$output"; return 1; }
    printf 'SECONDARY_TENANT_HOSTS=canary.example.org\nSECONDARY_TENANT_MODULES=messaging\n' > "$d/state.env"
    run_with 'secondary_optin_load "$1" || printf "%s" "$SECONDARY_OPTIN_WHY"' "$d/state.env"
    [[ "$output" == *"SYNAPSE_JWT_LOGIN"* && "$output" == *"MATRIX_IDENTITY"* ]] || { echo "$output"; return 1; }
    printf 'SYNAPSE_JWT_LOGIN=off\n' >> "$d/state.env"
    printf 'MATRIX_IDENTITY=namespaced\n' > "$d/app-blue.env"
    run_with 'secondary_optin_load "$1" || printf "%s" "$SECONDARY_OPTIN_WHY"' "$d/state.env"
    [[ "$output" == *"app-green.env"* && "$output" != *"app-blue.env"* ]] || { echo "$output"; return 1; }
    printf 'MATRIX_IDENTITY=namespaced\n' > "$d/app-green.env"
    run_with 'secondary_optin_load "$1"; secondary_host_module_allowed messaging && printf yes' "$d/state.env"
    [ "$status" -eq 0 ]; [ "$output" = yes ] || { echo "$output"; return 1; }
}

@test "secondary_host_modules_pinned_off: the key absent gives exactly SECONDARY_HOST_MODULES_OFF in its order; an opt-in removes the mapped manifest ids and nothing else (messaging removes messages)" {
    run_with 'secondary_host_modules_pinned_off | tr "\n" " "'
    [ "$status" -eq 0 ]; [ "$output" = 'content elections files messages newsletter vault votes ' ] || { echo "[$output]"; return 1; }
    SECONDARY_TENANT_MODULES='' run_with 'secondary_host_modules_pinned_off | tr "\n" " "'
    [ "$output" = 'content elections files messages newsletter vault votes ' ] || { echo "[$output]"; return 1; }
    SECONDARY_TENANT_MODULES='files' run_with 'secondary_host_modules_pinned_off | tr "\n" " "'
    [ "$output" = 'content elections messages newsletter vault votes ' ] || { echo "[$output]"; return 1; }
    SECONDARY_TENANT_MODULES='votes files' run_with 'secondary_host_modules_pinned_off | tr "\n" " "'
    [ "$output" = 'content elections messages newsletter vault ' ] || { echo "[$output]"; return 1; }
    SECONDARY_TENANT_MODULES='messaging' run_with 'secondary_host_modules_pinned_off | tr "\n" " "'
    [ "$output" = 'content elections files newsletter vault votes ' ] || { echo "[$output]"; return 1; }
}
