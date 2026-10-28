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

@test "script requires KEYCLOAK_REALM rather than hardcoding a realm" {
    # B-01: there is no single boot realm any more, so the script MUST be told
    # which realm it is configuring. An unset value is fatal, not defaulted.
    grep -q 'REALM="${KEYCLOAK_REALM:?' "$KC_SCRIPT"
    ! grep -qE '^REALM="[a-z]' "$KC_SCRIPT"
}

@test "script has retry/wait loop for Keycloak startup" {
    grep -qE "sleep|retry|attempt|ATTEMPTS|until|while" "$KC_SCRIPT"
}

@test "script does not hardcode credentials" {
    ! grep -qE 'password="[^$]|secret="[^$]' "$KC_SCRIPT"
}

# ---------------------------------------------------------------------------
# Behaviour against a stateful stand-in for the Keycloak Admin API
# (F1-FIX-09: K6#4 token failure, K6#5 half-built step-up flow, K6#30 service
# account privilege). test/fixtures/fake-kc-curl is installed as `curl`; it models
# curl's -f contract (a failed request prints nothing, exit 22) and keeps the
# realm state in $KCSTATE so the script's own reads see its own writes.
# ---------------------------------------------------------------------------

kc_tree() {
    TREE="${TEST_TEMP_DIR}/tree"
    mkdir -p "${TREE}/scripts" "${TREE}/bin" "${TREE}/tmp"
    cp "$KC_SCRIPT" "${PROJECT_ROOT}/scripts/check-realm-env.sh" "${TREE}/scripts/"
    printf 'KEYCLOAK_ADMIN=admin\nKEYCLOAK_ADMIN_PASSWORD=fixture-admin-password\nKEYCLOAK_REALM=gremion-test\n' > "${TREE}/.env"
    cp "${PROJECT_ROOT}/test/fixtures/fake-kc-curl" "${TREE}/bin/curl"
    printf '#!/usr/bin/env bash\nexit 0\n' > "${TREE}/bin/docker"
    chmod +x "${TREE}/bin/curl" "${TREE}/bin/docker"
    KCSTATE="${TEST_TEMP_DIR}/kc"
    mkdir -p "$KCSTATE"
    export KCSTATE
    export PATH="${TREE}/bin:${PATH}"
    # the script stages the admin password under $TMPDIR; a leftover is a leak
    export TMPDIR="${TREE}/tmp"
}

kc_configure() { run bash "${TREE}/scripts/configure-keycloak-clients.sh"; }

seed_complete_flow() {
    printf '[{"id":"flow-1","alias":"browser-stepup"}]' > "${KCSTATE}/flows.json"
    printf '%s' '[{"id":"f1","displayName":"stepup-1fa","requirement":"CONDITIONAL"},{"id":"f2","displayName":"stepup-2fa","requirement":"CONDITIONAL"}]' > "${KCSTATE}/top-execs.json"
}

seed_partial_flow() {   # the build died after the first subflow
    printf '[{"id":"flow-1","alias":"browser-stepup"}]' > "${KCSTATE}/flows.json"
    printf '%s' '[{"id":"f1","displayName":"stepup-1fa","requirement":"CONDITIONAL"}]' > "${KCSTATE}/top-execs.json"
}

call_line() {   # <grep -E pattern> -> the first matching line number in calls.log, or empty
    grep -nE "$1" "${KCSTATE}/calls.log" | head -n1 | cut -d: -f1 || true
}

@test "a failed admin-token request is reported by name and leaves no password file (K6#4)" {
    kc_tree
    FAKE_KC_TOKEN_FAIL=1 kc_configure
    [ "$status" -ne 0 ]
    [[ "$output" == *"Failed to obtain admin token"* ]]
    # nothing was sent to the admin API without a token, and the staged password is gone
    run grep -c '/admin/' "${KCSTATE}/calls.log"
    [ "$output" = "0" ]
    run ls "${TREE}/tmp"
    [[ "$output" != *"kc-admin-pw"* ]]
}

@test "the admin password file is removed on a successful run too" {
    kc_tree
    seed_complete_flow
    kc_configure
    [ "$status" -eq 0 ]
    run ls "${TREE}/tmp"
    [[ "$output" != *"kc-admin-pw"* ]]
    [[ "$output" != *"kcadm-pw"* ]]
}

