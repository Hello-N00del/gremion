#!/usr/bin/env bash
# ============================================================
# Gremion — Configure Keycloak OIDC client secrets
#
# B-01 (spec B T.4): no realm is imported at boot, so a realm's client
# secrets are whatever the realm document carried when it was created.
# Run this script AFTER Keycloak has started, and after the realm named by
# KEYCLOAK_REALM exists, to (re)set the real client secrets through the
# Admin REST API.
#
# Usage:
#   ./scripts/configure-keycloak-clients.sh
#   (called automatically by: make keycloak-configure)
#
# Requires:
#   - Keycloak running and healthy (http://localhost:8082/auth)
#   - curl, jq
#   - .env file with KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD
# ============================================================

set -euo pipefail
cd "$(dirname "$0")/.."

# G-086 (Mediums Cluster 4 / T4.2): safe whitelist parser — no eval/source.
# Mirrors the pattern in scripts/backup.sh and scripts/dev-configure.sh.
if [[ -f .env ]]; then
    while IFS='=' read -r key val; do
        [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
        val="${val#\"}" val="${val%\"}"
        val="${val#\'}" val="${val%\'}"
        export "$key=$val"
    done < <(grep -v '^[[:space:]]*#' .env | grep -v '^[[:space:]]*$')
else
    echo "[configure-keycloak] ERROR: .env file not found." >&2
    exit 1
fi

: "${KEYCLOAK_ADMIN:?KEYCLOAK_ADMIN must be set in .env}"
: "${KEYCLOAK_ADMIN_PASSWORD:?KEYCLOAK_ADMIN_PASSWORD must be set in .env}"

KC_BASE="${KEYCLOAK_BASE_URL:-http://localhost:8082/auth}"
# B-01: there is no single boot realm any more. The caller names the realm this
# run configures; an unset value is a fatal misconfiguration, not a default.
REALM="${KEYCLOAK_REALM:?KEYCLOAK_REALM must be set — name the realm to configure (see .env.example)}"

# B-01 guard: the realm this run configures and the realm gremion-ui logs in
# against must be the SAME realm. Without this check a .env whose
# AUTH_KEYCLOAK_ISSUER was renamed and whose KEYCLOAK_REALM was not would send
# the client-secret writes below to a realm nobody authenticates against, and
# nothing would log an error. Both values were exported by the parser above.
bash scripts/check-realm-env.sh

info()    { echo "[configure-keycloak] $*"; }
success() { echo "[configure-keycloak] OK: $*"; }
error()   { echo "[configure-keycloak] ERROR: $*" >&2; exit 1; }

# ── Wait for Keycloak to be ready ────────────────────────────
info "Waiting for Keycloak to be healthy..."
ATTEMPTS=0
# Probe realms/master (200 on both the dev host port and the public /auth
# route) — Keycloak 26 serves /health on a separate management port that is
# not published in production.
until curl -sf "${KC_BASE}/realms/master" >/dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    [[ $ATTEMPTS -ge 30 ]] && error "Keycloak not ready after 150s"
    sleep 5
done
success "Keycloak is ready."

# ── Obtain admin access token ─────────────────────────────────
# #258-F3: the admin password used to be expanded inline as an argv element
# (--data-urlencode "password=${KEYCLOAK_ADMIN_PASSWORD}"), readable via
# `ps -ef`/`/proc/<pid>/cmdline` while curl ran. Mirror the G-085 tempfile
# pattern: stage the password into a 0600 host tempfile, then feed it to curl on
# STDIN and URL-encode it from there (--data-urlencode "password@-"), so it never
# appears on the command line. `@-` (stdin) is used instead of `@file` because
# native mingw64 curl on the Windows/Git-Bash staging host cannot open a POSIX
# /tmp path (curl exit 26 → empty token → abort). The request body is byte-
# identical. The file is removed immediately after the call (consumed
# synchronously).
#
# F1-FIX-09 (K6#4): it is ALSO removed by a single EXIT trap installed BEFORE the
# file exists. A failed token request used to end the script under `set -e` at the
# assignment below, silently and with the plaintext admin password still in /tmp;
# the failure now says what failed and the file is always removed. The one trap
# is EXTENDED by the kcadm step further down (KC_PW_HOST), never replaced.
KC_PW_FILE=""
KC_PW_HOST=""
cleanup() {
    [[ -z "$KC_PW_FILE" ]] || rm -f "$KC_PW_FILE"
    if [[ -n "$KC_PW_HOST" ]]; then
        rm -f "$KC_PW_HOST"
        docker compose exec -T keycloak rm -f /tmp/kcadm-pw 2>/dev/null || true
    fi
}
trap cleanup EXIT

info "Authenticating as admin..."
KC_PW_FILE=$(mktemp -t kc-admin-pw.XXXXXX)
chmod 600 "$KC_PW_FILE"
printf '%s' "$KEYCLOAK_ADMIN_PASSWORD" > "$KC_PW_FILE"
TOKEN=$(curl -sf \
    -d "client_id=admin-cli" \
    -d "username=${KEYCLOAK_ADMIN}" \
    --data-urlencode "password@-" \
    -d "grant_type=password" \
    "${KC_BASE}/realms/master/protocol/openid-connect/token" \
    < "$KC_PW_FILE" \
    | jq -r '.access_token') \
    || error "Failed to obtain admin token (check KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD and that Keycloak is healthy)"
rm -f "$KC_PW_FILE"

[[ -z "$TOKEN" || "$TOKEN" == "null" ]] && error "Failed to obtain admin token"

# ── Helper: give a service-account user ITS realm-management roles ──────
# A created realm does NOT carry service-account role mappings reliably in
# Keycloak 26 — the SA exists but ends up with no realm-management
# permissions. Calling this afterwards gives the SA the admin access it uses.
#
# F1-FIX-09 (K6#30): LEAST PRIVILEGE. The gremion-admin service account used to
# get the composite `realm-admin` role, i.e. every realm-management permission
# (clients, identity providers, authentication flows, realm settings ...), when
# gremion-ui only manages users, groups and their realm-role mappings
# (gremion-ui/src/lib/server/keycloak-admin.ts: /users, /users/{id}/groups,
# /users/{id}/role-mappings/realm, /roles, /groups, credentials, execute-actions).
# Exactly those realm-management roles are granted now. A realm that an earlier
# run gave realm-admin is NARROWED on re-run: realm-admin is removed from the
# service account unless KEYCLOAK_ADMIN_SA_ROLES asks for it by name.
#   manage-users, view-users, query-users, query-groups  users + groups
#   view-realm                                           GET /roles (realm roles)
SA_ROLES="${KEYCLOAK_ADMIN_SA_ROLES:-manage-users view-users query-users query-groups view-realm}"

assign_realm_admin_to_sa() {
    local client_id="$1"

    # 1. Look up the client UUID
    local client_uuid
    client_uuid=$(curl -sf \
        -H @/dev/fd/3 3<<<"Authorization: Bearer ${TOKEN}" \
        "${KC_BASE}/admin/realms/${REALM}/clients?clientId=${client_id}" \
        | jq -r '.[0].id')
    [[ -z "$client_uuid" || "$client_uuid" == "null" ]] && error "Client '${client_id}' not found"

    # 2. Look up the service-account user behind this client
    local sa_user_id
    sa_user_id=$(curl -sf \
        -H @/dev/fd/3 3<<<"Authorization: Bearer ${TOKEN}" \
        "${KC_BASE}/admin/realms/${REALM}/clients/${client_uuid}/service-account-user" \
        | jq -r '.id')
    [[ -z "$sa_user_id" || "$sa_user_id" == "null" ]] && error "Service-account user for '${client_id}' not found (is serviceAccountsEnabled set?)"

    # 3. Look up the realm-management client UUID
    local rm_uuid
    rm_uuid=$(curl -sf \
        -H @/dev/fd/3 3<<<"Authorization: Bearer ${TOKEN}" \
        "${KC_BASE}/admin/realms/${REALM}/clients?clientId=realm-management" \
        | jq -r '.[0].id')

    [[ -z "$rm_uuid" || "$rm_uuid" == "null" ]] && error "Client 'realm-management' not found"
    local mappings_url="${KC_BASE}/admin/realms/${REALM}/users/${sa_user_id}/role-mappings/clients/${rm_uuid}"

    # 4. Fetch each wanted realm-management role definition
    local role role_json roles_json="" roles_array
    for role in $SA_ROLES; do
        role_json=$(curl -sf \
            -H @/dev/fd/3 3<<<"Authorization: Bearer ${TOKEN}" \
            "${KC_BASE}/admin/realms/${REALM}/clients/${rm_uuid}/roles/${role}") \
            || error "realm-management role '${role}' not found (KEYCLOAK_ADMIN_SA_ROLES)"
        roles_json="${roles_json}${role_json}"$'\n'
    done
    [[ -n "$roles_json" ]] || error "KEYCLOAK_ADMIN_SA_ROLES is empty"
    roles_array=$(printf '%s' "$roles_json" | jq -cs '.')

    # 5. Assign the roles (idempotent — Keycloak silently no-ops on duplicates)
    curl -sf -X POST \
        -H @/dev/fd/3 3<<<"Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$roles_array" \
        "$mappings_url" \
        || error "Failed to assign realm-management roles (${SA_ROLES}) to '${client_id}' service account"

    # 6. Narrow a service account an earlier run gave the composite realm-admin
    #    (unless it was asked for by name). Read from the realm, not assumed.
    local current stale
    case " ${SA_ROLES} " in
        *" realm-admin "*) : ;;
        *)
            current=$(curl -sf -H @/dev/fd/3 3<<<"Authorization: Bearer ${TOKEN}" "$mappings_url") \
                || error "Failed to read the role mappings of the '${client_id}' service account"
            stale=$(printf '%s' "$current" | jq -c '[.[] | select(.name == "realm-admin")]')
            if [[ "$stale" != "[]" ]]; then
                curl -sf -X DELETE \
                    -H @/dev/fd/3 3<<<"Authorization: Bearer ${TOKEN}" \
                    -H "Content-Type: application/json" \
                    -d "$stale" \
                    "$mappings_url" \
                    || error "Failed to remove realm-admin from the '${client_id}' service account"
                info "  removed the over-broad realm-admin role from '${client_id}'."
            fi
            ;;
    esac

    success "Service account for '${client_id}' has: ${SA_ROLES}."
}

