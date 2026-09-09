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
shim() {
    local cmd="$1" body="${2:-}" path
    if [[ -z "${SHIM_DIR:-}" ]]; then
        echo "shim: call setup_host_root first" >&2
        return 1
    fi
    path="${SHIM_DIR}/${cmd}"
    {
        echo '#!/usr/bin/env bash'
        # Deliberate: this format string is written into the shim script
        # verbatim; "$*" and "$SHIM_LOG" must stay literal here and expand
        # later, when the generated shim itself runs.
        # shellcheck disable=SC2016
        printf 'printf "%%s %%s\\n" %q "$*" >> "$SHIM_LOG"\n' "$cmd"
    } > "$path"
    if [[ -n "$body" ]]; then
        printf '%s\n' "$body" >> "$path"
    else
        echo 'exit 0' >> "$path"
    fi
    chmod +x "$path"
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

# fs_carries_modes <dir>
# 0 when the filesystem under <dir> actually stores POSIX permission bits.
# Git Bash on NTFS does NOT: `chmod 600` there reads back as 644, so a mode
# assertion is meaningless on this box and is proven on the Debian host instead.
fs_carries_modes() {
    local dir="$1" probe rc=1
    probe="${dir}/.mode-probe.$$"
    : > "$probe" 2>/dev/null || return 1
    chmod 600 "$probe" 2>/dev/null || true
    [[ "$(stat -c '%a' "$probe" 2>/dev/null)" == "600" ]] && rc=0
    rm -f "$probe"
    return "$rc"
}
