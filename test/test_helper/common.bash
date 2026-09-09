#!/usr/bin/env bash
# Common test helpers shared across all BATS test files.

# Project root (one level up from test/)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURES_DIR="${PROJECT_ROOT}/test/fixtures"
SCRIPTS_DIR="${PROJECT_ROOT}/scripts"

# Create a temp directory for each test and clean it up on teardown.
setup_temp_dir() {
    TEST_TEMP_DIR="$(mktemp -d)"
    export TEST_TEMP_DIR
}

teardown_temp_dir() {
    if [[ -n "${TEST_TEMP_DIR:-}" && -d "$TEST_TEMP_DIR" ]]; then
        rm -rf "$TEST_TEMP_DIR"
    fi
}

# Copy .env.example to a temp dir for testing without touching the real .env.
copy_env_example() {
    local dest="${1:-$TEST_TEMP_DIR}"
    cp "${PROJECT_ROOT}/.env.example" "${dest}/.env.example"
}

# Count occurrences of a pattern in a file.
count_matches() {
    grep -c "$1" "$2" 2>/dev/null || echo 0
}

# Assert a file contains a pattern.
assert_file_contains() {
    local file="$1"
    local pattern="$2"
    if ! grep -q "$pattern" "$file"; then
        echo "FAIL: '$file' does not contain pattern: $pattern" >&2
        return 1
    fi
}

# Assert a file does NOT contain a pattern.
assert_file_not_contains() {
    local file="$1"
    local pattern="$2"
    if grep -q "$pattern" "$file"; then
        echo "FAIL: '$file' unexpectedly contains pattern: $pattern" >&2
        return 1
    fi
}
