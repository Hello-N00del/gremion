#!/usr/bin/env bats
# Tests for scripts/backup.sh
# Run: ./test/bats/bin/bats test/backup.bats

load 'test_helper/common'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
BACKUP_SCRIPT="${PROJECT_ROOT}/scripts/backup.sh"

setup() {
    setup_temp_dir
}

teardown() {
    teardown_temp_dir
}

# ---------------------------------------------------------------------------
# Script structure
# ---------------------------------------------------------------------------

@test "backup.sh exists" {
    [[ -f "$BACKUP_SCRIPT" ]]
}

@test "backup.sh is executable" {
    [[ -x "$BACKUP_SCRIPT" ]]
}

@test "backup.sh has strict mode set" {
    grep -q "set -euo pipefail" "$BACKUP_SCRIPT"
}

# ---------------------------------------------------------------------------
# Backup logic validation (static analysis of script content)
# ---------------------------------------------------------------------------

@test "backup.sh does not reference the carved-out nextcloud database" {
    # nextcloud was carved out with its service; init-databases.sh no longer
    # provisions a nextcloud DB, so dumping it would fail at runtime.
    assert_file_not_contains "$BACKUP_SCRIPT" "nextcloud"
}

@test "backup.sh backs up keycloak database" {
    grep -q "keycloak" "$BACKUP_SCRIPT"
}

@test "backup.sh backs up gremion database" {
    grep -q "gremion" "$BACKUP_SCRIPT"
}

@test "backup.sh uses gzip compression" {
    grep -q "gzip\|\.gz" "$BACKUP_SCRIPT"
}

@test "backup.sh creates timestamped filenames" {
    grep -qE 'date|timestamp' "$BACKUP_SCRIPT"
}

@test "backup.sh references BACKUP_DIR or backup directory" {
    grep -qiE "BACKUP_DIR|backup_dir|backups" "$BACKUP_SCRIPT"
}

@test "backup.sh does not hardcode passwords" {
    # Passwords should come from env vars, not literals
    ! grep -qE "password=['\"][^'\"]" "$BACKUP_SCRIPT"
}

@test "backup.sh has retention/cleanup logic" {
    grep -qE "find.*-mtime|find.*-delete|rm.*backup|retention|RETENTION" "$BACKUP_SCRIPT"
}

# ---------------------------------------------------------------------------
# Environment variable requirements
# ---------------------------------------------------------------------------

@test "backup.sh references POSTGRES_USER" {
    grep -q "POSTGRES_USER" "$BACKUP_SCRIPT"
}

@test "backup.sh dumps the gremion database via POSTGRES_USER" {
    grep -qE "dump_postgres gremion" "$BACKUP_SCRIPT"
    grep -q "POSTGRES_USER" "$BACKUP_SCRIPT"
}

@test "backup.sh does not dump the carved-out helios database" {
    # helios (e-voting) was carved out with its service; it is no longer created
    # by init-databases.sh, so a dump would fail.
    assert_file_not_contains "$BACKUP_SCRIPT" "helios"
}

@test "backup.sh dumps the control registry database (#234)" {
    grep -qE "dump_postgres control" "$BACKUP_SCRIPT"
}

@test "backup.sh dumps every database created by init-databases.sh (#234)" {
    # Regression guard: each application DB created in
    # docker/postgres/init-databases.sh must have a matching dump_postgres line,
    # so a newly added database cannot silently inherit the old backup blind spot.
    local init="${PROJECT_ROOT}/docker/postgres/init-databases.sh"
    [[ -f "$init" ]]
    # Extract the default name from each "${X_DB_NAME:-name}" create_db_and_user arg.
    local dbs
    dbs=$(grep -oE '\$\{[A-Z_]*DB_NAME:-[a-z_]+\}' "$init" | sed -E 's/.*:-([a-z_]+)\}/\1/' | sort -u)
    [[ -n "$dbs" ]]
    local db
    for db in $dbs; do
        grep -qE "dump_postgres ${db}\b" "$BACKUP_SCRIPT" \
            || { echo "missing dump_postgres for database: ${db}"; return 1; }
    done
}

# ---------------------------------------------------------------------------
# Carve parity — carved-out services must not linger + K8s parity
# ---------------------------------------------------------------------------

@test "backup.sh does not dump the carved-out newsletter database" {
    # newsletter ran its own newsletter-postgres service, which was carved out;
    # that service no longer exists, so a dump against it would fail.
    assert_file_not_contains "$BACKUP_SCRIPT" "newsletter"
}

@test "k8s backup cronjob dumps keycloak, gremion and control (#310)" {
    # Governance kernel provisions keycloak + gremion + control (helios and
    # newsletter were carved out with their services).
    local cj="${PROJECT_ROOT}/k8s/base/backup/cronjob.yaml"
    [[ -f "$cj" ]]
    grep -qE "for db in .*\bkeycloak\b" "$cj"
    grep -qE "for db in .*\bgremion\b" "$cj"
    grep -qE "for db in .*\bcontrol\b" "$cj"
}

@test "k8s postgres configmap creates every database docker init creates (#310)" {
    # Parity guard: the K8s configmap and docker/postgres/init-databases.sh must
    # provision the SAME application databases, so a DB added to one is never
    # silently missing from the other (the #310 helios-gap class).
    local init="${PROJECT_ROOT}/docker/postgres/init-databases.sh"
    local cm="${PROJECT_ROOT}/k8s/base/postgres/configmap.yaml"
    [[ -f "$init" && -f "$cm" ]]
    local dbs
    dbs=$(grep -oE '\$\{[A-Z_]*DB_NAME:-[a-z_]+\}' "$init" | sed -E 's/.*:-([a-z_]+)\}/\1/' | sort -u)
    [[ -n "$dbs" ]]
    local db
    for db in $dbs; do
        grep -qF "DB_NAME:-${db}}" "$cm" \
            || { echo "K8s configmap missing create for database: ${db}"; return 1; }
    done
}

# ---------------------------------------------------------------------------
# Carve parity — restore side must mirror the backup side
# ---------------------------------------------------------------------------

@test "restore.sh has no carved-out newsletter case arm" {
    # The newsletter service was carved out; the restore arm that targeted its
    # dedicated newsletter-postgres instance must be gone too.
    local restore="${PROJECT_ROOT}/scripts/restore.sh"
    [[ -f "$restore" ]]
    assert_file_not_contains "$restore" "newsletter"
}

@test "restore.sh usage does not advertise the carved-out newsletter target" {
    local restore="${PROJECT_ROOT}/scripts/restore.sh"
    ! grep -qE 'Usage:.*newsletter' "$restore"
}