# ── #164: real 2FA step-up via a Level-of-Authentication browser flow ─────────
# Replaces the cosmetic "2FA" labels with an enforced Keycloak step-up. Builds a
# `browser-stepup` flow whose forms subflow has two LoA-conditional subflows:
#   stepup-1fa (CONDITIONAL): Condition-LoA(level 1, maxAge 36000) → Username/Password
#   stepup-2fa (CONDITIONAL): Condition-LoA(level 2, maxAge 300)   → OTP Form
# A normal login (no acr_values) stays password-only; only acr_values=loa2 forces
# OTP (enrolling TOTP on first use). Also sets the realm otpPolicy, the
# `acr.loa.map` attribute, points realm.browserFlow at the new flow, and ensures
# the gremion-ui client has an acr protocol mapper.
#
# Why here (not the realm template): B-01 deleted the boot import, and a realm
# that already exists never picks up flow/otpPolicy changes from a JSON document
# anyway. This applies them to the RUNNING realm via the Admin API.
# realm-export.base.json still carries them as the source of truth for the realm
# buildTenantRealmDoc composes for a FRESH tenant.
#
# Idempotent: the (non-atomic) flow build is guarded behind flow existence; the
# realm-config and acr-mapper steps no-op on re-run. ORDER MATTERS — the flow
# must exist BEFORE realm.browserFlow can point at it (else PUT /realms 500s).
# Built + verified against a throwaway Keycloak 26.6.1 (see #164 implementation plan).
_kc_api() {  # METHOD PATH [JSON_BODY] — PATH is relative to /admin/realms/${REALM}
    local method="$1" path="$2" body="${3:-}"
    if [[ -n "$body" ]]; then
        curl -sf -X "$method" -H @/dev/fd/3 3<<<"Authorization: Bearer ${TOKEN}" \
            -H "Content-Type: application/json" --data "$body" \
            "${KC_BASE}/admin/realms/${REALM}${path}"
    else
        curl -sf -X "$method" -H @/dev/fd/3 3<<<"Authorization: Bearer ${TOKEN}" \
            "${KC_BASE}/admin/realms/${REALM}${path}"
    fi
}
_kc_setreq() { # EXEC_ID REQUIREMENT
    _kc_api PUT "/authentication/flows/browser-stepup/executions" \
        "{\"id\":\"$1\",\"requirement\":\"$2\"}" >/dev/null
}
_kc_setcfg() { # EXEC_ID ALIAS LEVEL MAXAGE
    _kc_api POST "/authentication/executions/$1/config" \
        "{\"alias\":\"$2\",\"config\":{\"loa-condition-level\":\"$3\",\"loa-max-age\":\"$4\"}}" >/dev/null
}

