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

# How many trailing lines of a failed command's output assert reproduces. Enough
# for a compose or openssl error, short enough that the FAIL line stays readable.
GREMION_ASSERT_TAIL_LINES=40

# assert <description> <command...>
# <description> names the POST-CONDITION being observed, not the action taken.
# "apt-get install returned 0" is not an assertion; "git is on PATH" is.
#
# The command's stdout AND stderr are captured and, when the post-condition does
# NOT hold, reproduced (prefixed, last $GREMION_ASSERT_TAIL_LINES lines) before
# the exit. A guard that reports only "X does not hold" and discards the reason
# costs a second trip to the host to find out why. On success the output is
# dropped: a passing assertion prints one line.
assert() {
    local what="$1"; shift
    local cap rc=0
    cap="$(mktemp)" || die "assert: could not create a temp file for command output" \
        "$GREMION_EXIT_ASSERT"
    if "$@" >"$cap" 2>&1; then
        rm -f "$cap"
        ok "$what"
    else
        rc=$?
        if [[ -s "$cap" ]]; then
            printf '       ---- output of: %s (exit %d, last %d lines) ----\n' \
                "$*" "$rc" "$GREMION_ASSERT_TAIL_LINES" >&2
            tail -n "$GREMION_ASSERT_TAIL_LINES" "$cap" | sed 's/^/       | /' >&2
        fi
        rm -f "$cap"
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

# -- the signed release-1 waiver ledger (spec B S1.4/SG) - ONE parser --------
#
# The row shape of docs/ops/release-1-waivers.md is a machine contract: it is
# read at run time by infra/host/bin/gremion-verify and pinned by
# test/host/release-1-waivers.bats. It lives HERE, in the library both of them
# load, because two copies of a pattern drift in one direction only - the guard
# gets looser than the reader, and then a row the reader silently dropped is
# still counted green by the guard.
#
# Measured before this was shared: one markdown-legal escaped pipe inside a
# cell cost gremion-verify the `apex-dns` waiver - five printed where six were
# declared, `waivers[]` of length 5, exit 0 - while every suite stayed green.
# Under-reporting a waiver is precisely the "deployed read as gated" misreading
# the ledger exists to prevent.
#
# Row shape:
#   | `<id>` | SL:<n> | <GATE-ID> | <what is waived> | <why> | <lifted by> |
# (S is the section sign in the file itself; it is spelled out here because
# this comment is also read on terminals that mangle it.)

# A line that LOOKS like a waiver row: the id cell and the section-L cell,
# nothing more. It is deliberately looser than waiver_rows() below, because it
# is the floor the parse is measured against - a row that looks like a waiver
# and does not parse is a DROPPED waiver, not an absent one.
# NOTE the unescaped pipes: this is a BRE, and GNU grep reads `\|` there as
# ALTERNATION, not as a literal bar. Written the other way `^\|` matches every
# line in the file, the candidate count comes back 62, and the post-condition
# below turns into a permanent false alarm. Measured.
# shellcheck disable=SC2016  # the backticks are the ledger's own literal
# markdown code fences, not a command substitution.
WAIVER_ROW_CANDIDATE='^| `[a-z0-9-]\{1,\}` | §L:'

# waiver_candidate_count <ledger> -> how many lines look like a waiver row.
waiver_candidate_count() {
    grep -c "$WAIVER_ROW_CANDIDATE" "$1" 2>/dev/null || true
}

# waiver_rows <ledger> -> one `id|litem|gate|why` record per PARSED row.
# The caller compares its count with waiver_candidate_count and refuses to
# continue when they disagree; this function never decides that on its own.
# shellcheck disable=SC2016  # the sed script is deliberately literal: its
# backreferences are sed's, not the shell's, and must not expand here.
waiver_rows() {
    sed -n 's/^| `\([a-z0-9-]\{1,\}\)` | §L:\([0-9]\{1,\}\) | \(G[0-9]-[A-Z]\{1,\}\) | \([^|]*\) |.*/\1|\2|\3|\4/p' \
        "$1"
}

# fs_carries_modes <dir>
# 0 when the filesystem under <dir> really stores POSIX permission bits.
# Git Bash on NTFS does not, so a 0600 assertion there would be a lie; the mode
# post-condition is asserted on Debian and skipped (loudly) elsewhere.
#
# The probe answers exactly one question: does this filesystem PERSIST a mode it
# was given? A chmod that failed answers nothing, so it is fatal here rather
# than folded into "no modes". Read the other way it would silently disable
# every 0600/0700 post-condition on a host that does carry modes — the guard
# still installed, still green, enforcing nothing. Only a chmod that SUCCEEDS
# and does not stick returns 1.
fs_carries_modes() {
    local dir="$1" probe rc=1
    probe="${dir}/.mode-probe.$$"
    : > "$probe" 2>/dev/null || return 1
    if ! chmod 600 "$probe" 2>/dev/null; then
        rm -f "$probe"
        die "fs_carries_modes: chmod 600 failed on ${probe} — the mode probe is inconclusive, not negative" \
            "$GREMION_EXIT_ASSERT"
    fi
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
    # Every step is checked by hand. Callers run this as the tail of a
    # pipeline, usually inside `if ! ... | atomic_write`, and bash ignores
    # errexit in that context: a `cat` whose redirection fails (a directory
    # at <path>.tmp, a full disk) would otherwise fall through to chmod and
    # mv, rename whatever sits at <path>.tmp into place and return 0. The
    # caller would then report a written file that is not there.
    #
    # A symlink left at <path>.tmp would send the write through it and then
    # install the link itself; it is removed first. `mv -T` refuses to move
    # the file INTO a directory that occupies <path> (plain `mv -f` would,
    # and return 0). Nothing here removes a directory it did not create.
    if [[ -L "$tmp" ]] && ! rm -f -- "$tmp"; then
        return 1
    fi
    if ! cat > "$tmp"; then
        if [[ -f "$tmp" ]]; then rm -f -- "$tmp"; fi
        return 1
    fi
    if ! chmod "$mode" "$tmp"; then
        rm -f -- "$tmp"
        return 1
    fi
    if ! mv -f -T "$tmp" "$path"; then
        rm -f -- "$tmp"
        return 1
    fi
}

# Where the env templates live. In a source tree or release checkout that is
# <lib>/../templates/env. The INSTALLED layout (bootstrap puts only bin/ and
# lib/ under /opt/gremion) has none there, so the active release's copy under
# <root>/current is tried next. GREMION_ENV_TEMPLATE_DIR overrides both, and is
# then the ONLY place looked in.
GREMION_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

env_template_dirs() {
    if [[ -n "${GREMION_ENV_TEMPLATE_DIR:-}" ]]; then
        printf '%s\n' "$GREMION_ENV_TEMPLATE_DIR"
        return 0
    fi
    printf '%s\n' "${GREMION_LIB_DIR}/../templates/env" \
        "$(gremion_root)/current/infra/host/templates/env"
}

# env_template_name <env-file> -> the template file name a host env file is
# rendered from, or nothing for a file that is not one of the five.
env_template_name() {
    case "$(basename "$1")" in
        state.env)                  printf '%s\n' state.env.tmpl ;;
        app-blue.env|app-green.env) printf '%s\n' app.env.tmpl ;;
        mail.env)                   printf '%s\n' mail.env.tmpl ;;
        ops.env)                    printf '%s\n' ops.env.tmpl ;;
        *) ;;
    esac
}

