#!/usr/bin/env bash
# ============================================================
# Gremion — Configure Keycloak OIDC client secrets
#
# Keycloak's --import-realm does NOT perform shell variable
# substitution in the JSON file.  Run this script AFTER
# Keycloak has started to set the real client secrets via the
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
REALM="sturaos"

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
# synchronously) rather than via a trap, since a later `trap … EXIT` (G-085,
# below) would otherwise replace it.
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
    | jq -r '.access_token')
rm -f "$KC_PW_FILE"

[[ -z "$TOKEN" || "$TOKEN" == "null" ]] && error "Failed to obtain admin token"

# ── Helper: assign a realm-management role to a service-account user ──
# Realm imports do NOT carry service-account role mappings reliably in
# Keycloak 26 — the SA is created but ends up with no realm-management
# permissions. Calling this after import gives the SA admin access.
assign_realm_admin_to_sa() {
    local client_id="$1"

    # 1. Look up the client UUID
    local client_uuid
    client_uuid=$(curl -sf \
        -H "Authorization: Bearer ${TOKEN}" \
        "${KC_BASE}/admin/realms/${REALM}/clients?clientId=${client_id}" \
        | jq -r '.[0].id')
    [[ -z "$client_uuid" || "$client_uuid" == "null" ]] && error "Client '${client_id}' not found"

    # 2. Look up the service-account user behind this client
    local sa_user_id
    sa_user_id=$(curl -sf \
        -H "Authorization: Bearer ${TOKEN}" \
        "${KC_BASE}/admin/realms/${REALM}/clients/${client_uuid}/service-account-user" \
        | jq -r '.id')
    [[ -z "$sa_user_id" || "$sa_user_id" == "null" ]] && error "Service-account user for '${client_id}' not found (is serviceAccountsEnabled set?)"

    # 3. Look up the realm-management client UUID
    local rm_uuid
    rm_uuid=$(curl -sf \
        -H "Authorization: Bearer ${TOKEN}" \
        "${KC_BASE}/admin/realms/${REALM}/clients?clientId=realm-management" \
        | jq -r '.[0].id')

    # 4. Fetch the realm-admin role definition
    local realm_admin_role
    realm_admin_role=$(curl -sf \
        -H "Authorization: Bearer ${TOKEN}" \
        "${KC_BASE}/admin/realms/${REALM}/clients/${rm_uuid}/roles/realm-admin")

    # 5. Assign the role (idempotent — Keycloak silently no-ops on duplicate)
    curl -sf -X POST \
        -H "Authorization: Bearer ${TOKEN}" \
        -H "Content-Type: application/json" \
        -d "[${realm_admin_role}]" \
        "${KC_BASE}/admin/realms/${REALM}/users/${sa_user_id}/role-mappings/clients/${rm_uuid}" \
        || error "Failed to assign realm-admin to '${client_id}' service account"

    success "Service account for '${client_id}' has realm-admin."
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
# Why here (not realm-export.json): Keycloak's --import-realm SKIPS realms that
# already exist, so the live realm never picks up flow/otpPolicy changes from the
# JSON. This applies them to the running realm via the Admin API instead.
# realm-export.json still carries them as the source of truth for FRESH installs.
#
# Idempotent: the (non-atomic) flow build is guarded behind flow existence; the
# realm-config and acr-mapper steps no-op on re-run. ORDER MATTERS — the flow
# must exist BEFORE realm.browserFlow can point at it (else PUT /realms 500s).
# Built + verified against a throwaway Keycloak 26.6.1 (see #164 implementation plan).
_kc_api() {  # METHOD PATH [JSON_BODY] — PATH is relative to /admin/realms/${REALM}
    local method="$1" path="$2" body="${3:-}"
    if [[ -n "$body" ]]; then
        curl -sf -X "$method" -H "Authorization: Bearer ${TOKEN}" \
            -H "Content-Type: application/json" --data "$body" \
            "${KC_BASE}/admin/realms/${REALM}${path}"
    else
        curl -sf -X "$method" -H "Authorization: Bearer ${TOKEN}" \
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

configure_stepup_flow() {
    info "Configuring #164 LoA step-up authentication flow..."

    # 1. Build browser-stepup if absent (the build is not individually idempotent).
    if _kc_api GET "/authentication/flows" | jq -e '.[]|select(.alias=="browser-stepup")' >/dev/null 2>&1; then
        info "  browser-stepup flow already present — skipping build."
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
        success "  browser-stepup flow built (1FA loa1 + 2FA loa2 / OTP)."
    fi

    # 2. Realm otpPolicy + acr.loa.map + browserFlow. Minimal partial PUT (a full
    #    round-tripped realm rep 500s on KC 26); merge existing attributes so the
    #    realm's other attributes are preserved. Runs AFTER the flow exists.
    local attrs
    attrs=$(_kc_api GET "" | jq -c '(.attributes // {}) + {"acr.loa.map":"{\"loa1\":1,\"loa2\":2}"}')
    _kc_api PUT "" "{\"realm\":\"${REALM}\",\"browserFlow\":\"browser-stepup\",\"otpPolicyType\":\"totp\",\"otpPolicyAlgorithm\":\"HmacSHA1\",\"otpPolicyDigits\":6,\"otpPolicyPeriod\":30,\"otpPolicyLookAheadWindow\":1,\"otpPolicyInitialCounter\":0,\"attributes\":${attrs}}" >/dev/null \
        || error "Failed to set realm otpPolicy/acr.loa.map/browserFlow"
    success "  Realm otpPolicy + acr.loa.map + browserFlow=browser-stepup set."

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
    success "#164 step-up flow configured."
}

# ── Configure clients ─────────────────────────────────────────
# gremion-admin is a confidential client with serviceAccountsEnabled=true,
# used by gremion-ui to manage Keycloak users/groups (governance sync, user
# provisioning). Without realm-admin its admin-API calls return 403.
info "Granting realm-admin to gremion-admin service account..."
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
#   4. The `trap … EXIT` cleans up both files even on failure.
KC_PW_HOST=$(mktemp -t kcadm-pw.XXXXXX)
# shellcheck disable=SC2064  # we WANT $KC_PW_HOST expanded at trap-registration time
trap "rm -f '$KC_PW_HOST'; docker compose exec -T keycloak rm -f /tmp/kcadm-pw 2>/dev/null || true" EXIT
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
