#!/usr/bin/env bats
# Integration test - the rendered Keycloak login page. REQUIRES: a running
# Keycloak, a provisioned realm, and Keycloak admin credentials.
#
# This is the only assertion in B1b that reads what a user is SERVED rather than
# what the repo declares. It exists because a theme mismatch is quiet: Keycloak
# falls back to the stock theme and still answers 200 (it does log
# `Failed to find LOGIN theme <name>, using built-in themes` at ERROR once per
# request, but nothing reads that log), so "the page loaded" and "the page loaded
# OUR theme" are different facts and only the second is useful.
#
# WHAT THE PAGE ACTUALLY RENDERS - measured against Keycloak 26.6.1, not assumed.
# `${(realm.displayName)!'Gremion'}` never falls back: RealmBean.getDisplayName()
# returns the realm NAME when displayName is unset, so the FreeMarker default is
# unreachable and a realm called `themeclean` with no displayName renders
# `<title>Anmelden - themeclean</title>` and `<div class="n">themeclean</div>`.
# This suite therefore does NOT require displayName to be unset (an earlier draft
# did, via the public /realms/<r> doc, which never carries the field and so could
# not fail). It asks the ADMIN API what the realm's effective display name is -
# displayName when set, otherwise the realm name - and asserts the page renders
# exactly that, at both render sites. That assertion holds on any realm, and it
# is what catches a stock-theme fallback rendering something plausible instead of
# ours. `Gremion` is pinned only where it genuinely comes from our own bundle
# (the `gremionBrandSub` value); a bare `*"Gremion"*` substring test passed on
# every realm and proved nothing.
#
# THE REDIRECT URI IS READ FROM THE REALM, NEVER SPELLED HERE. Keycloak answers
# an authorization request whose `redirect_uri` the client does not register
# with an error page at HTTP 400 - and its loopback relaxation covers the PORT
# only, never the path. A hardcoded `http://localhost/cb` is therefore a 400
# against the realm CI imports (whose `gremion-ui` client registers only
# `/auth/callback/keycloak` URIs), `curl -sf` returns an empty body, and five of
# the six assertions below fail as "status 22" for a reason that has nothing to
# do with the theme - the kind of red that gets fixed by deleting the suite.
# `client_redirect_uri` asks the Admin API which URIs the client actually
# registers and uses one of them, so the suite keeps working when the realm, the
# client or its URI set is renamed by another unit.
#
# Env:
#   KEYCLOAK_URL       default http://localhost:8082/auth
#   THEME_REALM        the realm under test (required)
#   KC_ADMIN_USER      Keycloak admin (falls back to KEYCLOAK_ADMIN)
#   KC_ADMIN_PASSWORD  its password (falls back to KEYCLOAK_ADMIN_PASSWORD)
#   KC_ADMIN_REALM     default master
#   THEME_CLIENT_ID    default gremion-ui

load '../test_helper/common'

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8082/auth}"
THEME_REALM="${THEME_REALM:-}"
KC_ADMIN_REALM="${KC_ADMIN_REALM:-master}"
KC_ADMIN_USER="${KC_ADMIN_USER:-${KEYCLOAK_ADMIN:-}}"
KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-${KEYCLOAK_ADMIN_PASSWORD:-}}"
THEME_CLIENT_ID="${THEME_CLIENT_ID:-gremion-ui}"

# A file-scope `${THEME_REALM:?...}` aborts bats at COLLECTION, which takes the
# whole `bats a.bats b.bats c.bats` invocation down instead of skipping one
# file. Gate in setup() like the sibling suites do.
#
# The skip covers the admin credentials too, on purpose: without them the
# effective display name cannot be established, and a suite that asserts what a
# page renders while unable to say what it SHOULD render is the vacuous guard
# this file was rewritten to stop being.
#
# A skip is a GREEN test, so every caller that is meant to run this suite for
# real has to assert it did not skip. The CI step does exactly that: it fails on
# a `# skip` line in the TAP output, not on the exit code.
setup() {
    if [ -z "$THEME_REALM" ]; then
        skip "THEME_REALM is unset - set it to the realm whose login page to fetch (see header)"
    fi
    # B-01: an EMPTY realm skips, but an unresolved `__SENTINEL__` does not - it
    # is a non-empty name no Keycloak ever has, so every assertion below fails
    # on a 404 and the suite reads like a theme regression. The realm template's
    # own `realm` field is exactly such a sentinel (`__REALM_NAME__`, overwritten
    # by buildTenantRealmDoc at tenant-create time), so a caller deriving
    # THEME_REALM from the template lands here. Fail, loudly and once: this is a
    # caller misconfiguration, not a reason to skip.
    case "$THEME_REALM" in
        __*__)
            echo "FAIL: THEME_REALM is the unresolved template sentinel ${THEME_REALM}." >&2
            echo "      No realm is named that. Point THEME_REALM at a realm that EXISTS" >&2
            echo "      (the CI integration job creates one from .env's KEYCLOAK_REALM)." >&2
            return 1
            ;;
    esac
    if [ -z "$KC_ADMIN_USER" ] || [ -z "$KC_ADMIN_PASSWORD" ]; then
        skip "KC_ADMIN_USER/KC_ADMIN_PASSWORD unset - the expected display name comes from the Admin API"
    fi
}

kc_admin_token() {
    curl -sf -X POST "${KEYCLOAK_URL}/realms/${KC_ADMIN_REALM}/protocol/openid-connect/token" \
        -d grant_type=password -d client_id=admin-cli \
        --data-urlencode "username=${KC_ADMIN_USER}" \
        --data-urlencode "password=${KC_ADMIN_PASSWORD}" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}

