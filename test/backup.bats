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

# ---------------------------------------------------------------------------
# tenant-backup.sh: every tenant is equal (TASK-042, TRD-042 [D R15-2])
# ---------------------------------------------------------------------------

# Run scripts/tenant-backup.sh <slug> with psql/docker/openssl stubbed on PATH.
# psql answers one registry row; docker records its argv; openssl passes stdin
# through. KEYCLOAK_ADMIN is left unset, so the run stops right after the DB
# dump (the realm export needs a live Keycloak) -- the dump call is what we
# assert on. The script cds to its repo root and loads that root's .env, which
# would override the stubbed POSTGRES_USER/KEYCLOAK_ADMIN on any checkout that
# has one; it therefore runs from a copy in an empty temp "repo" with no .env.
run_tenant_backup_stubbed() {
    local slug="$1" bin="${TEST_TEMP_DIR}/bin" repo="${TEST_TEMP_DIR}/repo"
    mkdir -p "$bin" "${repo}/scripts"
    cp "${PROJECT_ROOT}/scripts/tenant-backup.sh" "${repo}/scripts/tenant-backup.sh"
    [[ ! -e "${repo}/.env" ]]
    printf '#!/usr/bin/env bash\nprintf "01927f00-0000-7000-8000-000000000001\\trealm1\\tactive\\teu\\tenv:BACKUP_KEY\\n"\n' > "${bin}/psql"
    printf '#!/usr/bin/env bash\necho "$*" >> "%s/docker.log"\n' "$TEST_TEMP_DIR" > "${bin}/docker"
    printf '#!/usr/bin/env bash\ncat\n' > "${bin}/openssl"
    chmod +x "${bin}/psql" "${bin}/docker" "${bin}/openssl"
    run env -u KEYCLOAK_ADMIN PATH="${bin}:${PATH}" \
        CONTROL_DATABASE_URL=postgres://stub/control POSTGRES_USER=pg_stub POSTGRES_DB=gremion \
        BACKUP_KEY=stub-key BACKUP_DIR="${TEST_TEMP_DIR}/backups" \
        bash "${repo}/scripts/tenant-backup.sh" "$slug"
}

@test "tenant-backup.sh dumps the kernel database of slug default by its tenant id, like any other slug" {
    run_tenant_backup_stubbed default
    grep -q -- "pg_dump -Fc -U pg_stub t_01927f00000070008000000000000001__kernel" "${TEST_TEMP_DIR}/docker.log"
    ! grep -qE -- "pg_dump -Fc -U pg_stub gremion( |$)" "${TEST_TEMP_DIR}/docker.log"
}

# TASK-043 G8 (Q3): the kernel database is t_<tenant id hex>__kernel, never t_<slug>.
@test "tenant-backup.sh dumps t_<tenant id hex>__kernel for an ordinary slug, never t_<slug>" {
    run_tenant_backup_stubbed alpha
    grep -q -- "pg_dump -Fc -U pg_stub t_01927f00000070008000000000000001__kernel" "${TEST_TEMP_DIR}/docker.log"
    ! grep -q -- "pg_dump -Fc -U pg_stub t_alpha" "${TEST_TEMP_DIR}/docker.log"
}
