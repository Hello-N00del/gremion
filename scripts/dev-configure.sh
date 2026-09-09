#!/usr/bin/env bash
# ============================================================
# Gremion — Dev environment configurator
#
# Run this after `docker compose up -d` to ensure all services
# are correctly configured for the Vite dev server.
#
# What it does:
#   1. Patches gremion-ui/.env.local with correct service URLs
#   2. Configures Keycloak: ensures the gremion-ui client has the
#      correct dev redirect URIs
#   3. Verifies all services are reachable
#
# Usage:
#   ./scripts/dev-configure.sh
#   make dev-configure
# ============================================================

set -euo pipefail
cd "$(dirname "$0")/.."

# ── Port map — SINGLE SOURCE OF TRUTH for local dev ─────────
# All values must match docker-compose.override.yml port bindings.
# Change a port here and the script will fix everything else.
DEV_UI_PORT=4001    # vite dev server (vite.config.ts)
KC_PORT=8082        # keycloak:      127.0.0.1:8082:8080

# ── Colours ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; NC_C='\033[0m'  # NC_C = "no colour" reset

info()    { echo -e "${CYAN}[dev-configure]${NC_C} $*"; }
success() { echo -e "${GREEN}[dev-configure]${NC_C} ✓ $*"; }
warn()    { echo -e "${YELLOW}[dev-configure]${NC_C} ⚠ $*"; }
error()   { echo -e "${RED}[dev-configure]${NC_C} ✗ $*" >&2; exit 1; }

# ── Load root .env ───────────────────────────────────────────
# G-086 (Mediums Cluster 4 / T4.2): the previous pattern called
# `export "$line"` where `$line` was the raw .env line. A hostile or
# accidentally malformed value containing shell metacharacters
# (e.g. `MALICIOUS=$(rm /tmp/proof)`) could trip command substitution
# under certain shells. Replaced with the safe split-on-= pattern
# already used in scripts/backup.sh:54-60: IFS='=' makes the key/value
# split happen INSIDE `read`, the key is whitelist-validated against the
# env-var grammar, and `export "$key=$val"` constructs a literal
# assignment string instead of evaluating user-controlled content.
[[ -f .env ]] || error ".env not found. Run: make setup"
while IFS='=' read -r key val; do
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    val="${val#\"}" val="${val%\"}"
    val="${val#\'}" val="${val%\'}"
    export "$key=$val"
done < <(grep -v '^[[:space:]]*#' .env | grep -v '^[[:space:]]*$')

# ── 1. Patch gremion-ui/.env.local ─────────────────────────────
info "Patching gremion-ui/.env.local with current service URLs..."

ENVLOCAL="gremion-ui/.env.local"

# Set or add a key=value in the .env.local file.
set_env() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$ENVLOCAL" 2>/dev/null; then
        # Portable sed (works on both GNU and BSD/macOS)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENVLOCAL"
        else
            sed -i "s|^${key}=.*|${key}=${value}|" "$ENVLOCAL"
        fi
    else
        echo "${key}=${value}" >> "$ENVLOCAL"
    fi
}

# Create .env.local if it doesn't exist yet
if [[ ! -f "$ENVLOCAL" ]]; then
    warn "$ENVLOCAL not found — creating from root .env..."
    cat > "$ENVLOCAL" << ENVEOF
# Auto-created by scripts/dev-configure.sh
# Service URLs are managed by the script — edit secrets directly.
AUTH_SECRET=${AUTH_SECRET}
AUTH_KEYCLOAK_ID=${AUTH_KEYCLOAK_ID:-gremion-ui}
AUTH_KEYCLOAK_SECRET=${AUTH_KEYCLOAK_SECRET:-}
KEYCLOAK_ADMIN_CLIENT_SECRET=${KEYCLOAK_ADMIN_CLIENT_SECRET:-}
ENVEOF
    # #258-F5: .env.local holds AUTH_SECRET and the Keycloak admin client
    # secret. The heredoc above creates it with the default umask (0644 on
    # umask 022); restrict it to the owner.
    chmod 600 "$ENVLOCAL"
fi

# Apply correct service URLs (always overwrite these)
set_env "AUTH_KEYCLOAK_ISSUER"     "http://localhost:${KC_PORT}/auth/realms/sturaos"
set_env "AUTH_KEYCLOAK_BASE"       "http://localhost:${KC_PORT}/auth/realms/sturaos"
set_env "AUTH_KEYCLOAK_INTERNAL"   "http://localhost:${KC_PORT}/auth/realms/sturaos"
set_env "KEYCLOAK_ADMIN_URL"       "http://localhost:${KC_PORT}/auth"
set_env "PUBLIC_BASE_URL"          "http://localhost:${DEV_UI_PORT}"
# ORIGIN drives the Keycloak post-logout redirect (auth/logout/+page.server.ts).
# Without it, the logout fallback sends users to the docker-compose port 3001
# instead of the Vite dev server at 4001.
set_env "ORIGIN"                   "http://localhost:${DEV_UI_PORT}"

# Postgres — Vite running on the host needs the host-published port (5433),
# not the docker-internal 5432. The docker-compose override exposes it at
# 127.0.0.1:5433. Without it Vite boots into a 500.
if [[ -z "${GREMION_DB_PASSWORD:-}" ]]; then
    error "GREMION_DB_PASSWORD missing in .env. Run: make setup"
fi
set_env "DATABASE_URL"             "postgresql://${GREMION_DB_USER:-gremion}:${GREMION_DB_PASSWORD}@localhost:5433/${GREMION_DB_NAME:-gremion}"

success "gremion-ui/.env.local URLs updated."