# Prints ONE redirect_uri the client under test really registers. Wildcards and
# unresolved `__SENTINEL__` placeholders are skipped: a wildcard is a PATTERN
# Keycloak matches the request against, so sending the pattern itself is not
# guaranteed to validate. Non-zero exit means the client is absent or registers
# nothing usable - which must FAIL a test, never pass it.
client_redirect_uri() {
    local token
    token=$(kc_admin_token) || return 1
    [ -n "$token" ] || return 1
    curl -sf -G -H "Authorization: Bearer ${token}" \
        --data-urlencode "clientId=${THEME_CLIENT_ID}" \
        "${KEYCLOAK_URL}/admin/realms/${THEME_REALM}/clients" \
        | python3 -c '
import json, sys
clients = json.load(sys.stdin)
if not clients:
    sys.exit(1)
for uri in sorted(clients[0].get("redirectUris") or []):
    if "*" in uri or "__" in uri:
        continue
    print(uri)
    break
else:
    sys.exit(1)
'
}

authorize() {
    local uri="$1"
    shift
    curl "$@" -G "${KEYCLOAK_URL}/realms/${THEME_REALM}/protocol/openid-connect/auth" \
        --data-urlencode "client_id=${THEME_CLIENT_ID}" \
        --data-urlencode "redirect_uri=${uri}" \
        --data "response_type=code" \
        --data "scope=openid"
}

login_page() {
    local uri
    uri=$(client_redirect_uri) || return 1
    [ -n "$uri" ] || return 1
    authorize "$uri" -sf
}

# Prints the realm's EFFECTIVE display name exactly as Keycloak will render it:
# displayName when set, otherwise the realm name. Non-zero exit means the Admin
# API could not be reached or parsed - which must FAIL a test, never pass it,
# because "the realm renders X" and "could not ask" are different answers.
realm_effective_name() {
    local token
    token=$(kc_admin_token) || return 1
    [ -n "$token" ] || return 1
    curl -sf -H "Authorization: Bearer ${token}" \
        "${KEYCLOAK_URL}/admin/realms/${THEME_REALM}" \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("displayName") or d["realm"])'
}

@test "precondition: the Admin API answers for the realm under test" {
    local token effective
    token=$(kc_admin_token) || {
        echo "FAIL: could not obtain an admin token from ${KEYCLOAK_URL}/realms/${KC_ADMIN_REALM}" >&2
        return 1
    }
    [ -n "$token" ]
    effective=$(realm_effective_name) || {
        echo "FAIL: could not read realm ${THEME_REALM} from the Admin API" >&2
        return 1
    }
    # Empty would make the render assertion below match any page at all.
    [ -n "$effective" ]
    echo "# effective display name: ${effective}" >&3
}

@test "precondition: the authorization endpoint accepts a redirect_uri the client registers" {
    local uri code
    uri=$(client_redirect_uri) || {
        echo "FAIL: client ${THEME_CLIENT_ID} is absent from realm ${THEME_REALM}, or registers no concrete redirect_uri" >&2
        return 1
    }
    [ -n "$uri" ]
    code=$(authorize "$uri" -s -o /dev/null -w '%{http_code}')
    if [ "$code" != "200" ]; then
        echo "FAIL: the authorization endpoint answered ${code} for redirect_uri=${uri}." >&2
        echo "      An unregistered redirect_uri answers 400 with an error page, which would make" >&2
        echo "      every assertion below fail on an empty body instead of on the theme." >&2
        return 1
    fi
    echo "# redirect_uri: ${uri}" >&3
}

@test "the login page is served by the gremion theme, not the stock fallback" {
    local page
    page=$(login_page)
    [ -n "$page" ]
    # The stylesheet path is the theme's fingerprint: the stock theme links
    # neither this filename nor this resources path.
    [[ "$page" == *"/css/gremion.v2.css"* ]]
    # And our own bundle resolved: gremionBrandSub's value, at its render site.
    [[ "$page" == *'<div class="s">Gremion · Anmeldung</div>'* ]]
}

@test "the title and brand block render the realm's effective display name" {
    local page effective
    effective=$(realm_effective_name)
    [ -n "$effective" ]
    page=$(login_page)
    [ -n "$page" ]
    [[ "$page" == *"<title>Anmelden · ${effective}</title>"* ]]
    [[ "$page" == *"<div class=\"n\">${effective}</div>"* ]]
}

@test "the login page contains zero occurrences of the retired product name" {
    local page n
    page=$(login_page)
    # A 200 with an empty body would make the count zero and this test vacuous.
    [ -n "$page" ]
    n=$(printf '%s' "$page" | grep -o 'StuRaOS' | wc -l)
    [ "$n" -eq 0 ]
}

@test "no message key rendered as a raw placeholder" {
    # A key renamed in the markup but not in the bundles renders as ??key??.
    local page
    page=$(login_page)
    # An empty body contains no "??" either - assert there is a page first.
    [ -n "$page" ]
    [[ "$page" != *"??"* ]]
}

@test "the theme stylesheet the page links resolves 200" {
    local page href code
    page=$(login_page)
    [ -n "$page" ]
    href=$(printf '%s' "$page" | grep -o 'href="[^"]*gremion\.v2\.css[^"]*"' | head -1 | sed 's/^href="//; s/"$//')
    [ -n "$href" ]
    case "$href" in
        http*) : ;;
        /*) href="${KEYCLOAK_URL%/auth}${href}" ;;
    esac
    code=$(curl -s -o /dev/null -w '%{http_code}' "$href")
    [ "$code" -eq 200 ]
}
