#!/usr/bin/env bash
set -euo pipefail
#
# panel-verify.sh <base-url> — the TRD-048 gate of the control panel, probed
# from outside against ANY running panel (TASK-043 TDD 22, section 11 (f)):
# the scratch standalone panel of the proof, or the netcup test env's through
# `ssh -L` (panel-verify.sh http://127.0.0.1:3043).
#
#   anonymous GET /                    -> 302 to .../realms/platform/... with acr_values=loa2
#   a customer-realm bearer token      -> 403
#   a forged session cookie            -> 403
#   a cross-origin "Neuer Mandant" POST -> 403 (ORIGIN must equal the browser origin)
#   /healthz                           -> 200 {"ok":true}
# and, when given:
#   --loa1-cookie <file>  a session cookie line of an ops login at loa1 -> 302 step-up (prompt=login)
#   --loa2-cookie <file>  a session cookie line of an ops login at loa2 -> 200 on /
#   --client-json <file>  `kcadm get clients -r platform -q clientId=control-panel` output:
#                         redirectUris / webOrigins carry no wildcard host
#
# Cookie FILES, never cookie values on an argv. Every check prints PASS or
# FAIL; any FAIL, or zero checks run, is exit 1. EXIT 2: usage.

BASE="${1:-}"
[[ "$BASE" =~ ^https?://[^/]+$ ]] || { echo "usage: panel-verify.sh <base-url> [--loa1-cookie F] [--loa2-cookie F] [--client-json F] [--customer-issuer URL]" >&2; exit 2; }
shift
LOA1="" LOA2="" CLIENT_JSON="" CUSTOMER_ISS="https://customer.invalid/auth/realms/customer"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --loa1-cookie) LOA1="${2:-}"; shift 2 ;;
        --loa2-cookie) LOA2="${2:-}"; shift 2 ;;
        --client-json) CLIENT_JSON="${2:-}"; shift 2 ;;
        --customer-issuer) CUSTOMER_ISS="${2:-}"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

PASS=0 FAIL=0
pass() { printf 'PASS %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL %s\n' "$*"; FAIL=$((FAIL + 1)); }

# probe <out-var-prefix> <curl args...> -> <prefix>_code, <prefix>_location
probe() {
    local p="$1"; shift
    local out
    out="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 "$@")" || out="000 "
    printf -v "${p}_code" '%s' "${out%% *}"
    printf -v "${p}_location" '%s' "${out#* }"
}

b64url() { printf '%s' "$1" | base64 | tr -d '=\n' | tr '/+' '_-'; }

# 1. anonymous
probe anon "${BASE}/"
if [[ "$anon_code" == 302 && "$anon_location" == */realms/platform/* && "$anon_location" == *acr_values=loa2* ]]; then
    pass "anonymous GET / -> 302 to the ops realm with acr_values=loa2"
else
    fail "anonymous GET / -> ${anon_code} ${anon_location:0:120}"
fi

# 2. a customer-realm token (unsigned: the panel refuses every bearer, and names a foreign iss)
token="$(b64url '{"alg":"none"}').$(b64url "{\"iss\":\"${CUSTOMER_ISS}\",\"sub\":\"x\"}").x"
probe cust -H @- "${BASE}/" <<< "Authorization: Bearer ${token}"
[[ "$cust_code" == 403 ]] && pass "customer-realm token -> 403" || fail "customer-realm token -> ${cust_code}"

# 3. a forged session cookie
probe forged -H "Cookie: authjs.session-token=forged-$(date +%s)" "${BASE}/api/customers"
[[ "$forged_code" == 403 ]] && pass "forged session cookie -> 403" || fail "forged session cookie -> ${forged_code}"

# 4. a cross-origin form POST (SvelteKit's CSRF check, and the gate)
probe xorigin -X POST -H "Origin: https://not-the-panel.invalid" -H "Content-Type: application/x-www-form-urlencoded" --data "slug=x" "${BASE}/customers/new"
[[ "$xorigin_code" == 403 ]] && pass "cross-origin \"Neuer Mandant\" POST -> 403" || fail "cross-origin POST -> ${xorigin_code}"

# 5. health
health="$(curl -sS --max-time 10 "${BASE}/healthz" || true)"
[[ "$health" == *'"ok":true'* ]] && pass "/healthz -> ok" || fail "/healthz -> ${health:0:120}"

# 6./7. real sessions, when given (cookie files, never argv values)
if [[ -n "$LOA1" ]]; then
    probe loa1 -H @"$LOA1" "${BASE}/"
    if [[ "$loa1_code" == 302 && "$loa1_location" == */realms/platform/* && "$loa1_location" == *prompt=login* ]]; then
        pass "ops session at loa1 -> step-up (302, prompt=login)"
    else
        fail "ops session at loa1 -> ${loa1_code} ${loa1_location:0:120}"
    fi
fi
if [[ -n "$LOA2" ]]; then
    probe loa2 -H @"$LOA2" "${BASE}/"
    [[ "$loa2_code" == 200 ]] && pass "ops session at loa2 -> 200" || fail "ops session at loa2 -> ${loa2_code}"
fi

# 8. the client's redirect URIs and web origins: exact, no wildcard host
if [[ -n "$CLIENT_JSON" ]]; then
    if command -v jq >/dev/null && jq -e '
          (if type == "array" then .[0] else . end) as $c
          | ($c.redirectUris + $c.webOrigins + [($c.attributes["post.logout.redirect.uris"] // "")])
          | map(select(. != "")) | length > 0 and all(test("^https?://[a-z0-9.-]+(:[0-9]+)?(/.*)?$"))' \
          "$CLIENT_JSON" >/dev/null; then
        pass "control-panel client: redirect URIs and web origins name exact hosts"
    else
        fail "control-panel client: a wildcard host or a malformed URI in redirectUris/webOrigins"
    fi
fi

printf 'PANEL-VERIFY: base=%s pass=%d fail=%d\n' "$BASE" "$PASS" "$FAIL"
[[ "$PASS" -gt 0 && "$FAIL" -eq 0 ]]
