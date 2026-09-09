#!/usr/bin/env bash
# infra/host/lib/common.sh — shared primitives for every gremion-* host program.
#
# SOURCED, NEVER EXECUTED. It deliberately does NOT `set -euo pipefail`: shell
# options belong to the program, not to its library, and a library that flips
# them changes the behaviour of whatever sourced it. Every program under
# infra/host/bin/ sets strict mode itself, on its own second line, and
# test/host/common.bats asserts that.
#
# Sourcing convention (identical in every program):
#     SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     # shellcheck source=../lib/common.sh
#     . "$SCRIPT_DIR/../lib/common.sh"
# On the host that resolves to /opt/gremion/lib/common.sh, so bootstrap installs
# bin/ and lib/ as REAL FILES side by side — never symlinks, because
# ${BASH_SOURCE[0]} is the invoked path and a symlinked bin/ would resolve
# ../lib to a directory that does not exist.
#
# EXIT CODES (the whole gremion-* family):
#   0 success
#   1 an assertion or post-condition failed
#   2 usage, or a missing precondition (file, env key, tool)
#   3 blocked on an external step; the message begins "BLOCKED: "

GREMION_EXIT_OK=0
GREMION_EXIT_ASSERT=1
GREMION_EXIT_USAGE=2
GREMION_EXIT_BLOCKED=3
export GREMION_EXIT_OK GREMION_EXIT_ASSERT GREMION_EXIT_USAGE GREMION_EXIT_BLOCKED

if [[ -t 2 ]]; then
    C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
    C_OK=''; C_BAD=''; C_DIM=''; C_OFF=''
fi

info() { printf '%s[gremion]%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
ok()   { printf '%s  OK%s   %s\n'   "$C_OK"  "$C_OFF" "$*"; }
bad()  { printf '%s  FAIL%s %s\n'   "$C_BAD" "$C_OFF" "$*" >&2; }

# die <msg> [code]
die() {
    bad "$1"
    exit "${2:-$GREMION_EXIT_ASSERT}"
}

# assert <description> <command...>
# <description> names the POST-CONDITION being observed, not the action taken.
# "apt-get install returned 0" is not an assertion; "git is on PATH" is.
assert() {
    local what="$1"; shift
    if "$@" >/dev/null 2>&1; then
        ok "$what"
    else
        die "$what" "$GREMION_EXIT_ASSERT"
    fi
}

require_root() {
    [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must run as root (or via sudo)" "$GREMION_EXIT_USAGE"
}

# need_cmd <name...> — names EVERY missing command, not just the first.
need_cmd() {
    local c missing=()
    for c in "$@"; do
        command -v "$c" >/dev/null 2>&1 || missing+=("$c")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        die "missing required command(s): ${missing[*]}" "$GREMION_EXIT_USAGE"
    fi
}

gremion_root() {
    printf '%s\n' "${GREMION_ROOT:-/opt/gremion}"
}

# fs_carries_modes <dir>
# 0 when the filesystem under <dir> really stores POSIX permission bits.
# Git Bash on NTFS does not, so a 0600 assertion there would be a lie; the mode
# post-condition is asserted on Debian and skipped (loudly) elsewhere.
fs_carries_modes() {
    local dir="$1" probe rc=1
    probe="${dir}/.mode-probe.$$"
    : > "$probe" 2>/dev/null || return 1
    chmod 600 "$probe" 2>/dev/null || true
    [[ "$(stat -c '%a' "$probe" 2>/dev/null)" == "600" ]] && rc=0
    rm -f "$probe"
    return "$rc"
}

# atomic_write <path> <mode>
# Body on stdin. Writes <path>.tmp, chmods it, then renames it over <path>.
# The rename is atomic within one filesystem, so no reader — Traefik's file
# watcher above all — ever observes a half-written file.
atomic_write() {
    local path="${1:-}" mode="${2:-}" dir tmp
    [[ -n "$path" && -n "$mode" ]] \
        || die "atomic_write: usage: atomic_write <path> <mode>" "$GREMION_EXIT_USAGE"
    dir="$(dirname "$path")"
    [[ -d "$dir" ]] \
        || die "atomic_write: directory does not exist: ${dir}" "$GREMION_EXIT_USAGE"
    tmp="${path}.tmp"
    cat > "$tmp"
    chmod "$mode" "$tmp"
    mv -f "$tmp" "$path"
}

# load_env <file>
# Exports every KEY=VALUE. Refuses, with exit 2:
#   - a missing file
#   - any line that is not a comment, blank, or KEY=VALUE
#   - ANY duplicate key. StuRaOS #476: validate-env silently read the LAST
#     occurrence, so a stale duplicate above a corrected value won. Here a
#     duplicate is never resolved, it is refused.
#   - any value beginning CHANGE_ME_ , unless ALLOW_SENTINELS=1. That is the
#     one gate that makes the two-shape sentinel scheme of section G real:
#     an env file the operator has not finished filling in cannot be loaded.
load_env() {
    local file="${1:-}"
    [[ -n "$file" ]] || die "load_env: usage: load_env <file>" "$GREMION_EXIT_USAGE"
    [[ -f "$file" ]] || die "load_env: no such env file: ${file}" "$GREMION_EXIT_USAGE"

    local dupes
    dupes="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$file" \
             | sed 's/=.*//' | sort | uniq -d || true)"
    if [[ -n "$dupes" ]]; then
        bad "load_env: ${file}: duplicate key(s):"
        # shellcheck disable=SC2086
        printf '    %s\n' $dupes >&2
        exit "$GREMION_EXIT_USAGE"
    fi

    local line key value
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
        if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
            bad "load_env: ${file}: not KEY=VALUE: ${line}"
            exit "$GREMION_EXIT_USAGE"
        fi
        key="${line%%=*}"
        value="${line#*=}"
        # strip one layer of matching quotes, the way compose --env-file does
        if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
            value="${value:1:${#value}-2}"
        fi
        if [[ "$value" == CHANGE_ME_* && "${ALLOW_SENTINELS:-0}" != "1" ]]; then
            bad "load_env: ${file}: ${key} still holds the sentinel ${value}"
            exit "$GREMION_EXIT_USAGE"
        fi
        export "${key}=${value}"
    done < "$file"
}
