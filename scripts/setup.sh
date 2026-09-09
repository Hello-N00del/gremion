#!/usr/bin/env bash
# ============================================================
# Gremion — First-run setup script (governance-only kernel)
#
# Usage:  ./scripts/setup.sh
#         make setup
#
# What it does:
#   1. Optionally prompts for a domain (default: localhost)
#   2. Creates .env and legal/legal.env from their .example files
#   3. Generates random secrets for all passwords
#   4. Makes helper scripts executable
#   5. Mints internal TLS certs + regenerates the realm export
#   6. Builds and starts the core services (postgres, keycloak, gremion-ui)
#   7. Waits for gremion-ui to become healthy and prints the app URL
# ============================================================

set -euo pipefail
cd "$(dirname "$0")/.."

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()    { echo -e "${CYAN}[setup]${NC} $*"; }
success() { echo -e "${GREEN}[setup]${NC} $*"; }
warn()    { echo -e "${YELLOW}[setup]${NC} $*"; }
error()   { echo -e "${RED}[setup]${NC} $*" >&2; exit 1; }

# ── Prerequisites ──────────────────────────────────────────
command -v docker >/dev/null 2>&1 || error "Docker is not installed."
docker compose version >/dev/null 2>&1 || error "Docker Compose (v2) is not installed."
command -v openssl >/dev/null 2>&1 || error "openssl is required to generate secrets."

# ── .env file ──────────────────────────────────────────────
# Whether THIS run generated the secrets. The closing summary prints the seeded
# fixture password only when it did: on the skip branch the value in .env came
# from an earlier run (or was never generated), so echoing whatever the file
# happens to hold would either leak an older credential or print an empty
# highlighted blank with no explanation.
ENV_GENERATED=false
if [[ -f .env ]]; then
    warn ".env already exists — skipping generation. Delete it to regenerate."
