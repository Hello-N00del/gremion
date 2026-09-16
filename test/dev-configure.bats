#!/usr/bin/env bats
# B-01 (spec B T.4): scripts/dev-configure.sh addresses the dev realm through
# KEYCLOAK_REALM, defaulting to `gremion`. The default must be resolved AFTER
# the root .env is loaded: resolved before, `KEYCLOAK_REALM` in .env is a no-op
# and the script silently rewrites gremion-ui/.env.local's OIDC issuer to a
# realm the developer did not choose - a wrong value written confidently, which
# is worse than a missing one.
#
# Run: bats test/dev-configure.bats

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
SCRIPT="${PROJECT_ROOT}/scripts/dev-configure.sh"

@test "the KEYCLOAK_REALM default is resolved after the root .env is loaded" {
    local assign_line env_line
    assign_line=$(grep -n '^KC_REALM=' "$SCRIPT" | head -1 | cut -d: -f1)
    env_line=$(grep -n 'done < <(grep -v ' "$SCRIPT" | head -1 | cut -d: -f1)
    [ -n "$assign_line" ]
    [ -n "$env_line" ]
    echo "# KC_REALM= at line ${assign_line}, .env load ends at line ${env_line}" >&3
    [ "$assign_line" -gt "$env_line" ]
}

@test "every Keycloak Admin API path in dev-configure.sh names the realm variable" {
    local literals
    literals=$(grep -n 'admin/realms/' "$SCRIPT" | grep -v '${KC_REALM}' || true)
    [ -z "$literals" ]
}

@test "the issuer URLs it writes name the realm variable, never a literal realm" {
    # `realms/master` is the one legitimate literal: B-01 leaves `master` as the
    # only realm a fresh Keycloak has, and the reachability probe targets it.
    local literals
    literals=$(grep -n 'auth/realms/' "$SCRIPT" | grep -v '${KC_REALM}' | grep -v 'auth/realms/master' || true)
    [ -z "$literals" ]
}
