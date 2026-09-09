#!/usr/bin/env bats
# Tests for scripts/configure-keycloak-clients.sh
# Run: ./test/bats/bin/bats test/configure-keycloak.bats

load 'test_helper/common'

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
KC_SCRIPT="${PROJECT_ROOT}/scripts/configure-keycloak-clients.sh"

setup() {
    setup_temp_dir
}

teardown() {
    teardown_temp_dir
}

# ---------------------------------------------------------------------------
# Script structure
# ---------------------------------------------------------------------------

@test "configure-keycloak-clients.sh exists" {
    [[ -f "$KC_SCRIPT" ]]
}

@test "configure-keycloak-clients.sh is executable" {
    [[ -x "$KC_SCRIPT" ]]
}

@test "configure-keycloak-clients.sh has strict mode set" {
    grep -q "set -euo pipefail" "$KC_SCRIPT"
}

# ---------------------------------------------------------------------------
# Keycloak endpoint logic (static analysis)
# ---------------------------------------------------------------------------

@test "script waits for Keycloak health endpoint" {
    grep -qE "health|ready|/auth/health" "$KC_SCRIPT"
}

@test "script obtains admin token before API calls" {
    grep -qE "access_token|token.*admin|admin.*token" "$KC_SCRIPT"
}

@test "script uses KEYCLOAK_ADMIN_PASSWORD from environment" {
    grep -q "KEYCLOAK_ADMIN_PASSWORD" "$KC_SCRIPT"
}

@test "script uses the stura realm" {
    grep -q "stura" "$KC_SCRIPT"
}

@test "script has retry/wait loop for Keycloak startup" {
    grep -qE "sleep|retry|attempt|ATTEMPTS|until|while" "$KC_SCRIPT"
}

@test "script does not hardcode credentials" {
    ! grep -qE 'password="[^$]|secret="[^$]' "$KC_SCRIPT"
}

# ---------------------------------------------------------------------------
# Keycloak realm export validation
# ---------------------------------------------------------------------------

@test "realm-export.json is valid JSON" {
    python3 -m json.tool \
        "${PROJECT_ROOT}/docker/keycloak/realm-export.json" > /dev/null
}

@test "realm-export.json sslRequired is parametrized, defaulting to 'all' (G-080 internal TLS)" {
    # G-080 ADDRESSED: Keycloak serves an internal TLS listener on keycloak:8443
    # (docker-compose.prod.yml; cert minted by docker/keycloak/certs/gen-internal-ca.sh),
    # the one live internal caller (gremion-ui) reaches it over https + NODE_EXTRA_CA_CERTS,
    # and Helios/Nextcloud/Synapse already ride the PUBLIC https issuer. The realm
    # therefore enforces sslRequired="all" in prod/staging.
    #
    # The value is parametrized via __SSL_REQUIRED__ (substituted by
    # substitute-realm-secrets.sh from KC_REALM_SSL_REQUIRED) so the dev stack can
    # keep "external" for local http://localhost:8082 login without per-dev cert
    # trust. This test pins the secure-by-default posture against silent regression:
    #   1. the realm template is parametrized, not a hardcoded value;
    #   2. the base compose defaults KC_REALM_SSL_REQUIRED to "all";
    #   3. only the dev override relaxes it to "external".
    grep -qF '"sslRequired": "__SSL_REQUIRED__"' "${PROJECT_ROOT}/docker/keycloak/realm-export.json"
    grep -qF 'KC_REALM_SSL_REQUIRED: ${KC_REALM_SSL_REQUIRED:-all}' "${PROJECT_ROOT}/docker-compose.yml"
    grep -qF 'KC_REALM_SSL_REQUIRED: "external"' "${PROJECT_ROOT}/docker-compose.override.yml"
}

# ---------------------------------------------------------------------------
# Step-up 2FA realm export validation (#164)
# These assertions verify that realm-export.json carries the LoA step-up
# configuration needed for fresh installs.  They mirror what a live KC would
# expose at GET /admin/realms/sturaos and
# GET /admin/realms/sturaos/authentication/flows — but run against the source
# file so they pass in CI without a running Keycloak.
# ---------------------------------------------------------------------------

@test "realm-export.json otpPolicyType is totp (#164 step-up)" {
    # Mirrors: GET /admin/realms/sturaos  ->  .otpPolicyType == "totp"
    python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    realm = json.load(f)
assert realm.get("otpPolicyType") == "totp", \
    "realm.otpPolicyType must be \"totp\" for step-up 2FA (#164)"
' "${PROJECT_ROOT}/docker/keycloak/realm-export.json"
}

@test "realm-export.json has browser-stepup authentication flow (#164 step-up)" {
    # Mirrors: GET /admin/realms/sturaos/authentication/flows
    #   ->  any(.alias == "browser-stepup")
    python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    realm = json.load(f)
flows = realm.get("authenticationFlows", [])
aliases = [f["alias"] for f in flows]
assert "browser-stepup" in aliases, \
    "authenticationFlows must contain alias \"browser-stepup\" (#164)"
' "${PROJECT_ROOT}/docker/keycloak/realm-export.json"
}