else
    ENV_GENERATED=true
    # ── Domain prompt ─────────────────────────────────────
    echo ""
    echo -e "${CYAN}Domain configuration${NC}"
    echo -e "  For local development, press Enter to use ${YELLOW}localhost${NC}."
    echo -e "  For a real deployment, enter your domain (e.g. ${YELLOW}stura.example.com${NC})."
    echo ""
    read -r -p "  Domain [localhost]: " INPUT_DOMAIN
    DOMAIN="${INPUT_DOMAIN:-localhost}"

    # Validate domain format (hostname characters only — prevents sed injection)
    if [[ "$DOMAIN" != "localhost" ]]; then
        if ! [[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$ ]]; then
            error "Invalid domain name: '${DOMAIN}'. Use only letters, numbers, hyphens, and dots."
        fi
    fi

    info "Creating .env from .env.example..."
    cp .env.example .env
    # #258-F5: .env holds the Postgres superuser password, Keycloak admin
    # password, AUTH_SECRET, OIDC client secrets and the restic passphrase.
    # On a default umask (022) `cp` creates it 0644 (world-readable); restrict
    # it to the owner before any secret is written in.
    chmod 600 .env

    # Portable sed: macOS (BSD) requires sed -i '' while GNU sed uses sed -i
    _sed() {
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "$@"
        else
            sed -i "$@"
        fi
    }

    # Write domain
    _sed "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|"                                         .env

    # Generate random passwords for all CHANGE_ME placeholders
    info "Generating random secrets..."

    gen() { openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32; }

    _sed "s/CHANGE_ME_postgres_root/$(gen)/"   .env
    _sed "s/CHANGE_ME_keycloak_db/$(gen)/"     .env
    _sed "s/CHANGE_ME_keycloak_admin/$(gen)/"  .env
    _sed "s/CHANGE_ME_gremion_db/$(gen)/"        .env
    # Pillar-2 multi-tenancy: control-plane tenant-registry DB password
    # (CONTROL_DB_PASSWORD, P2.1a) + PgBouncer auth-file password
    # (PGBOUNCER_AUTH_PASSWORD, P2.1b). Each appears once in .env.example.
    _sed "s/CHANGE_ME_control_db/$(gen)/"      .env
    _sed "s/CHANGE_ME_pgbouncer_auth/$(gen)/"  .env

    # gremion_public_reader read-only DB password. Appears twice in .env.example
    # (PUBLIC_DB_PASSWORD and GREMION_PUBLIC_DB_URL) and both must match, so we
    # generate once and replace-all.
    PUBLIC_READER_PW=$(gen)
    _sed "s/CHANGE_ME_public_reader/${PUBLIC_READER_PW}/g" .env

    # Gremion UI — Auth.js secret (session cookie signing)
    AUTH_SECRET=$(openssl rand -hex 32)
    _sed "s|^AUTH_SECRET=.*|AUTH_SECRET=${AUTH_SECRET}|" .env
    _sed "s|^AUTH_KEYCLOAK_ID=.*|AUTH_KEYCLOAK_ID=gremion-ui|" .env

    # Keycloak client secrets — each secret has two aliases in .env that must
    # match (the app-facing var, e.g. AUTH_KEYCLOAK_SECRET, and the realm-export
    # substitution var, e.g. GREMION_UI_OIDC_CLIENT_SECRET; both get swapped into
    # the same Keycloak client at boot by substitute-realm-secrets.sh).
    GREMION_UI_OIDC_SECRET=$(openssl rand -hex 32)
    _sed "s|^AUTH_KEYCLOAK_SECRET=.*|AUTH_KEYCLOAK_SECRET=${GREMION_UI_OIDC_SECRET}|"             .env
    _sed "s|^GREMION_UI_OIDC_CLIENT_SECRET=.*|GREMION_UI_OIDC_CLIENT_SECRET=${GREMION_UI_OIDC_SECRET}|" .env

    GREMION_ADMIN_OIDC_SECRET=$(openssl rand -hex 32)
    _sed "s|^KEYCLOAK_ADMIN_CLIENT_SECRET=.*|KEYCLOAK_ADMIN_CLIENT_SECRET=${GREMION_ADMIN_OIDC_SECRET}|"   .env
    _sed "s|^GREMION_ADMIN_OIDC_CLIENT_SECRET=.*|GREMION_ADMIN_OIDC_CLIENT_SECRET=${GREMION_ADMIN_OIDC_SECRET}|" .env

    # Seed endpoint token + seeded-user password (POST /api/setup/seed)
    _sed "s|^SEED_TOKEN=.*|SEED_TOKEN=$(openssl rand -hex 32)|" .env
    # Seeded test-fixture password. Generated per install like every other
    # secret in this block; the value lands in .env and is printed once in the
    # summary below so the local walkthrough still has a known login for every
    # seeded user. Seed fixtures are a local/demo convenience — never seed them
    # into a real deployment (set GREMION_DISABLE_SEEDS=true there).
    _sed "s|^SEED_USER_PASSWORD=.*|SEED_USER_PASSWORD=$(gen)|" .env

    # G-075: shared secret for internal gremion-ui HTTP calls (the server-only
    # internalFetch helper authenticates same-app requests via
    # Authorization: Bearer ${INTERNAL_PUSH_SECRET}). 32 hex bytes = 256 bits.
    _sed "s/CHANGE_ME_internal_push_secret/$(openssl rand -hex 32)/" .env

    # restic backup repository encryption passphrase
    _sed "s|^RESTIC_PASSWORD=.*|RESTIC_PASSWORD=$(gen)|" .env

    # Verify all placeholders were replaced
    if grep -q 'CHANGE_ME_' .env; then
        error "Some CHANGE_ME_ placeholders were not replaced in .env. Check sed compatibility."
    fi

    success ".env created with random secrets (domain: ${DOMAIN})."
fi

# ── legal/legal.env ────────────────────────────────────────
# MUST run before the first `docker compose` call below: docker-compose.yml
# loads this file with `env_file`, and compose treats a missing env_file as a
# hard error while parsing the WHOLE project — so without it `docker compose
# build` aborts (set -e) and this script could never reach a creation block
# placed after it. It also makes every check built on a compose render (make
# lint, pnpm -C gremion-ui check) fail confusingly on a fresh clone. It holds no
# secrets, only the imprint/contact strings, so seeding it from the example is safe.
if [[ -f legal/legal.env ]]; then
    warn "legal/legal.env already exists — leaving it alone."
else
    info "Creating legal/legal.env from legal/legal.env.example..."
    cp legal/legal.env.example legal/legal.env
    warn "legal/legal.env holds placeholder imprint data — fill it in before going live."
fi

