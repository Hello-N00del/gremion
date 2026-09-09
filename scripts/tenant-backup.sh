#!/usr/bin/env bash
# ============================================================
# Gremion — per-tenant backup (P2.1c Task 16, §8.7 mechanics)
#
# Per-tenant backup = per-DB pg_dump + per-realm export, EACH encrypted under
# the tenant's OWN backup key (registry `backup_key_ref`), written under the
# tenant's `residency_zone`. gremion#22: a per-tenant leaf-PG dump step used to
# run here against a compose service that has since been carved out of the
# kernel entirely — that service no longer exists in ANY compose file, so the
# step is gone too (mirrors scripts/backup.sh / restore.sh, which carry the
# same carve-parity guard — see test/backup.bats).
# This is the silo-isolated counterpart of the global scripts/backup.sh
# (which backs up the whole stack into one restic repo); this script touches
# exactly ONE tenant so a later tenant-delete can crypto-shred its key and
# instantly invalidate ONLY that tenant's backups (§7.9 / Task 17).
#
# Usage:
#   ./scripts/tenant-backup.sh <slug>
#
# DECISIONS (plan Task 16 "pick one, document"):
#   * Realm export  = Keycloak Admin API `POST /admin/realms/<realm>/partial-export`
#     (exportClients=true, exportGroupsAndRoles=true) via curl — subprocess-free,
#     mirrors D-PROVSCRIPT (the provisioner makes KC calls via the Admin API, not
#     `kcadm.sh` inside the container), so this runs operator-side without the
#     keycloak container.
#   * Encryption    = `openssl enc -aes-256-cbc -pbkdf2 -salt` — the established
#     established precedent here (the k8s production backup overlay + ADR 2026-03-27 both use
#     `openssl enc -aes-256-cbc`; no extra `age` binary dependency to install on
#     the host). Artifacts keep the `.age` suffix to match the plan's acceptance
#     artifact list verbatim; the cipher is openssl. (Switch to real `age` here
#     if the operator later standardises on age.)
#
# ⛔ This machine is the LIVE staging host (§0.1). This script NEVER runs
#    `docker compose up/restart/--force-recreate`. The pg_dump runs through
#    `docker compose exec -T postgres` against the ALREADY-RUNNING postgres
#    (read-only w.r.t. the stack). The S3 acceptance is unit/integration-level
#    (backup-key.integration.test.ts); a real end-to-end run against the §0.1
#    isolated smoke stack is the NAMED D-87-SLIP S4 dress-rehearsal carry-over.
#
# Required environment (from .env / operator root secret):
#   CONTROL_DATABASE_URL  — control-plane DB URL (registry lives here)
#   POSTGRES_USER         — postgres superuser (for the per-tenant pg_dump)
#   KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD — KC admin for the realm export
#
# Optional:
#   TENANT_SECRETS_DIR    — host root for per-tenant secret files
#                           (default ./secrets/tenants; mirrors tenantSecretHostPath)
#   KC_BASE_URL           — Keycloak base (default http://localhost:8080/auth)
#   BACKUP_DIR            — backup root (default ./backups)
#   TENANT_BACKUP_RETENTION_DAYS — retention (default 30; config.backups.retention_days)
# ============================================================

set -euo pipefail
cd "$(dirname "$0")/.."

slug="${1:-}"
[[ -n "$slug" ]] || { echo "[tenant-backup] ERROR: usage: $0 <slug>" >&2; exit 2; }
# Single-source the slug guard (mirrors slug.ts SLUG_PATTERN ^[a-z0-9-]{1,30}$ /
# tenant-provision.ts validateSlug): reject any slug not matching the pattern
# BEFORE it ever reaches a SQL string or a filesystem path. This blocks both
# control-DB SQL injection (the psql query below) and path traversal (the
# mkdir -p / find -delete paths below).
[[ "$slug" =~ ^[a-z0-9-]{1,30}$ ]] || { echo "[tenant-backup] ERROR: invalid slug '${slug}' (must match ^[a-z0-9-]{1,30}\$)" >&2; exit 2; }

