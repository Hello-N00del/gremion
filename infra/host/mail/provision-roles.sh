#!/usr/bin/env bash
#
# provision-roles.sh — create the §I role addresses and the platform sending
# identity in Stalwart through its management API. Idempotent: re-running
# converges and exits 0, which is how the control plane (spec C) will call it.
#
# The thirteen role addresses are aliases on ONE mailbox, `roles`, because the
# operator reads them all. no-reply@ is an alias too: its auto-reply is a
# control-plane feature (spec C), not a launch item — ManageSieve is omitted at
# launch (N19), so there is no per-account script path here. That is a recorded
# decision, not an omission.
#
# THE API ANSWERS 200 TO EVERYTHING. Success and failure alike come back as
# HTTP 200; the verdict is in the BODY — {"data":…} when the call did what was
# asked, {"error":"notFound","item":"…"} when it did not. Every post-condition
# below therefore reads the body. A guard that reads the status code calls
# every missing principal "already present", skips creating it, and fails three
# calls later on a PATCH against something that was never there. Observed
# against a running Stalwart in Task 8's integration step; the unit shim in
# test/host/mail-bringup.bats models the same contract.
#
# APP-PASSWORD FORMAT: `$app$<app-name>$<password>` is the form written into
# the principal's `secrets` array. The API stores it verbatim (observed), but
# SMTP AUTH accepted none of the representations tried on the pinned build —
# see spike S4 row 11. Do not change this without redoing that observation.
#
# EXIT CODES: 0 converged · 1 an API call or post-condition failed ·
#             2 usage/precondition · 3 blocked (no per-principal source
#             restriction in the pinned build; see --allow-unrestricted)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
. "$SCRIPT_DIR/../lib/common.sh"

ROLE_ALIASES=(security abuse postmaster hostmaster hello signups no-reply
              notifications newsletter bounces dmarc-reports tls-reports
              datenschutz)

ALLOW_UNRESTRICTED=0
ENV_FILE=""
API_OUT=""
SOURCE_RESTRICTION="enforced"

usage() {
    echo "usage: provision-roles.sh [--env FILE] [--allow-unrestricted]" >&2
}

# An option that is the LAST argument used to leave its variable empty and then
# die inside `shift 2` under set -e: exit 1, no message, no usage.
need_value() {
    [ "$2" -ge 2 ] || { usage; die "${1} requires a value" "$GREMION_EXIT_USAGE"; }
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --env)                need_value --env "$#"; ENV_FILE="$2"; shift 2 ;;
            --allow-unrestricted) ALLOW_UNRESTRICTED=1; shift ;;
            -h|--help)            usage; exit "$GREMION_EXIT_OK" ;;
            *)                    usage; die "unknown argument: $1" "$GREMION_EXIT_USAGE" ;;
        esac
    done
}

# api <method> <path> [json-body] — response body in $API_OUT.
api() {
    local method="$1" path="$2" body="${3:-}"
    local args=(-sS -o "$API_OUT" -X "$method"
                -u "${STALWART_ADMIN_USER}:${STALWART_ADMIN_PASSWORD}"
                -H 'Content-Type: application/json'
                "${STALWART_ADMIN_URL}${path}")
    [ -z "$body" ] || args+=(--data-binary "$body")
    curl "${args[@]}" \
        || die "the management API at ${STALWART_ADMIN_URL} did not answer ${method} ${path}" \
               "$GREMION_EXIT_USAGE"
}

# The last response carried a data payload, i.e. the call did what was asked.
api_ok() { jq -e 'has("data")' "$API_OUT" >/dev/null 2>&1; }

# The error name the last response carried, for the message.
api_error() { jq -r '.error // "unrecognised response"' "$API_OUT" 2>/dev/null || echo "unreadable response"; }

# Did the last GET find the object? "notFound" is the one error that is an
# answer rather than a failure.
api_absent() { [ "$(api_error)" = "notFound" ]; }

# The platform DOMAIN must exist before any mailbox in it: the pinned build
# refuses a mailbox whose domain it does not know. Without this the first
# mailbox create silently does nothing and the first alias PATCH fails.
ensure_domain() {   # <domain>
    local dom="$1"
    api GET "/api/principal/${dom}"
    if api_ok; then ok "domain ${dom} already present"; return 0; fi
    api_absent || die "GET /api/principal/${dom} failed: $(api_error)" "$GREMION_EXIT_ASSERT"
    api POST "/api/principal" "$(jq -nc --arg n "$dom" '{type:"domain", name:$n}')"
    api_ok || die "creating domain ${dom} failed: $(api_error)" "$GREMION_EXIT_ASSERT"
    api GET "/api/principal/${dom}"
    api_ok || die "domain ${dom} absent after create: $(api_error)" "$GREMION_EXIT_ASSERT"
    ok "domain ${dom} created"
}

ensure_principal() {   # <name> <type> <primary-address>
    local name="$1" type="$2" email="$3"
    api GET "/api/principal/${name}"
    if api_ok; then ok "principal ${name} already present"; return 0; fi
    api_absent || die "GET /api/principal/${name} failed: $(api_error)" "$GREMION_EXIT_ASSERT"
    api POST "/api/principal" \
        "$(jq -nc --arg n "$name" --arg t "$type" --arg e "$email" \
               --argjson q "$MAIL_ACCOUNT_QUOTA" \
               '{type:$t, name:$n, emails:[$e], quota:$q}')"
    api_ok || die "creating principal ${name} failed: $(api_error)" "$GREMION_EXIT_ASSERT"
    api GET "/api/principal/${name}"
    api_ok || die "principal ${name} absent after create: $(api_error)" "$GREMION_EXIT_ASSERT"
    ok "principal ${name} created with ${email}, quota ${MAIL_ACCOUNT_QUOTA}"
}

