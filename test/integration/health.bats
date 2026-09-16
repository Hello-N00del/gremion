#!/usr/bin/env bats
# Integration tests — verifies the governance-kernel services are healthy.
# The kernel ships PostgreSQL + Keycloak (+ legal, the two SvelteKit apps,
# traefik, mailpit, vector). Matrix/Nextcloud/Redis/StuFis are feature-module
# concerns and were carved out, so they are no longer asserted here.
# REQUIRES: docker compose stack running (postgres + keycloak).
# Run: ./test/bats/bin/bats test/integration/health.bats

load '../test_helper/common'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

# Load .env if present. Parsed line-by-line rather than `source`d — .env may
# hold values with spaces that are not valid shell and would spew
# "command not found".
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
    while IFS='=' read -r _key _val; do
        [[ "$_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        _val="${_val#\"}" _val="${_val%\"}"
        _val="${_val#\'}" _val="${_val%\'}"
        export "${_key}=${_val}"
    done < <(grep -vE '^[[:space:]]*(#|$)' "${PROJECT_ROOT}/.env")
fi

# ---------------------------------------------------------------------------
# PostgreSQL
# ---------------------------------------------------------------------------

@test "PostgreSQL is healthy" {
    run docker compose -f "${PROJECT_ROOT}/docker-compose.yml" \
        exec -T postgres pg_isready -U "${POSTGRES_USER:-postgres}"
    [ "$status" -eq 0 ]
}

@test "keycloak database exists in PostgreSQL" {
    run docker compose -f "${PROJECT_ROOT}/docker-compose.yml" \
        exec -T postgres psql -U "${POSTGRES_USER:-postgres}" \
        -tAc "SELECT 1 FROM pg_database WHERE datname='${KEYCLOAK_DB_NAME:-keycloak}'"
    [ "$status" -eq 0 ]
    # `docker compose` may emit unset-variable warnings to stderr, which bats
    # merges into $output; assert on the psql result line, not exact equality.
    [[ "${lines[-1]}" == "1" ]]
}

# ---------------------------------------------------------------------------
# Keycloak
# ---------------------------------------------------------------------------

@test "Keycloak is reachable and serves the master realm (B-01: no boot import)" {
    # The health endpoint lives on the management port (9000), which is not
    # mapped. Check the main API instead. B-01: nothing is imported at boot, so
    # `master` is the one realm a freshly started Keycloak always has.
    run curl -sf http://localhost:8082/auth/realms/master
    [ "$status" -eq 0 ]
    [[ "$output" == *'"realm":"master"'* ]]
}

# ---------------------------------------------------------------------------
# B-01 (spec B §T.4) — no Keycloak in this kernel imports a realm at boot
# ---------------------------------------------------------------------------

@test "no compose file boot-imports a realm (spec B B-01)" {
    cd "$BATS_TEST_DIRNAME/../.."
    run docker compose --env-file .env.example \
        -f docker-compose.yml -f docker-compose.override.yml config
    [ "$status" -eq 0 ]
    [[ "$output" != *"--import-realm"* ]]
    [[ "$output" != *"substitute-realm-secrets"* ]]
    [[ "$output" != *"/opt/keycloak/data/import"* ]]
    [[ "$output" != *"keycloak-init"* ]]
}

@test "the generated realm export is not a tracked git object (spec B B-01)" {
    cd "$BATS_TEST_DIRNAME/../.."
    run git ls-files --error-unmatch docker/keycloak/realm-export.json
    [ "$status" -ne 0 ]
    run git ls-files --error-unmatch docker/keycloak/substitute-realm-secrets.sh
    [ "$status" -ne 0 ]
}
