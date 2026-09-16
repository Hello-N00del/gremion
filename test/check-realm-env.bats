#!/usr/bin/env bats
# Tests for scripts/check-realm-env.sh — the B-01 realm-agreement guard.
#
# Two variables name ONE realm: KEYCLOAK_REALM (what dev/ops scripts hand the
# Keycloak Admin API) and the `/realms/<name>` segment of AUTH_KEYCLOAK_ISSUER
# (what gremion-ui authenticates against, and what registerDefaultTenant
# derives tenant #1's realm_name from). Nothing compared them: B-01 started
# shipping KEYCLOAK_REALM SET in .env.example, so an operator who renames the
# realm the documented way — by editing the issuer — leaves the two pointing at
# different realms. The failure is silent, and it is a WRITE:
# configure-keycloak-clients.sh resets the confidential client secrets on the
# realm KEYCLOAK_REALM names while every login goes to the issuer's realm.
#
# Run: bats test/check-realm-env.bats

load 'test_helper/common'

GUARD="${SCRIPTS_DIR}/check-realm-env.sh"

setup() {
    setup_temp_dir
}

teardown() {
    teardown_temp_dir
}

@test "check-realm-env.sh exists and is executable" {
    [[ -f "$GUARD" ]]
    [[ -x "$GUARD" ]]
}

# ── environment mode ───────────────────────────────────────────────────────

@test "agreeing realm and issuer pass" {
    run env KEYCLOAK_REALM=gremion \
        AUTH_KEYCLOAK_ISSUER=http://keycloak:8080/auth/realms/gremion \
        bash "$GUARD"
    [ "$status" -eq 0 ]
}

@test "a disagreeing realm and issuer FAIL and the message names BOTH realms" {
    run env KEYCLOAK_REALM=gremion \
        AUTH_KEYCLOAK_ISSUER=https://council.example/auth/realms/council \
        bash "$GUARD"
    [ "$status" -ne 0 ]
    [[ "$output" == *"gremion"* ]]
    [[ "$output" == *"council"* ]]
    [[ "$output" == *"KEYCLOAK_REALM"* ]]
    [[ "$output" == *"AUTH_KEYCLOAK_ISSUER"* ]]
}

@test "an unset KEYCLOAK_REALM passes — the issuer is then the only source of truth" {
    run env -u KEYCLOAK_REALM \
        AUTH_KEYCLOAK_ISSUER=https://council.example/auth/realms/council \
        bash "$GUARD"
    [ "$status" -eq 0 ]
}

@test "an empty KEYCLOAK_REALM passes — an empty value names no realm" {
    run env KEYCLOAK_REALM= \
        AUTH_KEYCLOAK_ISSUER=https://council.example/auth/realms/council \
        bash "$GUARD"
    [ "$status" -eq 0 ]
}

@test "a non-Keycloak-shaped issuer passes — KEYCLOAK_REALM is then a real override" {
    run env KEYCLOAK_REALM=gremion \
        AUTH_KEYCLOAK_ISSUER=https://idp.example/oauth2 \
        bash "$GUARD"
    [ "$status" -eq 0 ]
}

@test "an unset AUTH_KEYCLOAK_ISSUER passes — registerDefaultTenant already fails loudly on that" {
    run env -u AUTH_KEYCLOAK_ISSUER KEYCLOAK_REALM=gremion bash "$GUARD"
    [ "$status" -eq 0 ]
}

@test "a trailing slash on the issuer does not fake a disagreement" {
    run env KEYCLOAK_REALM=gremion \
        AUTH_KEYCLOAK_ISSUER=http://keycloak:8080/auth/realms/gremion/ \
        bash "$GUARD"
    [ "$status" -eq 0 ]
}

@test "quoted values in the environment are compared by value, not by quoting" {
    run env KEYCLOAK_REALM=' gremion ' \
        AUTH_KEYCLOAK_ISSUER=http://keycloak:8080/auth/realms/gremion \
        bash "$GUARD"
    [ "$status" -eq 0 ]
}

# ── env-file mode ──────────────────────────────────────────────────────────

@test "env-file mode FAILS on a .env whose two realms disagree" {
    cat > "${TEST_TEMP_DIR}/.env" <<'ENVEOF'
KEYCLOAK_REALM=gremion
AUTH_KEYCLOAK_ISSUER=http://keycloak:8080/auth/realms/council
ENVEOF
    run env -u KEYCLOAK_REALM -u AUTH_KEYCLOAK_ISSUER bash "$GUARD" "${TEST_TEMP_DIR}/.env"
    [ "$status" -ne 0 ]
    [[ "$output" == *"council"* ]]
}

