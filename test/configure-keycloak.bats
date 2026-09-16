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
# Keycloak realm TEMPLATE validation
#
# B-01 (spec B T.4): nothing is imported at boot and docker/keycloak/
# realm-export.json is no longer a tracked file - it is a gitignored generator
# output. The tracked, single-copy artefact these assertions own is the
# per-tenant TEMPLATE realm-export.base.json, whose only consumer is
# buildTenantRealmDoc.
# ---------------------------------------------------------------------------

@test "realm-export.base.json is valid JSON" {
    python3 -m json.tool \
        "${PROJECT_ROOT}/docker/keycloak/realm-export.base.json" > /dev/null
}

@test "realm-export.base.json sslRequired is parametrized and the provisioner pins 'all' (G-080 internal TLS)" {
    # G-080 ADDRESSED: Keycloak serves an internal TLS listener on keycloak:8443
    # (docker-compose.prod.yml; cert minted by docker/keycloak/certs/gen-internal-ca.sh),
    # the one live internal caller (gremion-ui) reaches it over https + NODE_EXTRA_CA_CERTS,
    # and Helios/Nextcloud/Synapse already ride the PUBLIC https issuer. The realm
    # therefore enforces sslRequired="all" in prod/staging.
    #
    # B-01: the boot-time substitution step is deleted, and with it the
    # KC_REALM_SSL_REQUIRED compose knob that fed it. The template still carries
    # the __SSL_REQUIRED__ sentinel and buildTenantRealmDoc is what resolves it -
    # it stamps sslRequired:'all' on EVERY provisioned realm (#139), so the
    # secure-by-default posture is now unconditional rather than env-driven.
    # This test pins both halves against silent regression:
    #   1. the realm template is parametrized, not a hardcoded value;
    #   2. the provisioner pins 'all' on the composed per-tenant realm.
    grep -qF '"sslRequired": "__SSL_REQUIRED__"' "${PROJECT_ROOT}/docker/keycloak/realm-export.base.json"
    grep -qF "composed.sslRequired = 'all'" \
        "${PROJECT_ROOT}/gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts"
}

# ---------------------------------------------------------------------------
# Step-up 2FA realm template validation (#164)
# These assertions verify that realm-export.base.json carries the LoA step-up
# configuration needed for fresh installs.  They mirror what a live KC would
# expose at GET /admin/realms/<realm> and
# GET /admin/realms/<realm>/authentication/flows — but run against the source
# file so they pass in CI without a running Keycloak.
# ---------------------------------------------------------------------------

@test "realm-export.base.json otpPolicyType is totp (#164 step-up)" {
    # Mirrors: GET /admin/realms/<realm>  ->  .otpPolicyType == "totp"
    python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    realm = json.load(f)
assert realm.get("otpPolicyType") == "totp", \
    "realm.otpPolicyType must be \"totp\" for step-up 2FA (#164)"
' "${PROJECT_ROOT}/docker/keycloak/realm-export.base.json"
}

@test "realm-export.base.json has browser-stepup authentication flow (#164 step-up)" {
    # Mirrors: GET /admin/realms/<realm>/authentication/flows
    #   ->  any(.alias == "browser-stepup")
    python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    realm = json.load(f)
flows = realm.get("authenticationFlows", [])
aliases = [f["alias"] for f in flows]
assert "browser-stepup" in aliases, \
    "authenticationFlows must contain alias \"browser-stepup\" (#164)"
' "${PROJECT_ROOT}/docker/keycloak/realm-export.base.json"
}
