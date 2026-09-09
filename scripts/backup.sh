#!/usr/bin/env bash
# ============================================================
# Gremion — restic + rclone backup script
#
# Flow:
#   1. Dump all databases to $BACKUP_DIR/current/
#   2. restic backup → local encrypted repository
#   3. restic forget --prune  (local retention)
#   4. rclone sync → remote storage  (provider-agnostic)
#   5. restic check --read-data-subset=N%  (integrity check)
#   6. Write step durations to $BACKUP_DIR/logs/backup-$DATE.json
#
# Usage:
#   ./scripts/backup.sh
#   RESTIC_CHECK_SUBSET=5% ./scripts/backup.sh
#
# Required environment variables (from .env or K8s Secret):
#   POSTGRES_USER              — PostgreSQL superuser
#   RESTIC_REPOSITORY          — path to local restic repo (default: ./backups/repo)
#   RESTIC_PASSWORD            — restic encryption passphrase
#     OR
#   RESTIC_PASSWORD_FILE       — path to file containing passphrase
#
# Optional:
#   BACKUP_DIR                 — dump staging dir (default: ./backups)
#   BACKUP_LOCAL_RETENTION_DAYS  (default: 30)
#   RCLONE_REMOTE              — rclone remote name (default: backup)
#   RCLONE_BUCKET              — bucket/container name on remote
#   RCLONE_REMOTE_PATH         — path within bucket (default: stura-restic)
#   RESTIC_CHECK_SUBSET        — fraction to read-verify (default: 10%)
#
# rclone remote credentials are read from environment variables using
# rclone's RCLONE_CONFIG_<REMOTE>_<KEY> convention, e.g.:
#   RCLONE_CONFIG_BACKUP_TYPE=s3
#   RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID=...
#   RCLONE_CONFIG_BACKUP_SECRET_ACCESS_KEY=...
#   RCLONE_CONFIG_BACKUP_ENDPOINT=...         # for S3-compatible stores
#   RCLONE_CONFIG_BACKUP_REGION=...
# ============================================================

set -euo pipefail
cd "$(dirname "$0")/.."

# ── Logging helpers ───────────────────────────────────────────

info()    { echo "[backup] $*"; }
success() { echo "[backup] OK: $*"; }
error()   { echo "[backup] ERROR: $*" >&2; exit 1; }

# ── Load .env (safe parse, no eval) ──────────────────────────

if [[ -f .env ]]; then
    while IFS='=' read -r key val; do
        [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
        val="${val#\"}" val="${val%\"}"
        val="${val#\'}" val="${val%\'}"
        export "$key=$val"
    done < <(grep -v '^[[:space:]]*#' .env | grep -v '^[[:space:]]*$')
else
    error ".env file not found. Copy .env.example to .env and configure it first."
fi

# ── Validate required variables ───────────────────────────────

: "${POSTGRES_USER:?POSTGRES_USER is not set}"

# restic password: accept file or direct value
if [[ -n "${RESTIC_PASSWORD_FILE:-}" ]]; then
    RESTIC_PASSWORD="$(<"$RESTIC_PASSWORD_FILE")"
    export RESTIC_PASSWORD
fi
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD (or RESTIC_PASSWORD_FILE) is not set}"

# ── Configuration ─────────────────────────────────────────────

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DUMP_DIR="${BACKUP_DIR}/current"
LOG_DIR="${BACKUP_DIR}/logs"
RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-${BACKUP_DIR}/repo}"
LOCAL_RETENTION="${BACKUP_LOCAL_RETENTION_DAYS:-30}d"
RCLONE_REMOTE="${RCLONE_REMOTE:-backup}"
RCLONE_BUCKET="${RCLONE_BUCKET:-}"
RCLONE_REMOTE_PATH="${RCLONE_REMOTE_PATH:-stura-restic}"
CHECK_SUBSET="${RESTIC_CHECK_SUBSET:-10%}"
DATE=$(date +%Y%m%d-%H%M%S)
RUN_ID="backup-${DATE}"

export RESTIC_REPOSITORY

mkdir -p "$DUMP_DIR" "$LOG_DIR"

# ── Step timing helpers ───────────────────────────────────────

declare -a STEP_LOG=()
OVERALL_START=$(date +%s)

record_step() {
    local name="$1" start="$2" end="$3" status="$4" extra="${5:-}"
    local dur=$(( end - start ))
    local entry="{\"step\":\"${name}\",\"duration_s\":${dur},\"status\":\"${status}\""
    [[ -n "$extra" ]] && entry+=",$extra"
    entry+="}"
    STEP_LOG+=("$entry")
    info "  ${name}: ${dur}s [${status}]"
}