info()    { echo "[tenant-backup] $*"; }
success() { echo "[tenant-backup] OK: $*"; }
error()   { echo "[tenant-backup] ERROR: $*" >&2; exit 1; }

# ── Load .env (safe parse, no eval — same convention as scripts/backup.sh) ────
if [[ -f .env ]]; then
    while IFS='=' read -r key val; do
        [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
        val="${val#\"}" val="${val%\"}"
        val="${val#\'}" val="${val%\'}"
        export "$key=$val"
    done < <(grep -v '^[[:space:]]*#' .env | grep -v '^[[:space:]]*$')
fi

: "${CONTROL_DATABASE_URL:?CONTROL_DATABASE_URL is not set}"
: "${POSTGRES_USER:?POSTGRES_USER is not set}"

KC_BASE_URL="${KC_BASE_URL:-http://localhost:8080/auth}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
TENANT_SECRETS_DIR="${TENANT_SECRETS_DIR:-./secrets/tenants}"
RETENTION_DAYS="${TENANT_BACKUP_RETENTION_DAYS:-30}"
DATE=$(date +%Y%m%d-%H%M%S)

# ── (1) Read the registry row for <slug> (psql against the control DB) ────────
# Single tab-separated row: realm_name, status, residency_zone, backup_key_ref.
info "Reading registry row for tenant '${slug}' (control DB)..."
# slug bound via psql -v + the :'slug' quoted-literal interpolation (psql quotes
# and escapes the value as a SQL string literal) — defence-in-depth over the
# guard above, never a raw "${slug}" string-substitution into the SQL text.
row=$(psql "$CONTROL_DATABASE_URL" -At -F $'\t' -v slug="$slug" -c \
    "SELECT realm_name, status, domain_profile->>'residencyZone', backup_key_ref
       FROM tenant WHERE slug = :'slug'") \
    || error "control-DB query failed for slug '${slug}'"
[[ -n "$row" ]] || error "no registry row for tenant '${slug}'"
IFS=$'\t' read -r realm_name status residency_zone backup_key_ref <<< "$row"
[[ "$status" == "active" ]] || info "WARN: tenant '${slug}' status is '${status}' (not active) — backing up anyway"

# ── Resolve the per-tenant backup KEY to its EXACTLY-ONE host location ────────
# Mirrors lib/server/tenant/backup-key.ts backupKeyLocation():
#   file:/run/secrets/tenants/<name>  ->  ${TENANT_SECRETS_DIR}/<name>   (crypto-shred target)
#   env:<VAR>                         ->  the operator root secret env var (default tenant)
case "$backup_key_ref" in
  file:/run/secrets/tenants/*)
    name="${backup_key_ref#file:/run/secrets/tenants/}"
    case "$name" in */*|*..*) error "backup_key_ref escapes the tenants subdir: ${backup_key_ref}";; esac
    key_path="${TENANT_SECRETS_DIR%/}/${name}"
    [[ -f "$key_path" ]] || error "backup key file missing: ${key_path}"
    BACKUP_KEY="$(<"$key_path")"
    info "backup key: file at ${key_path}"
    ;;
  env:*)
    key_var="${backup_key_ref#env:}"
    BACKUP_KEY="${!key_var:-}"
    [[ -n "$BACKUP_KEY" ]] || error "backup key env var ${key_var} is unset"
    info "backup key: env:${key_var} (default-tenant root secret)"
    ;;
  *)
    error "unsupported backup_key_ref scheme: ${backup_key_ref%%:*}:"
    ;;
esac

# ── Per-tenant data-plane DB name ─────────────────────────────────────────────
# DB name mirrors slug.ts dbNameForSlug() / register-default (env:DATABASE_URL).
if [[ "$slug" == "default" ]]; then
    db_name="${POSTGRES_DB:-gremion}"
else
    db_name="t_${slug}"
fi

OUT_DIR="${BACKUP_DIR%/}/tenants/${residency_zone:-eu}/${slug}"
mkdir -p "$OUT_DIR"
info "writing to ${OUT_DIR}/ (residency_zone=${residency_zone:-eu}, retention=${RETENTION_DAYS}d)"

