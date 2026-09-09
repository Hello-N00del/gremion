#!/usr/bin/env bats
# Integration tests — verifies OIDC/SSO wiring for the governance kernel.
# Only the kernel's own Keycloak posture is asserted; module OIDC clients
# (nextcloud, helios, synapse, …) were carved out.
# REQUIRES: postgres + keycloak running.
# Run: ./test/bats/bin/bats test/integration/oidc.bats

load '../test_helper/common'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"

KEYCLOAK_URL="http://localhost:8082/auth"
REALM="sturaos"

# ---------------------------------------------------------------------------
# Keycloak discovery document
# ---------------------------------------------------------------------------

@test "Keycloak discovery endpoint returns valid JSON" {
    run curl -sf "${KEYCLOAK_URL}/realms/${REALM}/.well-known/openid-configuration"
    [ "$status" -eq 0 ]
    echo "$output" | python3 -m json.tool > /dev/null
}

@test "Keycloak discovery issuer uses localhost:8082 (not keycloak:8080)" {
    local discovery
    discovery=$(curl -sf "${KEYCLOAK_URL}/realms/${REALM}/.well-known/openid-configuration")
    [[ "$discovery" == *'"issuer":"http://localhost:8082'* ]]
}

@test "Keycloak authorization_endpoint uses localhost:8082" {
    local discovery
    discovery=$(curl -sf "${KEYCLOAK_URL}/realms/${REALM}/.well-known/openid-configuration")
    [[ "$discovery" == *'"authorization_endpoint":"http://localhost:8082'* ]]
}

@test "Keycloak token_endpoint is present" {
    local discovery
    discovery=$(curl -sf "${KEYCLOAK_URL}/realms/${REALM}/.well-known/openid-configuration")
    [[ "$discovery" == *"token_endpoint"* ]]
}

# ---------------------------------------------------------------------------
# Keycloak realm security posture
# ---------------------------------------------------------------------------

@test "Keycloak CSP narrows frame-ancestors to self + the deployment apex (G-035)" {
    # The realm template carries the apex host as the __APEX_DOMAIN__ sentinel,
    # which substitute-realm-secrets.sh resolves from DOMAIN at Keycloak boot.
    # What G-035 asserts is the SHAPE: frame-ancestors is narrowed to self plus
    # that one host, and is never widened to a wildcard.
    local realm="${PROJECT_ROOT}/docker/keycloak/realm-export.json"
    grep -q "frame-ancestors 'self' https://__APEX_DOMAIN__" "$realm"
    ! grep -q "frame-ancestors 'self' [*]" "$realm"
}

@test "docker-compose.override.yml sets KC_HOSTNAME for browser-accessible redirects" {
    grep -q "KC_HOSTNAME" \
        "${PROJECT_ROOT}/docker-compose.override.yml"
}
