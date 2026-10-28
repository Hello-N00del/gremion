#!/usr/bin/env bash
# ============================================================
# Gremion — Database restore script
#
# WARNING: This DESTROYS and recreates the target database.
# Always run a fresh backup before restoring.
#
# Usage (direct dump file):
#   ./scripts/restore.sh keycloak backups/current/keycloak.sql.gz
#   ./scripts/restore.sh gremion    backups/current/gremion.sql.gz
#   ./scripts/restore.sh control  backups/current/control.sql.gz
#
# Usage (from restic snapshot):
#   ./scripts/restore.sh --snapshot latest keycloak
#   ./scripts/restore.sh --list-snapshots        # show available snapshots
#
# Targets: keycloak | gremion | control
#
# Snapshot tags: read under $BACKUP_TAG (default gremion) OR $BACKUP_LEGACY_TAG
# (default stura-os), so pre-rename snapshots remain listable and restorable.
#
# The restore process:
#   1. [restic path] Restores snapshot to a temp dir
#   2. Drops and recreates the target database
#   3. Restores from the gzipped SQL dump
# ============================================================

set -euo pipefail
cd "$(dirname "$0")/.."

info()  { echo "[restore] $*"; }
error() { echo "[restore] ERROR: $*" >&2; exit 1; }

if [[ -f .env ]]; then
    # Parse .env safely without executing it as a shell script (source would run
    # any command substitution or subshells present in the file).
    while IFS='=' read -r key val; do
        [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
        val="${val#\"}" val="${val%\"}"  # strip surrounding double quotes
        val="${val#\'}" val="${val%\'}"  # strip surrounding single quotes
        export "$key=$val"
    done < <(grep -v '^[[:space:]]*#' .env | grep -v '^[[:space:]]*$')
else
    error ".env file not found. Copy .env.example to .env and configure it first."
fi

# Validate required variables are set
: "${POSTGRES_USER:?POSTGRES_USER is not set in .env}"

# restic password for snapshot mode
if [[ -n "${RESTIC_PASSWORD_FILE:-}" ]]; then
    RESTIC_PASSWORD="$(<"$RESTIC_PASSWORD_FILE")"
    export RESTIC_PASSWORD
fi

RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-./backups/repo}"
export RESTIC_REPOSITORY

# Snapshots are read under the neutral tag AND the legacy one (repeated --tag is
# restic OR semantics), so snapshots written before the rename stay restorable.
BACKUP_TAG="${BACKUP_TAG:-gremion}"
BACKUP_LEGACY_TAG="${BACKUP_LEGACY_TAG:-stura-os}"
TAG_ARGS=(--tag "$BACKUP_TAG" --tag "$BACKUP_LEGACY_TAG")

# ── Snapshot listing ──────────────────────────────────────────

if [[ "${1:-}" == "--list-snapshots" ]]; then
    : "${RESTIC_PASSWORD:?RESTIC_PASSWORD (or RESTIC_PASSWORD_FILE) is not set}"
    restic snapshots "${TAG_ARGS[@]}"
    exit 0
fi

# ── Snapshot restore path ─────────────────────────────────────

SNAPSHOT_ID=""
if [[ "${1:-}" == "--snapshot" ]]; then
    : "${RESTIC_PASSWORD:?RESTIC_PASSWORD (or RESTIC_PASSWORD_FILE) is not set}"
    SNAPSHOT_ID="${2:?Usage: $0 --snapshot <id|latest> <target>}"
    TARGET="${3:?Usage: $0 --snapshot <id|latest> <target>}"

    RESTORE_TMP=$(mktemp -d)
    trap 'rm -rf "$RESTORE_TMP"' EXIT

    info "Restoring snapshot '${SNAPSHOT_ID}' to temp dir ${RESTORE_TMP}..."
    restic restore "$SNAPSHOT_ID" "${TAG_ARGS[@]}" --target "$RESTORE_TMP" --quiet

    # Dump files live under the DUMP_DIR path within the snapshot
    # e.g. /tmp/restore/backups/current/<db>.sql.gz — locate by name
    BACKUP_FILE=$(find "$RESTORE_TMP" -name "${TARGET}.sql.gz" | head -n1)
    [[ -n "$BACKUP_FILE" ]] || error "No dump for '${TARGET}' found in snapshot ${SNAPSHOT_ID}"
    info "Found dump: ${BACKUP_FILE}"
