#!/usr/bin/env bats
# Integration test - the rendered Keycloak login page of a realm that sets no
# displayName. REQUIRES: a running Keycloak, a provisioned realm, and Keycloak
# admin credentials.
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
# unreachable and a realm called `foo` renders `<title>Anmelden - foo</title>`
# and `<div class="n">foo</div>`. The assertions below therefore pin the realm
# name at those two sites and pin `Gremion` only where it genuinely comes from
# our own bundle (`gremionBrandSub`). A bare `*"Gremion"*` substring test would
# pass on a realm that sets a displayName AND on one that does not, which makes
# it useless as evidence.
#
# Env:
#   KEYCLOAK_URL       default http://localhost:8082/auth
#   THEME_REALM        the realm under test; its displayName MUST be unset
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
# displayName precondition below cannot be evaluated, and a suite that runs its
# page assertions while silently unable to check its own precondition is exactly
# the vacuous guard this file was rewritten to stop being.
setup() {
    if [ -z "$THEME_REALM" ]; then
        skip "THEME_REALM is unset - set it to a realm whose displayName is unset (see header)"
    fi
    if [ -z "$KC_ADMIN_USER" ] || [ -z "$KC_ADMIN_PASSWORD" ]; then
        skip "KC_ADMIN_USER/KC_ADMIN_PASSWORD unset - the displayName precondition needs the Admin API"
    fi
}

login_page() {
    curl -sf "${KEYCLOAK_URL}/realms/${THEME_REALM}/protocol/openid-connect/auth?client_id=${THEME_CLIENT_ID}&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&scope=openid"
}

kc_admin_token() {
    curl -sf -X POST "${KEYCLOAK_URL}/realms/${KC_ADMIN_REALM}/protocol/openid-connect/token" \
        -d grant_type=password -d client_id=admin-cli \
        --data-urlencode "username=${KC_ADMIN_USER}" \
        --data-urlencode "password=${KC_ADMIN_PASSWORD}" \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}

# Prints the realm's displayName, empty when unset. Non-zero exit means the
# Admin API could not be reached or parsed - which must FAIL a test, never pass
# it, because "no displayName" and "could not ask" are different answers.
realm_display_name() {
    local token
    token=$(kc_admin_token) || return 1
    [ -n "$token" ] || return 1
    curl -sf -H "Authorization: Bearer ${token}" \
        "${KEYCLOAK_URL}/admin/realms/${THEME_REALM}" \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("displayName") or "")'
}

@test "precondition: the fixture realm sets no displayName (read from the Admin API)" {
    # NOT from the public /realms/<r> doc. That endpoint returns
    # PublicRealmRepresentation - realm, public_key, token-service,
    # account-service, tokens-not-before - and has never carried displayName in
    # any Keycloak version, so the earlier `[[ "$doc" != *'"displayName":"'* ]]`
    # form passed unconditionally, including on a realm that DID set one. It was
    # measured: `kcadm update realms/<r> -s displayName=Musterstadt` left the
    # public doc byte-identical and the assertion green. displayName is
    # Admin-API-only, so this reads the Admin API.
    local display_name
    display_name=$(realm_display_name)
    [ "$?" -eq 0 ] || {
        echo "FAIL: could not read realm ${THEME_REALM} from the Admin API" >&2
        return 1
    }
    [ -z "$display_name" ] || {
        echo "FAIL: realm ${THEME_REALM} sets displayName='${display_name}' - the page would render that name, so the rest of this suite proves nothing about an unset realm" >&2
        return 1
    }
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

@test "the realm display block renders the realm name, at both of its sites" {
    # With displayName unset (asserted above) Keycloak substitutes the realm
    # name. Pinning both sites is what catches a theme that renders SOMETHING
    # plausible from the stock template instead of ours.
    local page
    page=$(login_page)
    [ -n "$page" ]
    [[ "$page" == *"<title>Anmelden · ${THEME_REALM}</title>"* ]]
    [[ "$page" == *"<div class=\"n\">${THEME_REALM}</div>"* ]]
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
