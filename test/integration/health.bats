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

@test "Keycloak sturaos realm is reachable" {
    # The health endpoint lives on the management port (9000), which is not
    # mapped. Check the main API instead — available only after realm import.
    run curl -sf http://localhost:8082/auth/realms/sturaos
    [ "$status" -eq 0 ]
    [[ "$output" == *'"realm":"sturaos"'* ]]
}
