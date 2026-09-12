#!/usr/bin/env bash
# test/host/test_helper/host.bash — shims and fixtures for the infra/host bats suite.
#
# HOUSE RULE FOR THIS SUITE: a unit test NEVER touches a real docker, nft, ssh,
# dig, openssl-against-the-network or /opt/gremion. It puts a recording shim
# first on PATH, runs the program, and asserts on what the program TRIED to do.
# Anything that needs a real daemon or a real host lives in an integration
# script that is not collected by the bats unit run.

HOST_TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KERNEL_ROOT="$(cd "${HOST_TEST_DIR}/../.." && pwd)"
# HOST_SRC is overridable from the environment so a watch-the-guard-fail drill
# can point the whole suite at a deliberately mutilated copy of infra/host
# without ever editing the working tree.
: "${HOST_SRC:=${KERNEL_ROOT}/infra/host}"
export KERNEL_ROOT HOST_SRC

# setup_host_root — a throwaway $GREMION_ROOT carrying the section-A layout,
# plus an empty shim directory placed FIRST on PATH.
setup_host_root() {
    GREMION_ROOT="$(mktemp -d)"
    export GREMION_ROOT
    mkdir -p \
        "${GREMION_ROOT}/etc/env" \
        "${GREMION_ROOT}/etc/secrets" \
        "${GREMION_ROOT}/etc/edge" \
        "${GREMION_ROOT}/releases" \
        "${GREMION_ROOT}/bin" \
        "${GREMION_ROOT}/backups" \
        "${GREMION_ROOT}/runtime" \
        "${GREMION_ROOT}/logs"
    chmod 700 "${GREMION_ROOT}/etc"

    SHIM_DIR="${GREMION_ROOT}/.shims"
    SHIM_LOG="${SHIM_DIR}/calls.log"
    mkdir -p "$SHIM_DIR"
    : > "$SHIM_LOG"
    export SHIM_DIR SHIM_LOG
    PATH="${SHIM_DIR}:${PATH}"
    export PATH
}

teardown_host_root() {
    if [[ -n "${GREMION_ROOT:-}" && -d "${GREMION_ROOT:-}" ]]; then
        rm -rf "$GREMION_ROOT"
    fi
    return 0
}

# shim <cmd> [script]
# Installs a recording stub for <cmd> first on PATH. Every invocation appends
# "<cmd> <args...>" to $SHIM_LOG. With no <script> the stub exits 0; with a
# <script> the stub runs it INSTEAD of the implicit `exit 0`, so a stub is free
# to print output or exit non-zero.
#
# The stub is written to <path>.new, made executable, and only then moved into
# place. That order is what lets a test shim `chmod` itself: while <path>.new is
# still invisible to PATH lookup the `chmod +x` below resolves to the REAL
# chmod, so the stub never has to make itself executable.
shim() {
    local cmd="$1" body="${2:-}" path tmp
    if [[ -z "${SHIM_DIR:-}" ]]; then
        echo "shim: call setup_host_root first" >&2
        return 1
    fi
    path="${SHIM_DIR}/${cmd}"
    tmp="${path}.new"
    {
        echo '#!/usr/bin/env bash'
        # Deliberate: this format string is written into the shim script
        # verbatim; "$*" and "$SHIM_LOG" must stay literal here and expand
        # later, when the generated shim itself runs.
        # shellcheck disable=SC2016
        printf 'printf "%%s %%s\\n" %q "$*" >> "$SHIM_LOG"\n' "$cmd"
    } > "$tmp"
    if [[ -n "$body" ]]; then
        printf '%s\n' "$body" >> "$tmp"
    else
        echo 'exit 0' >> "$tmp"
    fi
    chmod +x "$tmp"
    mv -f "$tmp" "$path"
}

# assert_recorded <cmd> <substring>
assert_recorded() {
    local cmd="$1" needle="$2"
    if grep "^${cmd} " "$SHIM_LOG" 2>/dev/null | grep -qF -- "$needle"; then
        return 0
    fi
    echo "FAIL: no recorded '${cmd}' call containing: ${needle}" >&2
    echo "--- recorded calls (${SHIM_LOG}) ---" >&2
    cat "$SHIM_LOG" >&2 || true
    return 1
}

# refute_recorded <cmd> <substring>
refute_recorded() {
    local cmd="$1" needle="$2"
    if grep "^${cmd} " "$SHIM_LOG" 2>/dev/null | grep -qF -- "$needle"; then
        echo "FAIL: unexpected '${cmd}' call containing: ${needle}" >&2
        cat "$SHIM_LOG" >&2 || true
        return 1
    fi
    return 0
}