# ── 2. Configure Keycloak ─────────────────────────────────────
info "Waiting for Keycloak to be ready at localhost:${KC_PORT}..."
KC_BASE="http://localhost:${KC_PORT}/auth"
ATTEMPTS=0
# /health/ready is unavailable in start-dev mode; use realms endpoint instead
until curl -sf "${KC_BASE}/realms/master" >/dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [[ $ATTEMPTS -ge 24 ]]; then
        warn "Keycloak not reachable after 120s — skipping Keycloak configuration."
        warn "Run this script again once Keycloak is up: make dev-configure"
        exit 0
    fi
    printf "."
    sleep 5
done
echo ""
success "Keycloak is ready."

info "Authenticating with Keycloak admin API..."
# #258-F3: keep the admin password off argv — stage it into a 0600 tempfile, then
# feed it to curl on STDIN and URL-encode it from there
# (--data-urlencode "password@-") instead of expanding it inline. `@-` (stdin) is
# used instead of `@file` because native mingw64 curl on the Windows/Git-Bash
# staging host cannot open a POSIX /tmp path (curl exit 26 → empty token →
# abort). Removed immediately after the call.
KC_PW_FILE=$(mktemp -t kc-admin-pw.XXXXXX)
chmod 600 "$KC_PW_FILE"
printf '%s' "${KEYCLOAK_ADMIN_PASSWORD}" > "$KC_PW_FILE"
TOKEN=$(curl -sf \
    -d "client_id=admin-cli" \
    -d "username=${KEYCLOAK_ADMIN:-admin}" \
    --data-urlencode "password@-" \
    -d "grant_type=password" \
    "${KC_BASE}/realms/master/protocol/openid-connect/token" \
    < "$KC_PW_FILE" \
    | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
rm -f "$KC_PW_FILE"

[[ -z "$TOKEN" ]] && error "Failed to get Keycloak admin token. Check KEYCLOAK_ADMIN_PASSWORD in .env."

# Helper: get the internal UUID of a client by clientId
get_client_uuid() {
    local client_id="$1"
    curl -sf \
        -H "Authorization: Bearer ${TOKEN}" \
        "${KC_BASE}/admin/realms/sturaos/clients?clientId=${client_id}" \
        | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4
}

# Helper: ensure a list of URIs and origins are present on a client
ensure_client_uris() {
    local client_id="$1"
    shift
    local -a required_uris=("$@")

    local uuid
    uuid=$(get_client_uuid "$client_id")
    [[ -z "$uuid" ]] && { warn "Client '${client_id}' not found in Keycloak — skipping."; return; }

    # Fetch current redirect URIs and web origins as JSON arrays (one per line)
    local current_json
    current_json=$(curl -sf \
        -H "Authorization: Bearer ${TOKEN}" \
        "${KC_BASE}/admin/realms/sturaos/clients/${uuid}")

    local current_uris current_origins
    current_uris=$(echo "$current_json" | grep -o '"redirectUris":\[[^]]*\]' | grep -o '"[^"]*"' | tr -d '"')
    current_origins=$(echo "$current_json" | grep -o '"webOrigins":\[[^]]*\]' | grep -o '"[^"]*"' | tr -d '"')

    # Build updated URI + origin arrays (add missing entries)
    local new_uris_json="["
    local new_origins_json="["
    local sep="" osep=""

    # Keep existing entries
    while IFS= read -r uri; do
        [[ -z "$uri" ]] && continue
        new_uris_json+="${sep}\"${uri}\""
        sep=","
    done <<< "$current_uris"

    while IFS= read -r origin; do
        [[ -z "$origin" ]] && continue
        new_origins_json+="${osep}\"${origin}\""
        osep=","
    done <<< "$current_origins"

    # Add required entries if missing
    for uri in "${required_uris[@]}"; do
        if ! echo "$current_uris" | grep -qF "$uri"; then
            new_uris_json+="${sep}\"${uri}\""
            sep=","
            # Derive origin from URI (strip path)
            local origin
            origin=$(echo "$uri" | grep -oE 'https?://[^/]+')
            if ! echo "$current_origins" | grep -qF "$origin"; then
                new_origins_json+="${osep}\"${origin}\""
                osep=","
            fi
        fi
    done

    new_uris_json+="]"
    new_origins_json+="]"

    local http_status
    http_status=$(curl -sf -o /dev/null -w "%{http_code}" \
        -X PUT "${KC_BASE}/admin/realms/sturaos/clients/${uuid}" \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{\"clientId\":\"${client_id}\",\"id\":\"${uuid}\",\"redirectUris\":${new_uris_json},\"webOrigins\":${new_origins_json}}")

    if [[ "$http_status" == "204" ]]; then
        success "Keycloak client '${client_id}': redirect URIs updated."
    else
        warn "Keycloak client '${client_id}': update returned HTTP ${http_status} — may need manual check."
    fi
}

# ── gremion-ui: allow the vite dev server ──────────────────────
info "Ensuring gremion-ui client allows http://localhost:${DEV_UI_PORT}..."
ensure_client_uris "gremion-ui" \
    "http://localhost:${DEV_UI_PORT}/auth/callback/keycloak"

# ── 3. Service reachability check ────────────────────────────
echo ""
info "Checking service reachability..."
check() {
    local name="$1" url="$2"
    if curl -sf --max-time 3 "$url" >/dev/null 2>&1; then
        success "${name}: reachable"
    else
        warn "${name}: NOT reachable at ${url}"
    fi
}

check "Keycloak  (${KC_PORT})"    "http://localhost:${KC_PORT}/auth/realms/master"

echo ""
success "Dev environment configured."
echo ""
echo -e "  Vite dev server:  ${CYAN}cd gremion-ui && npm run dev${NC_C}  →  http://localhost:${DEV_UI_PORT}"
echo -e "  Or use:           ${CYAN}make dev-ui${NC_C}"
echo ""