# env_template_for <env-file> -> the first existing template for it along
# env_template_dirs, or nothing (not one of the five, or no template reachable).
env_template_for() {
    local name dir
    name="$(env_template_name "$1")"
    [[ -n "$name" ]] || return 0
    while IFS= read -r dir; do
        if [[ -f "${dir}/${name}" ]]; then
            printf '%s\n' "${dir}/${name}"
            return 0
        fi
    done < <(env_template_dirs)
}

# secret_marked_keys <template> -> every key whose template value carries a
# generated sentinel (CHANGE_ME_GEN_), whole or embedded (a URL's password).
secret_marked_keys() {
    grep -E '^[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME_GEN_' "$1" | sed 's/=.*//' || true
}

# load_env <file> [<template>]
# THE single env reader under infra/host/ (spec B section 6, TRD-039; a guard in
# test/host/validate-env.bats fails on a second one). Exports every KEY=VALUE.
# Refuses, with exit 2:
#   - a missing file
#   - any line that is not a comment, blank, or KEY=VALUE. The line itself is
#     never echoed, only its number: a malformed line may hold a secret.
#   - ANY duplicate key. StuRaOS #476: validate-env.sh read the FIRST occurrence
#     (head -n1) while compose takes the LAST, so the validator and the
#     container disagreed about which value was live. Here a duplicate is never
#     resolved, it is refused.
#   - any value beginning CHANGE_ME_ , unless ALLOW_SENTINELS=1. That is the
#     one gate that makes the two-shape sentinel scheme of section G real:
#     an env file the operator has not finished filling in cannot be loaded.
#   - an EMPTY value for a key the template marks secret (its template value
#     carries CHANGE_ME_GEN_). ALLOW_SENTINELS does not waive this: an empty
#     secret is not an unfinished file, it is a broken one. The template is
#     <template> when given -- then it MUST exist -- else the one the file name
#     maps to (state.env, app-blue.env, app-green.env, mail.env, ops.env),
#     looked up along env_template_dirs; with GREMION_ENV_TEMPLATE_DIR set it
#     must exist there too.
#     ONE deliberate exception: an installed program (no templates beside
#     lib/) with no release under <root>/current cannot find the template at
#     all. Refusing there would stop gremion-verify and gremion-backup on the
#     host itself, so load_env says LOUDLY on stderr that this one check did
#     not run, and runs every other refusal. gremion-validate-env, the gate an
#     operator runs before `up`, never takes this exception.
load_env() {
    local file="${1:-}" tmpl="${2:-}"
    [[ -n "$file" ]] || die "load_env: usage: load_env <file> [<template>]" "$GREMION_EXIT_USAGE"
    [[ -f "$file" ]] || die "load_env: no such env file: ${file}" "$GREMION_EXIT_USAGE"

    if [[ -z "$tmpl" && -n "$(env_template_name "$file")" ]]; then
        tmpl="$(env_template_for "$file")"
        if [[ -z "$tmpl" ]]; then
            if [[ -n "${GREMION_ENV_TEMPLATE_DIR:-}" ]]; then
                die "load_env: ${file}: no $(env_template_name "$file") template in GREMION_ENV_TEMPLATE_DIR=${GREMION_ENV_TEMPLATE_DIR}; cannot tell which keys are secret" \
                    "$GREMION_EXIT_USAGE"
            fi
            printf '%s  WARN%s load_env: %s: no %s reachable (not beside lib/, not under %s/current); the empty-secret check did NOT run -- run gremion-validate-env from a release tree\n' \
                "$C_BAD" "$C_OFF" "$file" "$(env_template_name "$file")" "$(gremion_root)" >&2
        fi
    fi
    local -A secret_key=()
    if [[ -n "$tmpl" ]]; then
        [[ -f "$tmpl" ]] \
            || die "load_env: ${file}: its template ${tmpl} is missing; cannot tell which keys are secret" \
                "$GREMION_EXIT_USAGE"
        local k
        while IFS= read -r k; do
            [[ -n "$k" ]] && secret_key["$k"]=1
        done < <(secret_marked_keys "$tmpl")
    fi

    local dupes
    dupes="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$file" \
             | sed 's/=.*//' | sort | uniq -d || true)"
    if [[ -n "$dupes" ]]; then
        bad "load_env: ${file}: duplicate key(s):"
        # shellcheck disable=SC2086
        printf '    %s\n' $dupes >&2
        exit "$GREMION_EXIT_USAGE"
    fi

    # Read the waiver ONCE, before the file can say anything: a file line
    # `ALLOW_SENTINELS=1` would otherwise be exported mid-loop and waive the
    # refusal for every line after it.
    local allow_sentinels="${ALLOW_SENTINELS:-0}"
    local line key value n=0
    while IFS= read -r line || [[ -n "$line" ]]; do
        n=$((n + 1))
        line="${line%$'\r'}"
        [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
        if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
            bad "load_env: ${file}: line ${n} is not KEY=VALUE (content not shown)"
            exit "$GREMION_EXIT_USAGE"
        fi
        key="${line%%=*}"
        value="${line#*=}"
        # Keys that steer this loader, the shell, the dynamic linker or this
        # library's own state (exit codes, colours) are not configuration:
        # exported, they would change how every later line -- and the verdict
        # of the program that loaded the file -- is judged.
        case "$key" in
            ALLOW_SENTINELS|GREMION_ENV_TEMPLATE_DIR|PATH|IFS|ENV|BASH_ENV|BASH_*|SHELLOPTS|BASHOPTS|PS4|LD_*|\
            GREMION_EXIT_*|GREMION_LIB_DIR|GREMION_ASSERT_TAIL_LINES|WAIVER_ROW_CANDIDATE|C_OK|C_BAD|C_DIM|C_OFF)
                bad "load_env: ${file}: line ${n} sets ${key}, which an env file may not set"
                exit "$GREMION_EXIT_USAGE"
                ;;
        esac
        # strip one layer of matching quotes, the way compose --env-file does
        if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
            value="${value:1:${#value}-2}"
        fi
        if [[ -z "${value//[[:space:]]/}" && -n "${secret_key[$key]:-}" ]]; then
            bad "load_env: ${file}: ${key} is empty, but its template marks it a generated secret"
            exit "$GREMION_EXIT_USAGE"
        fi
        if [[ "$value" == CHANGE_ME_* && "$allow_sentinels" != "1" ]]; then
            bad "load_env: ${file}: ${key} still holds the sentinel ${value}"
            exit "$GREMION_EXIT_USAGE"
        fi
        export "${key}=${value}"
    done < "$file"
}