ensure_alias() {   # <principal> <address>
    local p="$1" addr="$2"
    api GET "/api/principal/${p}"
    api_ok || die "principal ${p} missing: $(api_error)" "$GREMION_EXIT_ASSERT"
    if jq -e --arg a "$addr" '(.data.emails // []) | index($a)' "$API_OUT" >/dev/null 2>&1; then
        ok "alias ${addr} already present on ${p}"
        return 0
    fi
    api PATCH "/api/principal/${p}" \
        "$(jq -nc --arg a "$addr" '[{action:"addItem", field:"emails", value:$a}]')"
    api_ok || die "adding ${addr} to ${p} failed: $(api_error)" "$GREMION_EXIT_ASSERT"
    api GET "/api/principal/${p}"
    jq -e --arg a "$addr" '(.data.emails // []) | index($a)' "$API_OUT" >/dev/null 2>&1 \
        || die "alias ${addr} absent on ${p} after PATCH" "$GREMION_EXIT_ASSERT"
    ok "alias ${addr} -> ${p}"
}

ensure_secret() {   # <principal> <app-name> <password>
    local p="$1" app="$2" pw="$3" secret
    [ -n "$pw" ] || die "the password for ${p}/${app} is empty in the mail env file" "$GREMION_EXIT_USAGE"
    # See the APP-PASSWORD FORMAT note in the header (S4 row 11).
    secret="\$app\$${app}\$${pw}"
    api GET "/api/principal/${p}"
    api_ok || die "principal ${p} missing: $(api_error)" "$GREMION_EXIT_ASSERT"
    if jq -e --arg s "$secret" '(.data.secrets // []) | index($s)' "$API_OUT" >/dev/null 2>&1; then
        ok "${p}: app password ${app} already set"
        return 0
    fi
    api PATCH "/api/principal/${p}" \
        "$(jq -nc --arg s "$secret" '[{action:"addItem", field:"secrets", value:$s}]')"
    api_ok || die "setting ${p}/${app} failed: $(api_error)" "$GREMION_EXIT_ASSERT"
    api GET "/api/principal/${p}"
    jq -e --arg s "$secret" '(.data.secrets // []) | index($s)' "$API_OUT" >/dev/null 2>&1 \
        || die "app password ${app} absent on ${p} after PATCH" "$GREMION_EXIT_ASSERT"
    ok "${p}: app password ${app} set"
}

# §I wants the platform app password usable only from the app-tier subnets.
# Whether the pinned build can express that is spike S4; if it cannot, this is
# a BLOCK, and accepting it is an explicit operator act, recorded as a residual.
ensure_source_restriction() {
    local net
    api GET "/api/principal/platform"
    api_ok || die "principal platform missing: $(api_error)" "$GREMION_EXIT_ASSERT"
    if ! jq -e '.data | has("allowedNetworks")' "$API_OUT" >/dev/null 2>&1; then
        if [ "$ALLOW_UNRESTRICTED" -eq 1 ]; then
            bad "the platform app password is NOT source-restricted (accepted residual, S4)"
            SOURCE_RESTRICTION="residual"
            return 0
        fi
        printf 'BLOCKED: the pinned Stalwart build exposes no per-principal source restriction,\n'
        printf 'so the IP-restricted app password of §I cannot be enforced. Either pin a build\n'
        printf 'that has it (spike S4), or re-run with --allow-unrestricted to accept it as a\n'
        printf 'named residual recorded in the runbook.\n'
        exit "$GREMION_EXIT_BLOCKED"
    fi
    for net in "$APP_BLUE_V4_SUBNET" "$APP_GREEN_V4_SUBNET"; do
        if jq -e --arg n "$net" '(.data.allowedNetworks // []) | index($n)' "$API_OUT" >/dev/null 2>&1; then
            ok "platform: ${net} already allowed"
            continue
        fi
        api PATCH "/api/principal/platform" \
            "$(jq -nc --arg n "$net" '[{action:"addItem", field:"allowedNetworks", value:$n}]')"
        api_ok || die "restricting platform to ${net} failed: $(api_error)" "$GREMION_EXIT_ASSERT"
        api GET "/api/principal/platform"
        jq -e --arg n "$net" '(.data.allowedNetworks // []) | index($n)' "$API_OUT" >/dev/null 2>&1 \
            || die "platform is not restricted to ${net} after PATCH" "$GREMION_EXIT_ASSERT"
        ok "platform restricted to ${net}"
    done
    SOURCE_RESTRICTION="enforced"
}

main() {
    parse_args "$@"
    # mktemp/tail: assert() captures the wrapped command's output through them.
    need_cmd curl jq mktemp tail
    load_env "${ENV_FILE:-$(gremion_root)/etc/env/mail.env}"
    API_OUT="$(mktemp)"
    trap 'rm -f "$API_OUT"' EXIT

    api GET "/api/principal"
    assert "management API answers with a data payload" api_ok

    ensure_domain "$PLATFORM_DOMAIN"

    ensure_principal roles    individual "roles@${PLATFORM_DOMAIN}"
    ensure_principal platform individual "platform@${PLATFORM_DOMAIN}"

    local r
    for r in "${ROLE_ALIASES[@]}"; do
        ensure_alias roles "${r}@${PLATFORM_DOMAIN}"
    done

    ensure_secret platform gremion-platform "$PLATFORM_SMTP_PASSWORD"
    ensure_secret roles    gremion-roles-imap "$ROLES_IMAP_PASSWORD"
    ensure_source_restriction

    printf 'MAIL-ROLES: aliases=%d platform-app-password=ok source-restriction=%s\n' \
        "${#ROLE_ALIASES[@]}" "$SOURCE_RESTRICTION"
}

main "$@"
