#!/usr/bin/env bash
set -euo pipefail
#
# panel-verify.sh <base-url> — the TRD-048 gate of the control panel, probed
# from outside against ANY running panel (TASK-043 TDD 22, section 11 (f)):
# the scratch standalone panel of the proof, or the test env's on its public
# host name ([D R29-I11]: panel-verify.sh https://<PANEL_HOST>).
#
#   anonymous GET /                     -> 302 to .../realms/platform/... with acr_values=loa2
#   a customer-realm bearer token       -> 403
#   a forged session cookie             -> 403
#   a cross-origin "Neuer Mandant" POST -> 403 (ORIGIN must equal the browser origin)
#   a foreign Host header               -> refused (421 from the panel, 404 from an edge
#                                          that routes the panel's name only), never 2xx/3xx
#   /healthz                            -> {"ok":true}
#   an https base                       -> Strict-Transport-Security max-age=31536000 (gremion-ui's)
# and, when given:
#   --loa1-cookie <file>  a header line "Cookie: ..." of an ops login at loa1 -> 302 step-up (prompt=login)
#   --loa2-cookie <file>  a header line "Cookie: ..." of an ops login at loa2 -> 200 on /,
#                         carrying gremion-ui's Content-Security-Policy
#   --client-json <file>  `kcadm get clients -r platform -q clientId=control-panel` output:
#                         redirectUris / webOrigins / post-logout URIs name exact hosts (no wildcard host)
#
# Cookie FILES, never cookie values on an argv. Every check prints PASS or
# FAIL; any FAIL, or zero checks run, is exit 1. EXIT 2: usage.

BASE="${1:-}"
if [[ ! "$BASE" =~ ^https?://[^/]+$ ]]; then
    echo "usage: panel-verify.sh <base-url> [--host-header NAME] [--loa1-cookie F] [--loa2-cookie F] [--client-json F] [--customer-issuer URL]" >&2
    exit 2
fi
shift
LOA1="" LOA2="" CLIENT_JSON="" CUSTOMER_ISS="https://customer.invalid/auth/realms/customer"
# --host-header NAME: every probe carries Host: NAME (the panel's loopback port
# on its host, where the edge is bypassed but the panel still answers its own
# host name only, R29-I11).
HOST_HDR=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --host-header) HOST_HDR=(-H "Host: ${2:-}"); shift 2 ;;
        --loa1-cookie) LOA1="${2:-}"; shift 2 ;;
        --loa2-cookie) LOA2="${2:-}"; shift 2 ;;
        --client-json) CLIENT_JSON="${2:-}"; shift 2 ;;
        --customer-issuer) CUSTOMER_ISS="${2:-}"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

PASS=0
FAIL=0
verdict() {   # <ok: 0|1> <message>
    if [[ "$1" -eq 0 ]]; then
        printf 'PASS %s\n' "$2"
        PASS=$((PASS + 1))
    else
        printf 'FAIL %s\n' "$2"
        FAIL=$((FAIL + 1))
    fi
}

# probe <curl args...> -> "<status> <redirect url>" on stdout ("000 " on a transport failure)
probe() {
    curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 ${HOST_HDR[@]+"${HOST_HDR[@]}"} "$@" || printf '000 '
}

b64url() { printf '%s' "$1" | base64 | tr -d '=\n' | tr '/+' '_-'; }

