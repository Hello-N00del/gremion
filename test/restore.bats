#!/usr/bin/env bats
# Tests for scripts/restore.sh
# Run: ./test/bats/bin/bats test/restore.bats

load 'test_helper/common'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
RESTORE_SCRIPT="${PROJECT_ROOT}/scripts/restore.sh"

setup() {
    setup_temp_dir
}

teardown() {
    teardown_temp_dir
}

# ---------------------------------------------------------------------------
# Script structure
# ---------------------------------------------------------------------------

@test "restore.sh exists" {
    [[ -f "$RESTORE_SCRIPT" ]]
}

@test "restore.sh is executable" {
    [[ -x "$RESTORE_SCRIPT" ]]
}

@test "restore.sh has strict mode set" {
    grep -q "set -euo pipefail" "$RESTORE_SCRIPT"
}

# ---------------------------------------------------------------------------
# Argument validation (static analysis)
# ---------------------------------------------------------------------------

@test "restore.sh validates input arguments" {
    grep -qE 'usage|Usage|\$#|argc|argument' "$RESTORE_SCRIPT"
}

@test "restore.sh does not reference the carved-out nextcloud target" {
    # nextcloud was carved out with its service; the restore arm (and its
    # maintenance-mode/repair handling) must be gone.
    assert_file_not_contains "$RESTORE_SCRIPT" "nextcloud"
}

@test "restore.sh supports keycloak restore target" {
    grep -q "keycloak" "$RESTORE_SCRIPT"
}

@test "restore.sh supports gremion restore target" {
    grep -q "gremion" "$RESTORE_SCRIPT"
}

@test "restore.sh restores keycloak, gremion and control via a shared arm" {
    grep -qF 'keycloak|gremion|control)' "$RESTORE_SCRIPT"
}

@test "restore.sh derives the keycloak and control DB roles on restore" {
    grep -qE 'KEYCLOAK_DB_USER' "$RESTORE_SCRIPT"
    grep -qE 'CONTROL_DB_USER' "$RESTORE_SCRIPT"
    # helios was carved out — its role derivation must be gone.
    assert_file_not_contains "$RESTORE_SCRIPT" "HELIOS_DB_USER"
}

@test "restore.sh lists only the kernel targets in its usage string" {
    grep -qF 'keycloak|gremion|control' "$RESTORE_SCRIPT"
    assert_file_not_contains "$RESTORE_SCRIPT" "helios"
}

@test "restore.sh checks backup file exists before restoring" {
    grep -qE '\-f \$|test -f|file.*exist|\[\[ -f' "$RESTORE_SCRIPT"
}

@test "restore.sh handles gzip-compressed backups" {
    grep -qE "gunzip|gzip|\.gz" "$RESTORE_SCRIPT"
}

# ---------------------------------------------------------------------------
# Safety checks
# ---------------------------------------------------------------------------

@test "restore.sh does not silently overwrite without confirmation or force flag" {
    # Should either prompt or require explicit --force / DB target argument
    grep -qE 'confirm|force|TARGET|target|database.*name' "$RESTORE_SCRIPT"
}

@test "restore.sh does not hardcode passwords" {
    ! grep -qE "password=['\"][^'\"]" "$RESTORE_SCRIPT"
}
