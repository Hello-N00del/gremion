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

# ---------------------------------------------------------------------------
# k8s backup CronJob: a dump that failed must fail the job (F1-FIX-09, K6#9)
#
# The job ran `pg_dump | gzip > f 2>/dev/null || true` and recorded every dump as
# "ok", so a dead Postgres produced a green job over empty dumps, and restic then
# snapshotted them. The tests below run the REAL script block of the CronJob (cut
# out of the YAML, not re-typed) under bash with pg_dump/restic shims whose exit
# codes model the real tools.
# ---------------------------------------------------------------------------

cronjob_script() {   # the `backup` container's shell script, dedented
    awk '
        /^            - name: backup$/        { inb = 1 }
        inb && /^                - \|$/       { grab = 1; next }
        grab && /^              env:$/        { exit }
        grab { sub(/^                  /, ""); print }
    ' "${PROJECT_ROOT}/k8s/base/backup/cronjob.yaml"
}

# $1 = the pg_dump behaviour: ok | fail | empty | failmid
cronjob_run() {
    local mode="$1" bin="${TEST_TEMP_DIR}/bin" root="${TEST_TEMP_DIR}/backup"
    mkdir -p "$bin" "$root"
    cronjob_script | sed -e "s|BACKUP_DIR=/backup|BACKUP_DIR=${root}|" -e "s|/tools/rclone|${bin}/rclone|g" > "${TEST_TEMP_DIR}/cronjob.sh"
    make_rclone_shim "$bin"
    [ -s "${TEST_TEMP_DIR}/cronjob.sh" ]
    cat > "${bin}/pg_dump" <<'SHIM'
#!/usr/bin/env bash
case "$FAKE_PGDUMP" in
    ok)      echo "CREATE TABLE t (x int);"; echo "-- dump of $*" ;;
    fail)    echo "pg_dump: error: connection to server failed" >&2; exit 1 ;;
    empty)   : ;;
    failmid) echo "CREATE TABLE t (x int);"; echo "pg_dump: error: query failed" >&2; exit 1 ;;
esac
SHIM
    cat > "${bin}/restic" <<'SHIM'
#!/usr/bin/env bash
echo "restic $*" >> "$RESTIC_LOG"
exit 0
SHIM
    chmod +x "${bin}/pg_dump" "${bin}/restic"
    export FAKE_PGDUMP="$mode" RESTIC_LOG="${TEST_TEMP_DIR}/restic.log"
    : > "$RESTIC_LOG"
    PATH="${bin}:${PATH}" POSTGRES_USER=postgres POSTGRES_PASSWORD=fixture RESTIC_PASSWORD=fixture \
        run bash "${TEST_TEMP_DIR}/cronjob.sh"
}

@test "k8s backup cronjob: the extracted script is real and parses" {
    cronjob_script > "${TEST_TEMP_DIR}/cronjob.sh"
    [ -s "${TEST_TEMP_DIR}/cronjob.sh" ]
    grep -qF 'pg_dump' "${TEST_TEMP_DIR}/cronjob.sh"
    bash -n "${TEST_TEMP_DIR}/cronjob.sh"
}

@test "k8s backup cronjob: three good dumps run restic and end ok" {
    cronjob_run ok
    [ "$status" -eq 0 ]
    grep -q '^restic backup ' "$RESTIC_LOG"
    local log
    log="$(ls "${TEST_TEMP_DIR}/backup/logs/"*.json)"
    [ "$(jq -r '.status' "$log")" = "ok" ]
    [ "$(jq -r '[.steps[] | select(.step | startswith("dump_postgres_")) | select(.status == "ok")] | length' "$log")" = "3" ]
    gzip -t "${TEST_TEMP_DIR}/backup/current/keycloak.sql.gz"
}

@test "k8s backup cronjob: a failing pg_dump fails the job, keeps the previous dump and never snapshots" {
    mkdir -p "${TEST_TEMP_DIR}/backup/current"
    printf 'previous-good-dump' | gzip > "${TEST_TEMP_DIR}/backup/current/keycloak.sql.gz"
    local before
    before="$(sha256sum "${TEST_TEMP_DIR}/backup/current/keycloak.sql.gz" | cut -d' ' -f1)"
    cronjob_run fail
    [ "$status" -ne 0 ]
    # the previous artefact is byte-identical, and nothing was snapshotted
    [ "$(sha256sum "${TEST_TEMP_DIR}/backup/current/keycloak.sql.gz" | cut -d' ' -f1)" = "$before" ]
    run grep -c '^restic backup ' "$RESTIC_LOG"
    [ "$output" = "0" ]
    local log
    log="$(ls "${TEST_TEMP_DIR}/backup/logs/"*.json)"
    [ "$(jq -r '.status' "$log")" = "error" ]
    [ "$(jq -r '[.steps[] | select(.step | startswith("dump_postgres_")) | select(.status == "ok")] | length' "$log")" = "0" ]
}