# ── Script permissions ─────────────────────────────────────
chmod +x scripts/*.sh
chmod +x docker/postgres/init-databases.sh

# ── G-080: internal TLS certificates ───────────────────────
# Mint the internal CA + Keycloak server cert (SAN keycloak,localhost,127.0.0.1)
# so the prod overlay's keycloak:8443 HTTPS listener and the gremion-ui CA trust
# have files to bind-mount. Idempotent: no-ops if the certs already exist. The
# dev stack (base + override) runs plain http on :8080 and does not require
# these, but generating them up front is harmless and keeps prod ready.
info "Ensuring internal TLS certificates (G-080)..."
bash docker/keycloak/certs/gen-internal-ca.sh

# ── Keycloak realm export (Pillar-1 P0.2) ──────────────────
# Keycloak imports docker/keycloak/realm-export.json at container start, so the
# file must exist BEFORE compose up. It is generated from realm-export.base.json
# + the enabled modules' realm fragments, gated by a vertical's config.json
# (modules.<id> = true/false). The governance-only kernel ships no feature
# modules, so the committed realm-export.json equals the base realm (gremion-ui +
# gremion-admin clients only); we only regenerate when a config is actually
# supplied (CONFIG_PATH or config/config.json). The generator reads CONFIG_PATH
# from the environment directly.
CONFIG_PATH="${CONFIG_PATH:-}"
if [[ -n "$CONFIG_PATH" && -f "$CONFIG_PATH" ]]; then
    info "Generating realm-export.json from module manifests (config: ${CONFIG_PATH})..."
    pnpm -C gremion-ui exec tsx scripts/gen-realm-export.ts
elif [[ -f config/config.json ]]; then
    info "Generating realm-export.json from module manifests (config: config/config.json)..."
    CONFIG_PATH=config/config.json pnpm -C gremion-ui exec tsx scripts/gen-realm-export.ts
else
    info "No config.json found — using the committed governance-only realm-export.json."
fi
test -f docker/keycloak/realm-export.json \
    || error "realm-export.json is missing; Keycloak will fail to import its realm."

# ── Build & start ──────────────────────────────────────────
info "Building images..."
docker compose build --quiet

info "Starting core services (postgres, keycloak, gremion-ui)..."
docker compose up -d postgres keycloak gremion-ui

# ── Wait for gremion-ui ──────────────────────────────────────
# postgres + keycloak come up first (compose depends_on with
# condition: service_healthy gates gremion-ui), so waiting on gremion-ui's
# health implicitly confirms the IdP and database are ready too.
info "Waiting for gremion-ui to become healthy (this takes ~60–90s on first run)..."
ATTEMPTS=0
MAX=36
until [[ "$(docker compose ps -q gremion-ui | xargs -r docker inspect -f '{{.State.Health.Status}}' 2>/dev/null)" == "healthy" ]]; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [[ $ATTEMPTS -ge $MAX ]]; then
        warn "gremion-ui health check timed out. Run 'make logs SERVICE=gremion-ui' to investigate."
        break
    fi
    printf "."
    sleep 5
done
echo ""

# ── Print summary ──────────────────────────────────────────
CONFIGURED_DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)

echo ""
success "════════════════════════════════════════════════════"
success "  Gremion governance kernel is running!"
success "════════════════════════════════════════════════════"
if [[ "$CONFIGURED_DOMAIN" == "localhost" ]]; then
    echo -e "  App:       ${CYAN}http://localhost:3001${NC}"
    echo -e "  Keycloak:  ${CYAN}http://localhost:8082/auth${NC}"
else
    echo -e "  App:       ${CYAN}https://${CONFIGURED_DOMAIN}${NC}"
    echo -e "  Keycloak:  ${CYAN}https://${CONFIGURED_DOMAIN}/auth${NC}"
fi
echo ""
echo -e "  All credentials are stored in ${YELLOW}.env${NC} — keep it safe!"
echo ""
echo -e "  Next steps:"
echo -e "    Seed an org:  ${YELLOW}POST /api/setup/seed${NC} (token in .env: SEED_TOKEN)"
if [[ "$ENV_GENERATED" == true ]]; then
    # `|| true`: a failed grep inside a command substitution would abort the
    # whole script under `set -e` after everything already came up.
    SEED_PW=$(grep '^SEED_USER_PASSWORD=' .env | cut -d= -f2- || true)
    if [[ -n "$SEED_PW" && "$SEED_PW" != CHANGE_ME* ]]; then
        echo -e "    Seeded fixture users (e.g. dev.admin) all share the generated password"
        echo -e "                  ${YELLOW}${SEED_PW}${NC}  (also in .env: SEED_USER_PASSWORD)"
    else
        warn "    SEED_USER_PASSWORD is missing from .env — seeded fixture users will have no known login."
    fi
else
    echo -e "    Seeded fixture users share the password already in your .env; read it with"
    echo -e "                  ${YELLOW}grep '^SEED_USER_PASSWORD=' .env${NC}"
fi
echo -e "    Full guide:   ${YELLOW}docs/LOCAL_TESTING.md${NC}"
echo ""