# assert_present <ere> <file> [why] / assert_absent <ere> <file> [why]
#
# Promoted here from deploy-workflow.bats, which derived them first and was the
# only file using them. Four other files had re-derived the broken shape they
# replace, so the helpers now live where every file can load them.
#
# WHY THESE EXIST rather than a bare `grep -q` / `! grep -q`:
#
#  1. `! cmd` switches `set -e` off for that command (POSIX: the -e setting is
#     ignored when the command is preceded by `!`). A negated grep anywhere but
#     the LAST line of a test body therefore fails silently and the guard stays
#     green. Measured: with `-o StrictHostKeyChecking=accept-new` substituted
#     into a scratch copy of deploy.yml, the host-key test still reported ok.
#  2. An unanchored positive grep is satisfied by the COMMENT that explains the
#     setting, so the guard survives the setting itself being changed. Same
#     drill, same test: `grep -q StrictHostKeyChecking=yes` matched the comment
#     above the ssh invocation.
#  3. `! grep -q PATTERN file` is vacuously true when the file is absent, which
#     is exactly the state these guards exist to catch first.
#
# Both helpers are ordinary commands, so a non-zero return trips bats' ERR
# trap; both refuse to answer at all when the file is missing; and both print
# the offending lines rather than only a status.
assert_present() {
    local re="$1" file="$2" why="${3:-pattern missing}"
    if [ ! -f "$file" ]; then
        echo "assert_present: no such file: ${file}" >&2
        return 1
    fi
    grep -qE -- "$re" "$file" && return 0
    echo "assert_present: ${why}: /${re}/ not found in ${file}" >&2
    return 1
}

assert_absent() {
    local re="$1" file="$2" why="${3:-pattern present}" hit
    if [ ! -f "$file" ]; then
        echo "assert_absent: no such file: ${file}" >&2
        return 1
    fi
    # Captured first, never piped into grep: under `set -o pipefail` a
    # `cmd | grep -q` can exit 141 on the passing path.
    hit="$(grep -nE -- "$re" "$file" || true)"
    [ -z "$hit" ] && return 0
    echo "assert_absent: ${why}: /${re}/ found in ${file}" >&2
    echo "$hit" >&2
    return 1
}

# scan_vacuous_negations <bats-file>...
# Prints "<file>:<line>: <statement>" for every `!`-negated statement whose
# failure bash would DISCARD, and prints nothing for a file that is clean. It
# always exits 0: it is a scanner, so the caller decides what an offender means
# and the canary test below can prove it still fires.
#
# THREE SHAPES ARE ACCEPTED, because in each of them the failure survives:
#   1. the statement is the LAST one in its body -- the body's exit status IS
#      the inverted status, which is what bats reports;
#   2. the statement is part of an AND-OR list (`! cmd || { …; return 1; }`) --
#      errexit applies to the list as a whole, so a short-circuit propagates;
#   3. anything that is not a `!`-negated statement at all.
# Everything else is an assertion that cannot fail, which is worse than no
# assertion: it reads as coverage.
#
# HONEST LIMITS. This is a line scanner, not a bash parser.
#   - It trusts this suite's house style that a body closes with `}` alone on
#     its line; it does not match braces, and a `}` inside a string would fool
#     it. It treats a function's closing brace as a body close too, which is
#     right for these files: a helper's last statement becomes the helper's
#     return value, and a bare call to it trips bats' ERR trap.
#   - For shape 2 it checks only that the list HAS a `||`/`&&` leg, not that
#     the leg actually fails the test. A leg that swallows the failure is a
#     defect this scanner cannot see.
#   - It only looks at `!` in the leading position of a statement line.
scan_vacuous_negations() {
    local f
    for f in "$@"; do
        awk -v FNAME="$f" '
            function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
            { raw[NR] = $0 }
            END {
              for (n = 1; n <= NR; n++) {
                t = trim(raw[n])
                if (t != "!" && substr(t, 1, 2) != "! " && substr(t, 1, 2) != "!\t") continue
                # Follow a continued statement to its real last line, so a
                # negation spanning a backslash or a pipe is judged whole.
                e = n
                while (e < NR) {
                  s = raw[e]; sub(/[ \t]+$/, "", s)
                  c = (length(s) > 0) ? substr(s, length(s), 1) : ""
                  if (c == "\\" || c == "|") { e++; continue }
                  if (length(s) > 1 && substr(s, length(s) - 1, 2) == "&&") { e++; continue }
                  break
                }
                andor = 0
                for (k = n; k <= e; k++) {
                  if (index(raw[k], "||") > 0 || index(raw[k], "&&") > 0) andor = 1
                }
                if (andor) continue
                # The next line that is neither blank nor a comment.
                nx = e + 1
                while (nx <= NR) {
                  s = trim(raw[nx])
                  if (s == "" || substr(s, 1, 1) == "#") { nx++; continue }
                  break
                }
                if (nx <= NR && trim(raw[nx]) == "}") continue
                printf "%s:%d: %s\n", FNAME, n, t
              }
            }
        ' "$f"
    done
    return 0
}

# fs_carries_modes <dir>
# 0 when the filesystem under <dir> actually stores POSIX permission bits.
# Git Bash on NTFS does NOT: `chmod 600` there reads back as 644, so a mode
# assertion is meaningless on this box and is proven on the Debian host instead.
#
# Callers use it as `if ! fs_carries_modes "$d"; then skip …; fi`, so a chmod
# that FAILED must not come back as "no modes": that would turn a real mode
# assertion into a permanent skip nobody reads. An inconclusive probe exits the
# test body non-zero, which bats reports as a FAILURE, not a skip.
fs_carries_modes() {
    local dir="$1" probe rc=1
    probe="${dir}/.mode-probe.$$"
    : > "$probe" 2>/dev/null || return 1
    if ! chmod 600 "$probe" 2>/dev/null; then
        rm -f "$probe"
        printf 'FAIL: fs_carries_modes: chmod 600 failed on %s — the mode probe is inconclusive, not negative\n' \
            "$probe" >&2
        exit 1
    fi
    [[ "$(stat -c '%a' "$probe" 2>/dev/null)" == "600" ]] && rc=0
    rm -f "$probe"
    return "$rc"
}