write_json_log() {
    local overall_status="$1"
    local overall_end; overall_end=$(date +%s)
    local total=$(( overall_end - OVERALL_START ))
    local steps_json
    steps_json=$(IFS=,; echo "${STEP_LOG[*]}")
    mkdir -p "$LOG_DIR"
    cat > "${LOG_DIR}/${RUN_ID}.json" <<JSON
{
  "run_id": "${RUN_ID}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "total_duration_s": ${total},
  "status": "${overall_status}",
  "steps": [${steps_json}]
}
JSON
    info "Step log written to ${LOG_DIR}/${RUN_ID}.json"
}

# Trap to write log even on failure
trap 'write_json_log "error"' ERR

# ── Phase 1: Database dumps ───────────────────────────────────

info "=== Phase 1: Dumping databases ==="

# dump_postgres <db>
#   Dumps <db> from the shared `postgres` service as the POSTGRES_USER superuser
#   into $DUMP_DIR/<db>.sql.gz.
dump_postgres() {
    local db="$1"
    local file="${DUMP_DIR}/${db}.sql.gz"
    local t0; t0=$(date +%s)
    info "  Dumping PostgreSQL: ${db}..."
    docker compose exec -T postgres \
        pg_dump -U "${POSTGRES_USER}" "$db" | gzip > "$file"
    local t1; t1=$(date +%s)
    local size
    size=$(du -sb "$file" | cut -f1)
    record_step "dump_postgres_${db}" "$t0" "$t1" "ok" "\"size_bytes\":${size}"
}

# The governance kernel provisions exactly these three databases via
# docker/postgres/init-databases.sh (mirrored in k8s/base/postgres/configmap.yaml):
#   keycloak — realm / user store
#   gremion    — governance kernel data plane
#   control  — P2.1c tenant registry + fleet-migration ledger (#234)
# All are created unconditionally (no docker-compose `profiles:` gate), so they
# exist in every deployment including production. pg_dump runs as the
# POSTGRES_USER superuser, so no per-DB credentials are needed.
dump_postgres keycloak
dump_postgres gremion
dump_postgres control

# ── Phase 2: restic backup ────────────────────────────────────

info "=== Phase 2: restic backup ==="

# Initialise repository if it does not yet exist
if ! restic snapshots --quiet > /dev/null 2>&1; then
    info "  Initialising restic repository at ${RESTIC_REPOSITORY}..."
    restic init --quiet
fi

t0=$(date +%s)
restic backup "$DUMP_DIR" \
    --tag "$RUN_ID" \
    --tag "stura-os" \
    --compression max \
    --quiet
t1=$(date +%s)
record_step "restic_backup" "$t0" "$t1" "ok"

# ── Phase 3: restic forget + prune ───────────────────────────

info "=== Phase 3: restic forget + prune (local: ${LOCAL_RETENTION}) ==="
t0=$(date +%s)
restic forget \
    --keep-within "$LOCAL_RETENTION" \
    --prune \
    --quiet
t1=$(date +%s)
record_step "restic_forget_prune" "$t0" "$t1" "ok"

# ── Phase 4: rclone sync to remote ───────────────────────────

if [[ -n "$RCLONE_BUCKET" ]]; then
    info "=== Phase 4: rclone sync → ${RCLONE_REMOTE}:${RCLONE_BUCKET}/${RCLONE_REMOTE_PATH}/ ==="
    t0=$(date +%s)
    rclone sync "$RESTIC_REPOSITORY" \
        "${RCLONE_REMOTE}:${RCLONE_BUCKET}/${RCLONE_REMOTE_PATH}" \
        --transfers 4 \
        --checkers 8 \
        --stats-one-line \
        --quiet
    t1=$(date +%s)
    record_step "rclone_sync" "$t0" "$t1" "ok"
else
    info "=== Phase 4: skipped (RCLONE_BUCKET not set) ==="
    STEP_LOG+=("{\"step\":\"rclone_sync\",\"duration_s\":0,\"status\":\"skipped\"}")
fi

# ── Phase 5: integrity check ──────────────────────────────────

info "=== Phase 5: restic check (--read-data-subset=${CHECK_SUBSET}) ==="
t0=$(date +%s)
restic check \
    --read-data-subset="$CHECK_SUBSET" \
    --quiet
t1=$(date +%s)
record_step "restic_check" "$t0" "$t1" "ok"

# ── Finalise ──────────────────────────────────────────────────

trap - ERR
write_json_log "ok"
success "Backup complete (run: ${RUN_ID})"