# ── openssl encrypt helper (stdin -> <out>; key on fd 3, never argv/env-leak) ─
encrypt_to() {
    local out="$1"
    openssl enc -aes-256-cbc -pbkdf2 -salt -pass fd:3 3<<<"$BACKUP_KEY" > "$out"
}

# ── (2) DB dump: pg_dump -Fc through the running postgres, encrypted ──────────
info "Dumping ${db_name} (pg_dump -Fc) -> ${slug}.dump.age ..."
docker compose exec -T postgres \
    pg_dump -Fc -U "$POSTGRES_USER" "$db_name" \
    | encrypt_to "${OUT_DIR}/${slug}.dump.age"

# ── (3) Realm export: Admin API partial-export, encrypted ─────────────────────
# This box is the SHARED live staging host — the KC admin password must NEVER
# reach the process table (curl argv is world-readable via /proc/<pid>/cmdline,
# `ps -ef`, etc.). The secret is therefore fed to curl OFF-argv via fd 3:
# `--data-urlencode password@/dev/fd/3` reads (and URL-encodes) the password from
# the fd, so it appears in no argument vector and no env-var listing of the curl
# child. The fd is fed via process substitution + `printf '%s'` (NOT a herestring):
# curl's `@file` reader URL-encodes the ENTIRE fd content verbatim, and a bash
# herestring (`<<<`) appends a trailing newline that would become `password=…%0A`
# and yield a 401 — unlike openssl's `pass fd:` reader, which trims a trailing NL.
# Username is KEYCLOAK_ADMIN (not a secret), so it stays off-argv too via
# --data-urlencode for correctness.
: "${KEYCLOAK_ADMIN:?KEYCLOAK_ADMIN unset}"
: "${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD unset}"
info "Exporting realm '${realm_name}' (Admin API partial-export) -> realm.json.age ..."
kc_token=$(curl -fsS -X POST \
    "${KC_BASE_URL}/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli \
    --data-urlencode "username=${KEYCLOAK_ADMIN}" \
    --data-urlencode "password@/dev/fd/3" 3< <(printf '%s' "$KEYCLOAK_ADMIN_PASSWORD") \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])') \
    || error "KC admin token request failed"
# URL-encode the registry-controlled realm path segment: a realm_name carrying
# any reserved URL char would otherwise break the Admin-API path or be mis-routed.
# `jq -rR @uri` is the same jq precedent the other KC scripts use.
realm_seg=$(printf '%s' "$realm_name" | jq -rR @uri) \
    || error "failed to URL-encode realm name '${realm_name}'"
# The bearer token is a short-lived but live KC admin credential — it must NEVER
# reach the process table either (curl argv is world-readable via /proc/<pid>/cmdline
# on this SHARED staging host). It is therefore fed to curl OFF-argv via fd 3,
# reusing the SAME fd-3 + process-substitution mechanism as the password above:
# `-H @/dev/fd/3` reads the whole `Authorization: Bearer <token>` header line from
# the fd, so the token appears in no argument vector. Here a herestring (`<<<`) is
# SAFE — unlike curl's `--data-urlencode @file` reader (which encodes the fd content
# verbatim, newline and all), curl's HEADER `@file` reader is line-based and strips
# the herestring's trailing newline, so no stray `%0A` / malformed header.
curl -fsS -X POST \
    "${KC_BASE_URL}/admin/realms/${realm_seg}/partial-export?exportClients=true&exportGroupsAndRoles=true" \
    -H @/dev/fd/3 3<<<"Authorization: Bearer ${kc_token}" \
    -H 'Content-Type: application/json' \
    | encrypt_to "${OUT_DIR}/realm.json.age"

# ── (4) Retention: prune this tenant's bundles older than RETENTION_DAYS ──────
# Each run writes into the slug dir; the dated marker keeps the run auditable.
echo "$DATE" > "${OUT_DIR}/.last-backup"
find "${BACKUP_DIR%/}/tenants" -maxdepth 3 -name '*.age' -type f \
    -mtime "+${RETENTION_DAYS}" -path "*/${slug}/*" -delete 2>/dev/null || true

success "tenant '${slug}' backup complete -> ${OUT_DIR} (run ${DATE})"
info "artifacts: ${slug}.dump.age, realm.json.age"
