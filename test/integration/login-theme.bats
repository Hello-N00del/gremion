#!/usr/bin/env bats
# Integration test — the rendered Keycloak login page of a realm that sets no
# displayName. REQUIRES: a deployed stack and a provisioned tenant realm.
#
# This is the only assertion in B1b that reads what a user is served rather than
# what the repo declares. It exists because a theme mismatch is SILENT: Keycloak
# falls back to the stock theme and still answers 200, so "the page loaded" and
# "the page loaded our theme" are different facts and only the second is useful.
#
# Env: KEYCLOAK_URL (default http://localhost:8082/auth), THEME_REALM (the realm
# created by `tenant-create` with no displayName).

load '../test_helper/common'

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8082/auth}"
THEME_REALM="${THEME_REALM:?set THEME_REALM to a provisioned realm with no displayName}"

login_page() {
    curl -sf "${KEYCLOAK_URL}/realms/${THEME_REALM}/protocol/openid-connect/auth?client_id=gremion-ui&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&scope=openid"
}

@test "the fixture realm really has no displayName (otherwise the fallback is untested)" {
    local doc
    doc=$(curl -sf "${KEYCLOAK_URL}/realms/${THEME_REALM}")
    # Keycloak's public realm doc echoes displayName only when it is set.
    [[ "$doc" != *'"displayName":"'* ]] || {
        echo "FAIL: realm ${THEME_REALM} sets a displayName — the fallback would never render" >&2
        return 1
    }
}

@test "the login page renders the gremion theme, not the stock fallback" {
    local page
    page=$(login_page)
    [ -n "$page" ]
    [[ "$page" == *"/css/gremion.v2.css"* ]]
    [[ "$page" == *"Gremion"* ]]
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
    # An empty body contains no "??" either — assert there is a page first.
    [ -n "$page" ]
    [[ "$page" != *"??"* ]]
}

@test "the theme stylesheet the page links resolves 200" {
    local page href code
    page=$(login_page)
    href=$(printf '%s' "$page" | grep -o 'href="[^"]*gremion\.v2\.css[^"]*"' | head -1 | sed 's/^href="//; s/"$//')
    [ -n "$href" ]
    case "$href" in
        http*) : ;;
        /*) href="${KEYCLOAK_URL%/auth}${href}" ;;
    esac
    code=$(curl -s -o /dev/null -w '%{http_code}' "$href")
    [ "$code" -eq 200 ]
}