else
    TARGET="${1:-}"
    BACKUP_FILE="${2:-}"

    [[ -z "$TARGET"      ]] && error "Usage: $0 <keycloak|gremion|control> <backup-file.sql.gz>"
    [[ -z "$BACKUP_FILE" ]] && error "Usage: $0 <keycloak|gremion|control> <backup-file.sql.gz>"
    [[ -f "$BACKUP_FILE" ]] || error "Backup file not found: ${BACKUP_FILE}"
fi

echo ""
echo "  ⚠  WARNING: This will DESTROY the '${TARGET}' database and restore from:"
echo "     ${BACKUP_FILE}"
echo ""
read -rp "  Type 'yes' to confirm: " CONFIRM
[[ "$CONFIRM" == "yes" ]] || { echo "Aborted."; exit 0; }

case "$TARGET" in
    keycloak|gremion|control)
        # All three governance-kernel databases share the plain
        # drop/recreate/restore pattern; only the owning role differs.
        info "Restoring PostgreSQL database: ${TARGET}..."
        DB_USER="${GREMION_DB_USER:-gremion}"
        [[ "$TARGET" == "keycloak" ]] && DB_USER="${KEYCLOAK_DB_USER:-keycloak}"
        [[ "$TARGET" == "control"  ]] && DB_USER="${CONTROL_DB_USER:-control}"

        # Drop and recreate (use psql -v with format() to prevent SQL injection).
        # F1-FIX-09 (K6#3): ON_ERROR_STOP on EVERY psql call. Plain psql carries on
        # after an error and exits 0, so a failed drop/create/load used to end in
        # "Restore complete" over a half-built database.
        docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" \
            -v ON_ERROR_STOP=1 \
            -v _target="$TARGET" -v _db_user="$DB_USER" <<-'SQL'
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = :'_target' AND pid <> pg_backend_pid();
            SELECT format('DROP DATABASE IF EXISTS %I', :'_target') \gexec
            SELECT format('CREATE DATABASE %I OWNER %I', :'_target', :'_db_user') \gexec
            SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'_target', :'_db_user') \gexec
SQL

        # Restore. ON_ERROR_STOP plus ONE transaction: the load either lands in
        # full or leaves the freshly created, empty database. pipefail (set above)
        # makes a zcat failure fail the pipeline as well as a psql failure.
        zcat "$BACKUP_FILE" \
            | docker compose exec -T postgres \
                psql -U "${POSTGRES_USER:-postgres}" \
                    -v ON_ERROR_STOP=1 --single-transaction "$TARGET" \
            || error "Restore of '${TARGET}' FAILED while loading ${BACKUP_FILE}; the database was dropped and is not usable"

        # Post-condition, read from the restored database and not from the exit
        # codes above: a dump that loaded nothing (an empty or header-only file)
        # exits 0 everywhere. Every target of this script owns tables.
        TABLES="$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" \
            -d "$TARGET" -v ON_ERROR_STOP=1 -tAc \
            "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')" \
            </dev/null | tr -d '[:space:]')" \
            || error "Restore of '${TARGET}' could not be verified (post-condition query failed)"
        [[ "$TABLES" =~ ^[0-9]+$ && "$TABLES" -gt 0 ]] \
            || error "Restore of '${TARGET}' FAILED: the restored database has no tables (post-condition read '${TABLES:-nothing}')"
        info "Post-condition: '${TARGET}' holds ${TABLES} table(s)."
        ;;

    *)
        error "Unknown target: ${TARGET}. Must be one of: keycloak, gremion, control"
        ;;
esac

info "Restore complete for '${TARGET}'."