@test "the gremion-admin service account gets least-privilege realm-management roles, never realm-admin (K6#30)" {
    kc_tree
    seed_complete_flow
    kc_configure
    [ "$status" -eq 0 ]
    local granted
    granted="$(sort -u "${KCSTATE}/granted.json" | tr '\n' ' ')"
    [ "$granted" = "manage-users query-groups query-users view-realm view-users " ]
    run grep -c 'realm-admin' "${KCSTATE}/granted.json"
    [ "$output" = "0" ]
}

@test "an earlier realm-admin grant is narrowed on re-run (K6#30)" {
    kc_tree
    seed_complete_flow
    printf '[{"id":"role-realm-admin","name":"realm-admin"}]' > "${KCSTATE}/sa-mappings.json"
    kc_configure
    [ "$status" -eq 0 ]
    grep -qx 'realm-admin' "${KCSTATE}/revoked.json"
}

@test "no revoke call is made when the service account never had realm-admin" {
    kc_tree
    seed_complete_flow
    kc_configure
    [ "$status" -eq 0 ]
    [ ! -e "${KCSTATE}/revoked.json" ]
}

@test "KEYCLOAK_ADMIN_SA_ROLES=realm-admin is honoured and not revoked again" {
    kc_tree
    seed_complete_flow
    printf '[{"id":"role-realm-admin","name":"realm-admin"}]' > "${KCSTATE}/sa-mappings.json"
    KEYCLOAK_ADMIN_SA_ROLES=realm-admin kc_configure
    [ "$status" -eq 0 ]
    grep -qx 'realm-admin' "${KCSTATE}/granted.json"
    [ ! -e "${KCSTATE}/revoked.json" ]
}

@test "step-up: an absent flow is built, read back, and only then wired in" {
    kc_tree
    kc_configure
    [ "$status" -eq 0 ]
    [ -n "$(call_line 'POST /admin/realms/gremion-test/authentication/flows/browser/copy')" ]
    [ -z "$(call_line 'DELETE /admin/realms/gremion-test/authentication/flows/')" ]
    # the realm is pointed at the flow AFTER it was built
    [ "$(call_line 'authentication/flows/browser/copy')" -lt "$(call_line 'PUT /admin/realms/gremion-test .*browserFlow')" ]
}

@test "step-up: a complete flow is left alone (no copy, no delete)" {
    kc_tree
    seed_complete_flow
    kc_configure
    [ "$status" -eq 0 ]
    [[ "$output" == *"already present and complete"* ]]
    [ -z "$(call_line 'authentication/flows/browser/copy')" ]
    [ -z "$(call_line 'DELETE /admin/realms/gremion-test/authentication/flows/')" ]
}

@test "step-up: a half-built flow is removed and rebuilt, not treated as done (K6#5)" {
    kc_tree
    seed_partial_flow
    kc_configure
    [ "$status" -eq 0 ]
    [[ "$output" == *"INCOMPLETE"* ]]
    [[ "$output" != *"already present and complete"* ]]
    local del copy
    del="$(call_line 'DELETE /admin/realms/gremion-test/authentication/flows/flow-1')"
    copy="$(call_line 'POST /admin/realms/gremion-test/authentication/flows/browser/copy')"
    [ -n "$del" ]
    [ -n "$copy" ]
    [ "$del" -lt "$copy" ]
}