# Prints absent | complete | partial for the browser-stepup flow, read from the
# realm. COMPLETE = the forms flow holds both LoA subflows as CONDITIONAL, and
# each holds its LoA condition (REQUIRED, with its level/max-age config attached)
# and its authenticator (username/password in stepup-1fa REQUIRED, the OTP form in
# stepup-2fa in whatever requirement: _ensure_stepup_2fa_second_factor owns that
# one). Anything less is PARTIAL (a build that died halfway).
_stepup_flow_state() {
    local flows top sub subex want
    flows=$(_kc_api GET "/authentication/flows") || error "cannot list the realm's authentication flows"
    if ! printf '%s' "$flows" | jq -e '.[] | select(.alias == "browser-stepup")' >/dev/null 2>&1; then
        echo absent; return 0
    fi
    top=$(_kc_api GET "/authentication/flows/browser-stepup/executions") || { echo partial; return 0; }
    for sub in stepup-1fa stepup-2fa; do
        if ! printf '%s' "$top" | jq -e --arg a "$sub" \
                '[.[] | select(.displayName == $a and .requirement == "CONDITIONAL")] | length == 1' >/dev/null 2>&1; then
            echo partial; return 0
        fi
        want="auth-username-password-form"
        [[ "$sub" == "stepup-2fa" ]] && want="auth-otp-form"
        subex=$(_kc_api GET "/authentication/flows/${sub}/executions") || { echo partial; return 0; }
        if ! printf '%s' "$subex" | jq -e --arg w "$want" '
                ([.[] | select(.providerId == "conditional-level-of-authentication"
                               and .requirement == "REQUIRED"
                               and ((.authenticationConfig // "") != ""))] | length == 1)
                and ([.[] | select(.providerId == $w and ($w == "auth-otp-form" or .requirement == "REQUIRED"))] | length == 1)' >/dev/null 2>&1; then
            echo partial; return 0
        fi
    done
    echo complete
}

# Removes a partial browser-stepup flow. Keycloak refuses to delete a flow the
# realm is bound to, so the realm is pointed back at the stock `browser` flow
# first (and step 2 of configure_stepup_flow points it at the rebuilt one).
_drop_partial_stepup_flow() {
    local bound flow_id
    bound=$(_kc_api GET "" | jq -r '.browserFlow // ""') || error "cannot read the realm's browserFlow"
    if [[ "$bound" == "browser-stepup" ]]; then
        _kc_api PUT "" "{\"realm\":\"${REALM}\",\"browserFlow\":\"browser\"}" >/dev/null \
            || error "cannot point the realm back at the stock browser flow"
    fi
    flow_id=$(_kc_api GET "/authentication/flows" \
        | jq -r '.[] | select(.alias == "browser-stepup") | .id') \
        || error "cannot list the realm's authentication flows"
    [[ -n "$flow_id" && "$flow_id" != "null" ]] || error "partial browser-stepup flow has no id"
    _kc_api DELETE "/authentication/flows/${flow_id}" >/dev/null \
        || error "cannot delete the partial browser-stepup flow"
}

# Security sweep 2 (finding 3). stepup-2fa must NOT hold a REQUIRED OTP form: for
# a user with no OTP credential Keycloak then runs CONFIGURE_TOTP inside the
# step-up and issues acr=loa2 once the user has enrolled, so whoever holds the
# session (or only the password) enrolls their own authenticator and passes the
# "fresh 2FA" gate. The OTP form sits in a REQUIRED subflow as an ALTERNATIVE,
# followed by deny-access as the other ALTERNATIVE: a user with an OTP credential
# is asked for it, a user without one is refused (no enrolment is offered).
STEPUP_2FA_SUBFLOW="stepup-2fa second factor"
STEPUP_2FA_SUBFLOW_ENC="stepup-2fa%20second%20factor"

# stdin: the flattened stepup-2fa executions; exit 0 iff it has the hardened shape.
_stepup_2fa_gate_ok() {
    jq -e --arg sub "$STEPUP_2FA_SUBFLOW" '
        ([.[] | select(.providerId == "auth-otp-form")]) as $o
        | ([.[] | select(.providerId == "deny-access-authenticator")]) as $d
        | ([.[] | select(.authenticationFlow == true and .displayName == $sub)]) as $s
        | ($o | length) == 1 and ($d | length) == 1 and ($s | length) == 1
        and $s[0].requirement == "REQUIRED"
        and $o[0].requirement == "ALTERNATIVE" and $d[0].requirement == "ALTERNATIVE"
        and ($o[0].level // 0) >= 1 and $o[0].level == $d[0].level
        and ($o[0].index // 0) < ($d[0].index // 0)' >/dev/null 2>&1
}

# Idempotent and crash-safe: the replacement is built and enabled FIRST and the
# legacy REQUIRED OTP form is deleted LAST, so a run that dies half way leaves a
# flow that still demands a second factor. A stepup-2fa with no OTP form at all
# is structural drift that the rebuild in configure_stepup_flow owns.
_ensure_stepup_2fa_second_factor() {
    local top sub_id legacy kids otp_id deny_id otp_req deny_req sub_req p id
    top=$(_kc_api GET "/authentication/flows/stepup-2fa/executions") \
        || error "cannot read the stepup-2fa executions"
    if printf '%s' "$top" | _stepup_2fa_gate_ok; then
        info "  stepup-2fa already OTP-or-deny."
        return 0
    fi
    legacy=$(printf '%s' "$top" | jq -r '.[] | select(.providerId == "auth-otp-form" and (.level // 0) == 0) | .id')
    sub_id=$(printf '%s' "$top" | jq -r --arg a "$STEPUP_2FA_SUBFLOW" '.[] | select(.authenticationFlow == true and .displayName == $a) | .id')
    if [[ -z "$sub_id" && -z "$legacy" ]]; then
        return 0
    fi
    if [[ -z "$sub_id" ]]; then
        _kc_api POST "/authentication/flows/stepup-2fa/executions/flow" \
            "{\"alias\":\"${STEPUP_2FA_SUBFLOW}\",\"type\":\"basic-flow\"}" >/dev/null \
            || error "cannot add the '${STEPUP_2FA_SUBFLOW}' subflow"
        top=$(_kc_api GET "/authentication/flows/stepup-2fa/executions") || error "cannot read the stepup-2fa executions"
        sub_id=$(printf '%s' "$top" | jq -r --arg a "$STEPUP_2FA_SUBFLOW" '.[] | select(.authenticationFlow == true and .displayName == $a) | .id')
        [[ -n "$sub_id" ]] || error "the '${STEPUP_2FA_SUBFLOW}' subflow is absent after it was created"
    fi
    kids=$(_kc_api GET "/authentication/flows/${STEPUP_2FA_SUBFLOW_ENC}/executions") \
        || error "cannot read the '${STEPUP_2FA_SUBFLOW}' executions"
    for p in auth-otp-form deny-access-authenticator; do
        if ! printf '%s' "$kids" | jq -e --arg p "$p" 'any(.[]; .providerId == $p)' >/dev/null 2>&1; then
            _kc_api POST "/authentication/flows/${STEPUP_2FA_SUBFLOW_ENC}/executions/execution" \
                "{\"provider\":\"${p}\"}" >/dev/null || error "cannot add ${p} to '${STEPUP_2FA_SUBFLOW}'"
            kids=""
        fi
    done
    if [[ -z "$kids" ]]; then
        kids=$(_kc_api GET "/authentication/flows/${STEPUP_2FA_SUBFLOW_ENC}/executions") \
            || error "cannot read the '${STEPUP_2FA_SUBFLOW}' executions"
    fi
    otp_id=$(printf '%s' "$kids" | jq -r '.[] | select(.providerId == "auth-otp-form") | .id')
    deny_id=$(printf '%s' "$kids" | jq -r '.[] | select(.providerId == "deny-access-authenticator") | .id')
    [[ -n "$otp_id" && -n "$deny_id" ]] || error "'${STEPUP_2FA_SUBFLOW}' is incomplete after the build"
    # OTP is tried first; deny-access only when no OTP alternative applied.
    if [[ "$(printf '%s' "$kids" | jq -r '(.[] | select(.providerId == "auth-otp-form") | .index // 0) > (.[] | select(.providerId == "deny-access-authenticator") | .index // 0)')" == "true" ]]; then
        _kc_api POST "/authentication/executions/${otp_id}/raise-priority" >/dev/null \
            || error "cannot order OTP before deny-access"
    fi
    sub_req=$(printf '%s' "$top" | jq -r --arg a "$STEPUP_2FA_SUBFLOW" '.[] | select(.authenticationFlow == true and .displayName == $a) | .requirement')
    otp_req=$(printf '%s' "$kids" | jq -r '.[] | select(.providerId == "auth-otp-form") | .requirement')
    deny_req=$(printf '%s' "$kids" | jq -r '.[] | select(.providerId == "deny-access-authenticator") | .requirement')
    [[ "$sub_req" == "REQUIRED" ]] || _kc_setreq "$sub_id" REQUIRED
    [[ "$otp_req" == "ALTERNATIVE" ]] || _kc_setreq "$otp_id" ALTERNATIVE
    [[ "$deny_req" == "ALTERNATIVE" ]] || _kc_setreq "$deny_id" ALTERNATIVE
    for id in $legacy; do
        _kc_api DELETE "/authentication/executions/${id}" >/dev/null || error "cannot remove the legacy REQUIRED OTP form"
    done
    _kc_api GET "/authentication/flows/stepup-2fa/executions" | _stepup_2fa_gate_ok \
        || error "stepup-2fa is not OTP-or-deny after the repair (read back from the realm)"
    success "  stepup-2fa is now OTP-or-deny: a user without a second factor is refused, never enrolled mid step-up."
}

# Security sweep 2 (finding 6): the same string as REALM_PASSWORD_POLICY in
# gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts (pinned by a test).
REALM_PASSWORD_POLICY="length(12) and notUsername and notEmail and passwordHistory(3)"

configure_stepup_flow() {
    info "Configuring #164 LoA step-up authentication flow..."

    # 1. Build browser-stepup unless it is already COMPLETE. The build is a dozen
    #    non-atomic calls, so a run that died halfway leaves a flow that EXISTS but
    #    is not whole; skipping on existence alone (F1-FIX-09, K6#5) then called
    #    it done on the next run and step 2 below wired the half-built flow in as
    #    the realm's browserFlow, i.e. every login went through it. Its shape is
    #    read from the realm instead (_stepup_flow_state); a partial flow is
    #    removed (after un-pointing the realm from it) and rebuilt, and the result
    #    is read back before the realm is pointed at it.
    local flow_state
    flow_state=$(_stepup_flow_state)
    if [[ "$flow_state" == "partial" ]]; then
        info "  browser-stepup flow exists but is INCOMPLETE — removing it and rebuilding."
        _drop_partial_stepup_flow
        flow_state="absent"
    fi
    if [[ "$flow_state" == "complete" ]]; then
        info "  browser-stepup flow already present and complete — skipping build."
    else
        info "  Building browser-stepup from the default browser flow..."
        _kc_api POST "/authentication/flows/browser/copy" '{"newName":"browser-stepup"}' >/dev/null \
            || error "Failed to copy browser flow"
        local execs pw_id twofa_id
        execs=$(_kc_api GET "/authentication/flows/browser-stepup/executions")
        pw_id=$(echo "$execs" | jq -r '.[]|select(.providerId=="auth-username-password-form")|.id')
        twofa_id=$(echo "$execs" | jq -r '.[]|select(.displayName=="browser-stepup Browser - Conditional 2FA")|.id')
        [[ -n "$pw_id" && "$pw_id" != null ]] && _kc_api DELETE "/authentication/executions/${pw_id}" >/dev/null
        [[ -n "$twofa_id" && "$twofa_id" != null ]] && _kc_api DELETE "/authentication/executions/${twofa_id}" >/dev/null
        # Add the two LoA subflows under "browser-stepup forms" (1FA before 2FA).
        local forms="browser-stepup%20forms"
        _kc_api POST "/authentication/flows/${forms}/executions/flow" '{"alias":"stepup-1fa","type":"basic-flow"}' >/dev/null
        _kc_api POST "/authentication/flows/${forms}/executions/flow" '{"alias":"stepup-2fa","type":"basic-flow"}' >/dev/null
        _kc_api POST "/authentication/flows/stepup-1fa/executions/execution" '{"provider":"conditional-level-of-authentication"}' >/dev/null
        _kc_api POST "/authentication/flows/stepup-1fa/executions/execution" '{"provider":"auth-username-password-form"}' >/dev/null
        _kc_api POST "/authentication/flows/stepup-2fa/executions/execution" '{"provider":"conditional-level-of-authentication"}' >/dev/null
        _kc_api POST "/authentication/flows/stepup-2fa/executions/execution" '{"provider":"auth-otp-form"}' >/dev/null
        # Resolve the new execution ids per subflow (unambiguous via per-subflow GET).
        local e1 c1 p1 e2 c2 o2 f1 f2
        e1=$(_kc_api GET "/authentication/flows/stepup-1fa/executions")
        c1=$(echo "$e1" | jq -r '.[]|select(.providerId=="conditional-level-of-authentication")|.id')
        p1=$(echo "$e1" | jq -r '.[]|select(.providerId=="auth-username-password-form")|.id')
        e2=$(_kc_api GET "/authentication/flows/stepup-2fa/executions")
        c2=$(echo "$e2" | jq -r '.[]|select(.providerId=="conditional-level-of-authentication")|.id')
        o2=$(echo "$e2" | jq -r '.[]|select(.providerId=="auth-otp-form")|.id')
        f1=$(_kc_api GET "/authentication/flows/browser-stepup/executions" | jq -r '.[]|select(.displayName=="stepup-1fa")|.id')
        f2=$(_kc_api GET "/authentication/flows/browser-stepup/executions" | jq -r '.[]|select(.displayName=="stepup-2fa")|.id')
        _kc_setreq "$f1" CONDITIONAL; _kc_setreq "$c1" REQUIRED; _kc_setreq "$p1" REQUIRED
        _kc_setreq "$f2" CONDITIONAL; _kc_setreq "$c2" REQUIRED; _kc_setreq "$o2" REQUIRED
        _kc_setcfg "$c1" stepup-loa1 1 36000
        _kc_setcfg "$c2" stepup-loa2 2 300
        # Post-condition, read back from the realm: only a COMPLETE flow may be
        # pointed at by realm.browserFlow below.
        [[ "$(_stepup_flow_state)" == "complete" ]] \
            || error "browser-stepup flow is not complete after the build (read back from the realm); not wiring it in as the browser flow"
        success "  browser-stepup flow built (1FA loa1 + 2FA loa2 / OTP)."
    fi

    # 1b. Security sweep 2 (finding 3): stepup-2fa is OTP-or-deny, built or not.
    _ensure_stepup_2fa_second_factor

    # 2. Realm otpPolicy + acr.loa.map + browserFlow. Minimal partial PUT (a full
    #    round-tripped realm rep 500s on KC 26); merge existing attributes so the
    #    realm's other attributes are preserved. Runs AFTER the flow exists.
    local attrs
    attrs=$(_kc_api GET "" | jq -c '(.attributes // {}) + {"acr.loa.map":"{\"loa1\":1,\"loa2\":2}"}')
    _kc_api PUT "" "{\"realm\":\"${REALM}\",\"browserFlow\":\"browser-stepup\",\"otpPolicyType\":\"totp\",\"otpPolicyAlgorithm\":\"HmacSHA1\",\"otpPolicyDigits\":6,\"otpPolicyPeriod\":30,\"otpPolicyLookAheadWindow\":1,\"otpPolicyInitialCounter\":0,\"passwordPolicy\":\"${REALM_PASSWORD_POLICY}\",\"revokeRefreshToken\":true,\"refreshTokenMaxReuse\":0,\"attributes\":${attrs}}" >/dev/null \
        || error "Failed to set realm otpPolicy/acr.loa.map/browserFlow/passwordPolicy/refresh-token rotation"
    success "  Realm otpPolicy + acr.loa.map + browserFlow=browser-stepup + passwordPolicy + refresh-token rotation set."

    # 3. Ensure the gremion-ui client emits the acr claim (access + id token).
    local client_uuid
    client_uuid=$(_kc_api GET "/clients?clientId=gremion-ui" | jq -r '.[0].id // empty')
    if [[ -z "$client_uuid" ]]; then
        info "  Client 'gremion-ui' not found — skipping acr mapper (configure manually if needed)."
    elif _kc_api GET "/clients/${client_uuid}/protocol-mappers/models" | jq -e '.[]|select(.protocolMapper=="oidc-acr-mapper")' >/dev/null 2>&1; then
        info "  acr mapper already present on gremion-ui."
    else
        _kc_api POST "/clients/${client_uuid}/protocol-mappers/models" \
            '{"name":"acr","protocol":"openid-connect","protocolMapper":"oidc-acr-mapper","config":{"id.token.claim":"true","access.token.claim":"true","introspection.token.claim":"true"}}' >/dev/null \
            || error "Failed to add acr mapper to gremion-ui"
        success "  acr mapper added to gremion-ui client."
    fi
    # 4. Security sweep 2 (finding 6): PKCE S256 on gremion-ui (Auth.js sends it).
    if [[ -n "$client_uuid" ]]; then
        local ui_client pkce_body
        ui_client=$(_kc_api GET "/clients/${client_uuid}") || error "cannot read the gremion-ui client"
        if [[ "$(printf '%s' "$ui_client" | jq -r '.attributes["pkce.code.challenge.method"] // ""')" == "S256" ]]; then
            info "  gremion-ui already enforces PKCE S256."
        else
            pkce_body=$(printf '%s' "$ui_client" | jq -c '{id, clientId, attributes: ((.attributes // {}) + {"pkce.code.challenge.method": "S256"})}')
            _kc_api PUT "/clients/${client_uuid}" "$pkce_body" >/dev/null                 || error "Failed to enforce PKCE S256 on gremion-ui"
            success "  gremion-ui now enforces PKCE S256."
        fi
    fi
    success "#164 step-up flow configured."
}

# ── Configure clients ─────────────────────────────────────────
# gremion-admin is a confidential client with serviceAccountsEnabled=true,
# used by gremion-ui to manage Keycloak users/groups (governance sync, user
# provisioning). Without the realm-management roles below its admin-API calls
# return 403; it deliberately does NOT get the composite realm-admin (K6#30).
info "Granting least-privilege realm-management roles to gremion-admin service account..."
assign_realm_admin_to_sa "gremion-admin"

# #164: build/refresh the LoA step-up flow + otpPolicy + acr mapper on the
# running realm (idempotent). This only makes the step-up mechanism available;
# any per-action enforcement is a separate, deliberate step.
configure_stepup_flow

# Update realm privacy policy URL to the deployment domain.
# C20: kcadm.sh only exists inside the keycloak container, so run it via
# `docker compose exec`. Using --server http://localhost:8080 because that
# endpoint is resolved inside the container itself.
info "Setting realm privacyPolicyUrl..."
# privacyPolicyUrl is not a top-level RealmRepresentation field in Keycloak 26;
# store it as a realm attribute. Non-fatal — it is a cosmetic login-page link.
#
# G-085 (Mediums Cluster 4 / T4.1): kcadm used to receive the admin password
# as an inline `--password "$KEYCLOAK_ADMIN_PASSWORD"` argv element on the
# `docker compose exec` command line, where any user on the host could read
# it via `ps -ef --columns 800 | grep kcadm`. Keycloak 26's kcadm has no
# documented `--password-stdin` flag (verifying requires a running KC
# container, which the static execution environment for this fix can't
# provide), so we use the operator-pre-approved tempfile fallback:
#   1. Write the password to a per-invocation host tempfile via mktemp.
#   2. Stream the file content into a container-side /tmp/kcadm-pw via
#      `docker compose exec -T sh -c 'umask 077; cat > /tmp/kcadm-pw'`
#      (the password never appears in argv — the pipe contents are not
#      visible to other processes).
#   3. Inside the container, read the file into kcadm via
#      `--password "$(cat /tmp/kcadm-pw)"`. The expanded `$(cat …)` is
#      argv to the child kcadm process running INSIDE the container's
#      PID namespace, where only root and that pod's processes can see it
#      — the host's `ps -ef` cannot reach across into the container's
#      argv. Outside the container, the host shell only sees the literal
#      string `--password "$(cat /tmp/kcadm-pw)"`.
#   4. The EXIT trap (cleanup(), installed once near the top, F1-FIX-09 K6#4)
#      cleans up both files even on failure: assigning KC_PW_HOST is what
#      EXTENDS it with this step - nothing replaces it.
KC_PW_HOST=$(mktemp -t kcadm-pw.XXXXXX)
chmod 600 "$KC_PW_HOST"
printf '%s' "$KEYCLOAK_ADMIN_PASSWORD" > "$KC_PW_HOST"
if ! docker compose exec -T keycloak sh -c 'umask 077; cat > /tmp/kcadm-pw' < "$KC_PW_HOST"; then
    info "  privacyPolicyUrl not applied (failed to stage kcadm password into container)."
else
    # Run config-credentials + update inside ONE container shell so the
    # cached kcadm.config persists between them, and the password file
    # only has to be referenced from inside the container.
    if docker compose exec -T keycloak sh -c '
            /opt/keycloak/bin/kcadm.sh config credentials \
                --server http://localhost:8080/auth \
                --realm master --user "'"${KEYCLOAK_ADMIN}"'" \
                --password "$(cat /tmp/kcadm-pw)" \
            && /opt/keycloak/bin/kcadm.sh update "realms/'"${REALM}"'" \
                -s "attributes.privacyPolicyUrl=https://'"${DOMAIN:-localhost}"'/datenschutz"
        '; then
        success "  privacyPolicyUrl: https://${DOMAIN:-localhost}/datenschutz"
    else
        info "  privacyPolicyUrl not applied (non-fatal — realm attribute unsupported)."
    fi
fi

success "Keycloak client configuration complete."
echo ""