# state_kc_cid <stack> -> the id of the ONE running Keycloak container of the
# <stack>-state compose project (TASK-015, Q12). Found by its compose labels,
# never by a name: only the mail project sets container_name, so the real name
# is <stack>-state-keycloak-1 and every `docker inspect <stack>-state-keycloak`
# answered "no such object". Its kcadm serves under the /auth relative path
# (docker-compose.yml KC_HTTP_RELATIVE_PATH), so callers use
# --server http://127.0.0.1:8080/auth. Returns 1 with no output when none, or
# more than one, is running; 2 when docker itself could not be asked.
# Used by gremion-mail-bringup, gremion-neuter and gremion-vendor-mail.
state_kc_cid() {
    # Not named `stack`: every program that sources this library reads the
    # env's STACK, and shellcheck (SC2153) reads a lowercase twin as a typo.
    local kc_stack="$1" ids n
    ids="$(docker ps -q --filter "label=com.docker.compose.project=${kc_stack}-state" \
                        --filter "label=com.docker.compose.service=keycloak")" || return 2
    n="$(printf '%s\n' "$ids" | sed '/^[[:space:]]*$/d' | wc -l)"
    [[ "$n" -eq 1 ]] || return 1
    printf '%s\n' "${ids//[[:space:]]/}"
}

# executor_unit_action <restart|try-restart> � (re)start gremion-executor.service
# where a release becomes usable. A host without the unit (a scratch tree, a
# test) is a skip; a systemctl failure is a warning, never a failed deploy/init.
executor_unit_action() {
    local action="${1:?restart|try-restart}" unit=/etc/systemd/system/gremion-executor.service
    command -v systemctl >/dev/null 2>&1 && [[ -f "$unit" ]] || return 0
    local -a sc=(systemctl)
    [[ "${EUID:-$(id -u)}" -eq 0 ]] || sc=(sudo -n systemctl)
    "${sc[@]}" "$action" gremion-executor.service         || printf 'WARNING: systemctl %s gremion-executor.service failed; start it by hand
' "$action" >&2
    return 0
}