# 1. anonymous
read -r code location < <(probe "${BASE}/"; echo)
ok=1
if [[ "$code" == 302 && "$location" == */realms/platform/* && "$location" == *acr_values=loa2* ]]; then ok=0; fi
verdict "$ok" "anonymous GET / -> ${code} to the ops realm with acr_values=loa2"

# 2. a customer-realm token (unsigned: the panel refuses every bearer and names a foreign iss)
token="$(b64url '{"alg":"none"}').$(b64url "{\"iss\":\"${CUSTOMER_ISS}\",\"sub\":\"x\"}").x"
read -r code _ < <(printf 'Authorization: Bearer %s\n' "$token" | probe -H @- "${BASE}/"; echo)
ok=1; [[ "$code" == 403 ]] && ok=0
verdict "$ok" "customer-realm token -> ${code} (want 403)"

# 3. a forged session cookie
read -r code _ < <(probe -H "Cookie: authjs.session-token=forged-$$" "${BASE}/api/customers"; echo)
ok=1; [[ "$code" == 403 ]] && ok=0
verdict "$ok" "forged session cookie -> ${code} (want 403)"

# 4. a cross-origin form POST (SvelteKit's CSRF check, and the gate)
read -r code _ < <(probe -X POST -H "Origin: https://not-the-panel.invalid" -H "Content-Type: application/x-www-form-urlencoded" --data "slug=x" "${BASE}/customers/new"; echo)
ok=1; [[ "$code" == 403 ]] && ok=0
verdict "$ok" "cross-origin \"Neuer Mandant\" POST -> ${code} (want 403)"

# 5. a foreign Host (R29-I11): the panel answers on its own host name only
read -r code _ < <(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -H "Host: not-the-panel.invalid" "${BASE}/" || printf '000'; echo)
ok=1; [[ "$code" == 421 || "$code" == 404 ]] && ok=0
verdict "$ok" "foreign Host header -> ${code} (want 421 from the panel or 404 from the edge)"

# 6. health
health="$(curl -sS --max-time 10 ${HOST_HDR[@]+"${HOST_HDR[@]}"} "${BASE}/healthz" || true)"
ok=1; [[ "$health" == *'"ok":true'* ]] && ok=0
verdict "$ok" "/healthz -> ${health:0:120}"

# 7. HSTS on an https base (gremion-ui's: one year)
if [[ "$BASE" == https://* ]]; then
    hsts="$(curl -sS -o /dev/null -D - --max-time 20 "${BASE}/" | tr -d '\r' | grep -i '^strict-transport-security:' || true)"
    ok=1; [[ "$hsts" == *max-age=31536000* ]] && ok=0
    verdict "$ok" "Strict-Transport-Security on ${BASE} -> ${hsts:-absent}"
fi

# 8./9. real sessions, when given (cookie files, never argv values)
if [[ -n "$LOA1" ]]; then
    read -r code location < <(probe -H @"$LOA1" "${BASE}/"; echo)
    ok=1
    if [[ "$code" == 302 && "$location" == */realms/platform/* && "$location" == *prompt=login* ]]; then ok=0; fi
    verdict "$ok" "ops session at loa1 -> ${code} step-up (prompt=login)"
fi
if [[ -n "$LOA2" ]]; then
    headers="$(curl -sS -o /dev/null -D - -w '%{http_code}' --max-time 20 ${HOST_HDR[@]+"${HOST_HDR[@]}"} -H @"$LOA2" "${BASE}/" | tr -d '\r' || true)"
    code="${headers##*$'\n'}"
    ok=1; [[ "$code" == 200 ]] && ok=0
    verdict "$ok" "ops session at loa2 -> ${code} (want 200)"
    ok=1; grep -qi "^content-security-policy: default-src 'self'; " <<< "$headers" && ok=0
    verdict "$ok" "the loa2 page carries gremion-ui's Content-Security-Policy"
fi

# 10. the client's redirect URIs and web origins: exact hosts, no wildcard host
if [[ -n "$CLIENT_JSON" ]]; then
    ok=1
    if command -v jq >/dev/null && jq -e '
          (if type == "array" then .[0] else . end) as $c
          | ($c.redirectUris + $c.webOrigins + [($c.attributes["post.logout.redirect.uris"] // "")])
          | map(select(. != "")) | length > 0 and all(test("^https?://[a-z0-9.-]+(:[0-9]+)?(/.*)?$"))' \
          "$CLIENT_JSON" >/dev/null; then
        ok=0
    fi
    verdict "$ok" "control-panel client: redirect URIs and web origins name exact hosts"
fi

printf 'PANEL-VERIFY: base=%s pass=%d fail=%d\n' "$BASE" "$PASS" "$FAIL"
[[ "$PASS" -gt 0 && "$FAIL" -eq 0 ]]