@test "step-up: a half-built flow the realm is bound to is un-pointed BEFORE it is deleted" {
    kc_tree
    seed_partial_flow
    printf '{"attributes":{},"browserFlow":"browser-stepup"}' > "${KCSTATE}/realm.json"
    kc_configure
    [ "$status" -eq 0 ]
    local unbind del
    unbind="$(call_line 'PUT /admin/realms/gremion-test .*"browserFlow":"browser"')"
    del="$(call_line 'DELETE /admin/realms/gremion-test/authentication/flows/flow-1')"
    [ -n "$unbind" ]
    [ -n "$del" ]
    [ "$unbind" -lt "$del" ]
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
    # Matched by SHAPE, not by the builder's local variable name. A literal
    # grep for one spelling ("composed.sslRequired = 'all'") stopped verifying
    # anything the day gremion#6 renamed that local to `resolved`: the guard
    # went RED for a rename while the behaviour it pins was intact, which is
    # the same class of defect as a guard that stays green for a deletion.
    # What must hold is that SOME local carrying the composed doc is assigned
    # 'all' — a deletion, or a weakening to 'external', still fails. No
    # end-of-line anchor: the source files are checked out CRLF on the
    # authoring host, where a trailing `$` would match nothing at all.
    grep -qE "^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*\\.sslRequired = 'all'" \
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

# ---------------------------------------------------------------------------
# Security sweep 2: step-up second-factor gate, password policy, refresh-token
# rotation, PKCE (findings 3 and 6)
# ---------------------------------------------------------------------------

two_fa_state() { cat "${KCSTATE}/two-fa.json" "${KCSTATE}/kids.json" | jq -s -c 'add'; }

@test "sweep2 #3: a legacy REQUIRED OTP form in stepup-2fa is converted to OTP-or-deny, the legacy form deleted LAST" {
    kc_tree
    seed_complete_flow
    kc_configure
    [ "$status" -eq 0 ]
    [ -z "$(call_line 'authentication/flows/browser/copy')" ]
    # the end state: the REQUIRED subflow holds OTP then deny-access, both ALTERNATIVE; no OTP form at level 0
    run two_fa_state
    echo "$output" | jq -e '
        (map(select(.providerId == "auth-otp-form")) | length == 1)
        and (map(select(.providerId == "auth-otp-form" and .requirement == "ALTERNATIVE" and .level == 1)) | length == 1)
        and (map(select(.providerId == "deny-access-authenticator" and .requirement == "ALTERNATIVE" and .level == 1)) | length == 1)
        and (map(select(.displayName == "stepup-2fa second factor" and .requirement == "REQUIRED")) | length == 1)'
    # crash safety: the old REQUIRED form goes only after the replacement is enabled
    local enable_last del
    enable_last="$(grep -nE 'PUT /admin/realms/gremion-test/authentication/flows/browser-stepup/executions' "${KCSTATE}/calls.log" | tail -n1 | cut -d: -f1)"
    del="$(call_line 'DELETE /admin/realms/gremion-test/authentication/executions/o2')"
    [ -n "$enable_last" ]
    [ -n "$del" ]
    [ "$enable_last" -lt "$del" ]
}

@test "sweep2 #3: a freshly built flow also ends OTP-or-deny" {
    kc_tree
    kc_configure
    [ "$status" -eq 0 ]
    [ -n "$(call_line 'authentication/flows/browser/copy')" ]
    run two_fa_state
    echo "$output" | jq -e 'map(select(.providerId == "auth-otp-form" and .requirement == "REQUIRED")) | length == 0'
    echo "$output" | jq -e 'map(select(.providerId == "deny-access-authenticator")) | length == 1'
}

@test "sweep2 #3: an already OTP-or-deny stepup-2fa is left alone (no execution writes)" {
    kc_tree
    seed_complete_flow
    printf '%s' '[{"id":"c2","providerId":"conditional-level-of-authentication","requirement":"REQUIRED","level":0,"index":0,"authenticationConfig":"cfg2"},{"id":"s2","displayName":"stepup-2fa second factor","authenticationFlow":true,"requirement":"REQUIRED","level":0,"index":1}]' > "${KCSTATE}/two-fa.json"
    printf '%s' '[{"id":"o2","providerId":"auth-otp-form","requirement":"ALTERNATIVE","level":1,"index":0},{"id":"d2","providerId":"deny-access-authenticator","requirement":"ALTERNATIVE","level":1,"index":1}]' > "${KCSTATE}/kids.json"
    kc_configure
    [ "$status" -eq 0 ]
    [[ "$output" == *"already OTP-or-deny"* ]]
    [ -z "$(call_line 'authentication/executions')" ]
    [ -z "$(call_line 'POST .*stepup-2fa')" ]
    [ -z "$(call_line 'PUT .*browser-stepup/executions')" ]
}

@test "sweep2 #3: a run that died after creating the subflow resumes (no second subflow)" {
    kc_tree
    seed_complete_flow
    printf '%s' '[{"id":"c2","providerId":"conditional-level-of-authentication","requirement":"REQUIRED","level":0,"index":0,"authenticationConfig":"cfg2"},{"id":"o2","providerId":"auth-otp-form","requirement":"REQUIRED","level":0,"index":1},{"id":"s2","displayName":"stepup-2fa second factor","authenticationFlow":true,"requirement":"DISABLED","level":0,"index":2}]' > "${KCSTATE}/two-fa.json"
    kc_configure
    [ "$status" -eq 0 ]
    [ -z "$(call_line 'POST .*stepup-2fa/executions/flow')" ]
    run two_fa_state
    echo "$output" | jq -e '(map(select(.providerId == "auth-otp-form")) | length == 1) and (map(select(.providerId == "auth-otp-form" and .level == 1)) | length == 1)'
}

@test "sweep2 #3 (review): an extra enabled authenticator inside the second-factor subflow is NOT OTP-or-deny (fails closed, nothing deleted)" {
    kc_tree
    seed_complete_flow
    printf '%s' '[{"id":"c2","providerId":"conditional-level-of-authentication","requirement":"REQUIRED","level":0,"index":0,"authenticationConfig":"cfg2"},{"id":"s2","displayName":"stepup-2fa second factor","authenticationFlow":true,"requirement":"REQUIRED","level":0,"index":1}]' > "${KCSTATE}/two-fa.json"
    printf '%s' '[{"id":"o2","providerId":"auth-otp-form","requirement":"ALTERNATIVE","level":1,"index":0},{"id":"a2","providerId":"allow-access-authenticator","requirement":"ALTERNATIVE","level":1,"index":1},{"id":"d2","providerId":"deny-access-authenticator","requirement":"ALTERNATIVE","level":1,"index":2}]' > "${KCSTATE}/kids.json"
    kc_configure
    [ "$status" -ne 0 ]
    [[ "$output" == *"not OTP-or-deny"* ]]
    # the stray row is reported, never deleted by a script that does not own it
    [ -z "$(call_line 'DELETE .*executions/a2')" ]
}

@test "sweep2 #3 (review): a DISABLED stray execution in the second-factor subflow is inert" {
    kc_tree
    seed_complete_flow
    printf '%s' '[{"id":"c2","providerId":"conditional-level-of-authentication","requirement":"REQUIRED","level":0,"index":0,"authenticationConfig":"cfg2"},{"id":"s2","displayName":"stepup-2fa second factor","authenticationFlow":true,"requirement":"REQUIRED","level":0,"index":1}]' > "${KCSTATE}/two-fa.json"
    printf '%s' '[{"id":"o2","providerId":"auth-otp-form","requirement":"ALTERNATIVE","level":1,"index":0},{"id":"d2","providerId":"deny-access-authenticator","requirement":"ALTERNATIVE","level":1,"index":1},{"id":"a2","providerId":"allow-access-authenticator","requirement":"DISABLED","level":1,"index":2}]' > "${KCSTATE}/kids.json"
    kc_configure
    [ "$status" -eq 0 ]
    [[ "$output" == *"already OTP-or-deny"* ]]
}

@test "sweep2 #3 (review): a run that died with BOTH the new subflow children and the legacy OTP form resumes (flow not dropped and rebuilt)" {
    kc_tree
    seed_complete_flow
    printf '%s' '[{"id":"c2","providerId":"conditional-level-of-authentication","requirement":"REQUIRED","level":0,"index":0,"authenticationConfig":"cfg2"},{"id":"old","providerId":"auth-otp-form","requirement":"REQUIRED","level":0,"index":1},{"id":"s2","displayName":"stepup-2fa second factor","authenticationFlow":true,"requirement":"REQUIRED","level":0,"index":2}]' > "${KCSTATE}/two-fa.json"
    printf '%s' '[{"id":"o2","providerId":"auth-otp-form","requirement":"ALTERNATIVE","level":1,"index":0},{"id":"d2","providerId":"deny-access-authenticator","requirement":"ALTERNATIVE","level":1,"index":1}]' > "${KCSTATE}/kids.json"
    kc_configure
    [ "$status" -eq 0 ]
    # resumed in place: the flow was neither deleted nor copied afresh, the legacy form went
    [ -z "$(call_line 'DELETE /admin/realms/gremion-test/authentication/flows/')" ]
    [ -z "$(call_line 'authentication/flows/browser/copy')" ]
    [ -n "$(call_line 'DELETE /admin/realms/gremion-test/authentication/executions/old')" ]
    run two_fa_state
    echo "$output" | jq -e '(map(select(.providerId == "auth-otp-form")) | length == 1) and (map(select(.providerId == "auth-otp-form" and .level == 1)) | length == 1)'
}

@test "sweep2 #6: the realm PUT carries the password policy and NOT refresh-token rotation" {
    kc_tree
    seed_complete_flow
    kc_configure
    [ "$status" -eq 0 ]
    local line
    line="$(grep -E 'PUT /admin/realms/gremion-test \{' "${KCSTATE}/calls.log" | grep browser-stepup | tail -n1)"
    [[ "$line" == *'"passwordPolicy":"length(12) and notUsername and notEmail and passwordHistory(3)"'* ]]
    # Rotation is deliberately off (docs/auth.md residual): the PUT must not carry it.
    [[ "$line" != *revokeRefreshToken* ]]
    [[ "$line" != *refreshTokenMaxReuse* ]]
}

@test "sweep2 #6: gremion-ui gets PKCE S256 merged into its attributes" {
    kc_tree
    seed_complete_flow
    kc_configure
    [ "$status" -eq 0 ]
    run jq -c '.attributes' "${KCSTATE}/ui-client.json"
    [ "$output" = '{"post.logout.redirect.uris":"x","pkce.code.challenge.method":"S256"}' ]
}

@test "sweep2 #6: a gremion-ui that already enforces PKCE S256 is not written again" {
    kc_tree
    seed_complete_flow
    printf '%s' '{"id":"cid-ui","clientId":"gremion-ui","attributes":{"pkce.code.challenge.method":"S256"}}' > "${KCSTATE}/ui-client.json"
    kc_configure
    [ "$status" -eq 0 ]
    [ -z "$(call_line 'PUT /admin/realms/gremion-test/clients/cid-ui')" ]
}

@test "sweep2: the shell and TypeScript password policy strings are the same" {
    local sh ts
    sh="$(sed -n 's/^REALM_PASSWORD_POLICY="\(.*\)"$/\1/p' "$KC_SCRIPT")"
    ts="$(sed -n "s/^export const REALM_PASSWORD_POLICY = '\(.*\)'$/\1/p" "${PROJECT_ROOT}/gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts")"
    [ -n "$sh" ]
    [ "$sh" = "$ts" ]
}

@test "sweep2: both realm templates carry the OTP-or-deny stepup-2fa and the policy, and no token rotation" {
    local f
    for f in realm-export.base.json realm-export.ops.json; do
        python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
flows = {f["alias"]: f for f in d["authenticationFlows"]}
f2 = flows["stepup-2fa"]["authenticationExecutions"]
assert not [e for e in f2 if e.get("authenticator") == "auth-otp-form"], "stepup-2fa must not hold an OTP form directly"
subs = [e for e in f2 if e.get("authenticatorFlow")]
assert len(subs) == 1 and subs[0]["requirement"] == "REQUIRED" and subs[0]["flowAlias"] == "stepup-2fa second factor"
kids = sorted(flows["stepup-2fa second factor"]["authenticationExecutions"], key=lambda e: e["priority"])
assert [(e["authenticator"], e["requirement"]) for e in kids] == [("auth-otp-form", "ALTERNATIVE"), ("deny-access-authenticator", "ALTERNATIVE")]
assert d["passwordPolicy"] == "length(12) and notUsername and notEmail and passwordHistory(3)"
assert "revokeRefreshToken" not in d and "refreshTokenMaxReuse" not in d, "refresh-token rotation must stay off (docs/auth.md residual)"
' "${PROJECT_ROOT}/docker/keycloak/${f}"
    done
}

@test "sweep2: the base template makes gremion-ui use PKCE S256" {
    python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
ui = [c for c in d["clients"] if c["clientId"] == "gremion-ui"][0]
assert ui["attributes"]["pkce.code.challenge.method"] == "S256"
' "${PROJECT_ROOT}/docker/keycloak/realm-export.base.json"
}