@test "k8s backup cronjob: a pg_dump that dies mid-stream is not recorded as ok" {
    cronjob_run failmid
    [ "$status" -ne 0 ]
    run grep -c '^restic backup ' "$RESTIC_LOG"
    [ "$output" = "0" ]
    # a truncated-but-decompressible file must never sit at the final name
    [ ! -e "${TEST_TEMP_DIR}/backup/current/keycloak.sql.gz" ]
}

@test "k8s backup cronjob: a dump with no content is a failure, not an ok step" {
    cronjob_run empty
    [ "$status" -ne 0 ]
    run grep -c '^restic backup ' "$RESTIC_LOG"
    [ "$output" = "0" ]
}

@test "k8s backup cronjob installs a digest-pinned rclone, not rclone-current (K6#38)" {
    local cj="${PROJECT_ROOT}/k8s/base/backup/cronjob.yaml"
    grep -qE 'image: rclone/rclone:[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}$' "$cj"
    assert_file_not_contains "$cj" "rclone-current"
    assert_file_not_contains "$cj" "downloads.rclone.org"
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

# ---------------------------------------------------------------------------
# Neutral snapshot tag + remote path (the old product name must not be written)
# ---------------------------------------------------------------------------

@test "backup.sh tags snapshots with the neutral BACKUP_TAG, not the legacy name" {
    grep -qF 'BACKUP_TAG="${BACKUP_TAG:-gremion}"' "$BACKUP_SCRIPT"
    grep -qF -- '--tag "$BACKUP_TAG"' "$BACKUP_SCRIPT"
    assert_absent '(--tag.*stura|RCLONE_REMOTE_PATH:-stura)' "$BACKUP_SCRIPT" "legacy name written by writer"
}

@test "backup.sh defaults the rclone remote path to gremion-restic" {
    grep -qF 'RCLONE_REMOTE_PATH:-gremion-restic' "$BACKUP_SCRIPT"
}

@test "k8s backup cronjob: restic snapshot carries the neutral tag" {
    cronjob_run ok
    [ "$status" -eq 0 ]
    grep -qE '^restic backup .*--tag gremion( |$)' "$RESTIC_LOG"
    assert_absent 'stura' "$RESTIC_LOG" "legacy tag written by cronjob"
}

@test "k8s backup cronjob: BACKUP_TAG overrides the tag" {
    BACKUP_TAG=custom-tag cronjob_run ok
    [ "$status" -eq 0 ]
    grep -qE '^restic backup .*--tag custom-tag( |$)' "$RESTIC_LOG"
}

@test "k8s backup manifests carry no legacy product name" {
    assert_absent '(--tag.*stura|RCLONE_REMOTE_PATH:-stura)' "${PROJECT_ROOT}/k8s/base/backup/cronjob.yaml" "legacy name written"
    assert_absent 'stura' "${PROJECT_ROOT}/k8s/base/backup/rclone-secret.yaml" "legacy name"
}

# ---------------------------------------------------------------------------
# Guard: the RCLONE_REMOTE_PATH default moved to gremion-restic. An install that
# never set it must not silently start a fresh repo while its history stays at
# the legacy path. Explicitly setting RCLONE_REMOTE_PATH always wins, unchecked.
# ---------------------------------------------------------------------------

# rclone shim: `lsf` lists FAKE_NEW_LISTING for a .../gremion-restic path and
# FAKE_LEGACY_LISTING for .../stura-restic; every call is logged.
make_rclone_shim() {   # $1 = bin dir
    mkdir -p "$1"
    cat > "$1/rclone" <<'SHIM'
#!/usr/bin/env bash
echo "rclone $*" >> "${RCLONE_LOG:-/dev/null}"
if [[ "$1" == "lsf" ]]; then
    case "$2" in
        *gremion-restic) printf '%s' "${FAKE_NEW_LISTING:-}" ;;
        *stura-restic)   printf '%s' "${FAKE_LEGACY_LISTING:-}" ;;
    esac
    exit 0
fi
exit 0
SHIM
    chmod +x "$1/rclone"
    export RCLONE_LOG="${TEST_TEMP_DIR}/rclone.log"
    : > "$RCLONE_LOG"
}