@test "env-file mode passes on a .env whose two realms agree" {
    cat > "${TEST_TEMP_DIR}/.env" <<'ENVEOF'
KEYCLOAK_REALM=gremion
AUTH_KEYCLOAK_ISSUER=http://keycloak:8080/auth/realms/gremion
ENVEOF
    run env -u KEYCLOAK_REALM -u AUTH_KEYCLOAK_ISSUER bash "$GUARD" "${TEST_TEMP_DIR}/.env"
    [ "$status" -eq 0 ]
}

@test "env-file mode reads the LAST assignment, the way a shell would" {
    # A duplicated key is what a hand-edited .env looks like after an operator
    # appends a correction. `grep -m1` would read the stale first line and clear
    # a file that is actually consistent — or pass one that is not.
    cat > "${TEST_TEMP_DIR}/.env" <<'ENVEOF'
KEYCLOAK_REALM=stale
AUTH_KEYCLOAK_ISSUER=http://keycloak:8080/auth/realms/gremion
KEYCLOAK_REALM=gremion
ENVEOF
    run env -u KEYCLOAK_REALM -u AUTH_KEYCLOAK_ISSUER bash "$GUARD" "${TEST_TEMP_DIR}/.env"
    [ "$status" -eq 0 ]
    cat > "${TEST_TEMP_DIR}/.env2" <<'ENVEOF'
KEYCLOAK_REALM=gremion
AUTH_KEYCLOAK_ISSUER=http://keycloak:8080/auth/realms/gremion
KEYCLOAK_REALM=drifted
ENVEOF
    run env -u KEYCLOAK_REALM -u AUTH_KEYCLOAK_ISSUER bash "$GUARD" "${TEST_TEMP_DIR}/.env2"
    [ "$status" -ne 0 ]
    [[ "$output" == *"drifted"* ]]
}

@test "env-file mode ignores commented-out assignments" {
    cat > "${TEST_TEMP_DIR}/.env" <<'ENVEOF'
# KEYCLOAK_REALM=drifted
KEYCLOAK_REALM=gremion
AUTH_KEYCLOAK_ISSUER=http://keycloak:8080/auth/realms/gremion
ENVEOF
    run env -u KEYCLOAK_REALM -u AUTH_KEYCLOAK_ISSUER bash "$GUARD" "${TEST_TEMP_DIR}/.env"
    [ "$status" -eq 0 ]
}

@test "env-file mode strips surrounding quotes before comparing" {
    cat > "${TEST_TEMP_DIR}/.env" <<'ENVEOF'
KEYCLOAK_REALM="gremion"
AUTH_KEYCLOAK_ISSUER='http://keycloak:8080/auth/realms/gremion'
ENVEOF
    run env -u KEYCLOAK_REALM -u AUTH_KEYCLOAK_ISSUER bash "$GUARD" "${TEST_TEMP_DIR}/.env"
    [ "$status" -eq 0 ]
}

@test "a missing env file is a fatal error, not a silent pass" {
    run bash "$GUARD" "${TEST_TEMP_DIR}/does-not-exist.env"
    [ "$status" -ne 0 ]
    [[ "$output" == *"does-not-exist.env"* ]]
}

# ── the shipped defaults are themselves consistent ─────────────────────────

@test "the committed .env.example passes its own guard" {
    run env -u KEYCLOAK_REALM -u AUTH_KEYCLOAK_ISSUER \
        bash "$GUARD" "${PROJECT_ROOT}/.env.example"
    [ "$status" -eq 0 ]
}

# ── the callers actually call it ───────────────────────────────────────────

@test "configure-keycloak-clients.sh runs the guard before it writes any secret" {
    # Post-condition, not a grep for the word: the guard call must come BEFORE
    # the first Admin-API write (the client-secret PUT).
    guard_line=$(grep -n 'check-realm-env.sh' "${SCRIPTS_DIR}/configure-keycloak-clients.sh" | head -1 | cut -d: -f1)
    [ -n "$guard_line" ]
    write_line=$(grep -nE '^\s*-X PUT|"?\$\{?KC_BASE' "${SCRIPTS_DIR}/configure-keycloak-clients.sh" | grep -n 'PUT' | head -1 | cut -d: -f1)
    put_line=$(grep -n -- '-X PUT' "${SCRIPTS_DIR}/configure-keycloak-clients.sh" | head -1 | cut -d: -f1)
    [ -n "$put_line" ]
    [ "$guard_line" -lt "$put_line" ]
}

@test "make validate-env runs the guard" {
    grep -q 'check-realm-env.sh' "${PROJECT_ROOT}/Makefile"
}
