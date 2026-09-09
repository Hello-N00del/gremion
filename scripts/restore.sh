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

# ── Snapshot listing ──────────────────────────────────────────

if [[ "${1:-}" == "--list-snapshots" ]]; then
    : "${RESTIC_PASSWORD:?RESTIC_PASSWORD (or RESTIC_PASSWORD_FILE) is not set}"
    restic snapshots --tag stura-os
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
    restic restore "$SNAPSHOT_ID" --target "$RESTORE_TMP" --quiet

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

        # Drop and recreate (use psql -v with format() to prevent SQL injection)
        docker compose exec -T postgres psql -U "${POSTGRES_USER:-postgres}" \
            -v _target="$TARGET" -v _db_user="$DB_USER" <<-'SQL'
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = :'_target' AND pid <> pg_backend_pid();
            SELECT format('DROP DATABASE IF EXISTS %I', :'_target') \gexec
            SELECT format('CREATE DATABASE %I OWNER %I', :'_target', :'_db_user') \gexec
            SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'_target', :'_db_user') \gexec
SQL

        # Restore
        zcat "$BACKUP_FILE" \
            | docker compose exec -T postgres \
                psql -U "${POSTGRES_USER:-postgres}" "$TARGET"
        ;;

    *)
        error "Unknown target: ${TARGET}. Must be one of: keycloak, gremion, control"
        ;;
esac

info "Restore complete for '${TARGET}'."