# backup.sh in a repo-root-shaped tree; docker fails so a run that gets past the
# guard dies in Phase 1, after (and never before) the guard has spoken.
guard_tree() {
    TREE="${TEST_TEMP_DIR}/tree"
    mkdir -p "${TREE}/scripts" "${TREE}/bin"
    cp "$BACKUP_SCRIPT" "${TREE}/scripts/backup.sh"
    printf 'POSTGRES_USER=postgres\nRESTIC_PASSWORD=fixture\n' > "${TREE}/.env"
    make_rclone_shim "${TREE}/bin"
    printf '#!/usr/bin/env bash\nexit 1\n' > "${TREE}/bin/docker"
    chmod +x "${TREE}/bin/docker"
    export PATH="${TREE}/bin:${PATH}" RCLONE_BUCKET=bkt
}

@test "backup.sh refuses an unset RCLONE_REMOTE_PATH when only the legacy path holds a repo" {
    guard_tree
    FAKE_LEGACY_LISTING=$'config\ndata/\n' run bash "${TREE}/scripts/backup.sh"
    [ "$status" -ne 0 ]
    [[ "$output" == *"RCLONE_REMOTE_PATH=stura-restic"* ]]
    [[ "$output" == *"rclone moveto"* ]]
    [[ "$output" != *"Phase 1"* ]]
}

@test "backup.sh: an explicit RCLONE_REMOTE_PATH skips the legacy-path check entirely" {
    guard_tree
    FAKE_LEGACY_LISTING=$'config\n' RCLONE_REMOTE_PATH=stura-restic run bash "${TREE}/scripts/backup.sh"
    [[ "$output" != *"rclone moveto"* ]]
    [[ "$output" == *"Phase 1"* ]]
    assert_absent 'lsf' "$RCLONE_LOG" "explicit path must not be probed"
}

@test "backup.sh: no refusal when the new default path already holds a repo" {
    guard_tree
    FAKE_NEW_LISTING=$'config\n' FAKE_LEGACY_LISTING=$'config\n' run bash "${TREE}/scripts/backup.sh"
    [[ "$output" != *"rclone moveto"* ]]
    [[ "$output" == *"Phase 1"* ]]
}

@test "backup.sh: no refusal on a fresh install (neither path exists)" {
    guard_tree
    run bash "${TREE}/scripts/backup.sh"
    [[ "$output" != *"rclone moveto"* ]]
    [[ "$output" == *"Phase 1"* ]]
}

@test "backup.sh: no remote configured, no probe" {
    guard_tree
    unset RCLONE_BUCKET
    FAKE_LEGACY_LISTING=$'config\n' run bash "${TREE}/scripts/backup.sh"
    [[ "$output" != *"rclone moveto"* ]]
}

@test "k8s backup cronjob refuses an unset RCLONE_REMOTE_PATH when only the legacy path holds a repo" {
    export RCLONE_BUCKET=bkt
    unset RCLONE_REMOTE_PATH
    FAKE_LEGACY_LISTING=$'config\n' cronjob_run ok
    [ "$status" -ne 0 ]
    [[ "$output" == *"RCLONE_REMOTE_PATH=stura-restic"* ]]
    [[ "$output" == *"rclone moveto"* ]]
    assert_absent '^restic backup ' "$RESTIC_LOG" "snapshotted despite the guard"
}

@test "k8s backup cronjob: an explicit RCLONE_REMOTE_PATH wins with no check" {
    export RCLONE_BUCKET=bkt
    FAKE_LEGACY_LISTING=$'config\n' RCLONE_REMOTE_PATH=stura-restic cronjob_run ok
    [ "$status" -eq 0 ]
    assert_absent 'lsf' "$RCLONE_LOG" "explicit path must not be probed"
    grep -q 'sync .* bkt/stura-restic\|bkt/stura-restic' "$RCLONE_LOG"
}

@test "k8s backup cronjob: fresh install proceeds to the new default path" {
    export RCLONE_BUCKET=bkt
    unset RCLONE_REMOTE_PATH
    cronjob_run ok
    [ "$status" -eq 0 ]
    grep -q 'bkt/gremion-restic' "$RCLONE_LOG"
}

@test "k8s rclone-secret does not pin RCLONE_REMOTE_PATH (it would disable the guard)" {
    assert_absent '^[[:space:]]+RCLONE_REMOTE_PATH:' "${PROJECT_ROOT}/k8s/base/backup/rclone-secret.yaml" "pinned path"
}
