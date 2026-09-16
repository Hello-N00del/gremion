#!/usr/bin/env bats
# B-01 (spec B T.4): with the boot import deleted, a test stack's Keycloak has
# `master` and nothing else, so the CI integration job creates the realm that
# test/integration/login-theme.bats reads back off the SERVED login page. These
# tests pin the renderer that produces that realm document:
# test/integration/fixtures/render-realm-fixture.py.
#
# The property that matters is the refusal. The template's realm identity is the
# `__REALM_NAME__` sentinel; feeding a sentinel to a live Keycloak creates
# nothing, and every downstream assertion then fails as a 404 that reads like a
# theme bug. The renderer must resolve every sentinel or emit nothing at all.
#
# Run: bats test/realm-fixture.bats

PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
RENDER="${PROJECT_ROOT}/test/integration/fixtures/render-realm-fixture.py"
BASE="${PROJECT_ROOT}/docker/keycloak/realm-export.base.json"

@test "the renderer exists and is a python script" {
    [ -f "$RENDER" ]
    run head -1 "$RENDER"
    [[ "$output" == *"python3"* ]]
}

@test "renders the requested realm name over the template sentinel" {
    run python3 "$RENDER" --realm citest --apex ci.local
    [ "$status" -eq 0 ]
    run bash -c "python3 '$RENDER' --realm citest --apex ci.local | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"realm\"])'"
    [ "$status" -eq 0 ]
    [ "$output" = "citest" ]
}

@test "no __SENTINEL__ survives into the rendered document" {
    run bash -c "python3 '$RENDER' --realm citest --apex ci.local | grep -c '__[A-Z0-9_]*__'"
    # grep exits 1 with a count of 0 when nothing matches; either way the count
    # is what is asserted, never the exit code.
    [ "$output" = "0" ]
}

@test "the rendered realm carries the template's loginTheme, so a theme regression reaches the served page" {
    local template_theme rendered_theme
    template_theme=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["loginTheme"])' "$BASE")
    [ -n "$template_theme" ]
    rendered_theme=$(python3 "$RENDER" --realm citest --apex ci.local \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["loginTheme"])')
    [ "$rendered_theme" = "$template_theme" ]
}

@test "the gremion-ui client registers a concrete redirect_uri the authorize endpoint can accept" {
    # login-theme.bats picks a non-wildcard, non-sentinel redirect_uri off this
    # client. A rendered realm that offers none makes that suite fail on an
    # empty body instead of on the theme.
    run bash -c "python3 '$RENDER' --realm citest --apex ci.local | python3 -c '
import json, sys
d = json.load(sys.stdin)
c = [c for c in d[\"clients\"] if c[\"clientId\"] == \"gremion-ui\"][0]
print(len([u for u in c.get(\"redirectUris\") or [] if \"*\" not in u and \"__\" not in u]))
'"
    [ "$status" -eq 0 ]
    [ "$output" -ge 1 ]
}

@test "refuses to emit a document in which a sentinel survived" {
    local mutated="${BATS_TEST_TMPDIR}/mutated.json"
    python3 -c '
import json, sys
d = json.load(sys.stdin)
d["displayNameHtml"] = "__UNRESOLVED_TOKEN__"
json.dump(d, sys.stdout)
' < "$BASE" > "$mutated"
    run python3 "$RENDER" --realm citest --apex ci.local --base "$mutated"
    [ "$status" -ne 0 ]
    [[ "$output" == *"__UNRESOLVED_TOKEN__"* ]]
    [[ "$output" == *"refusing to emit"* ]]
}

@test "refuses a base template that does not exist" {
    run python3 "$RENDER" --realm citest --base "${BATS_TEST_TMPDIR}/absent.json"
    [ "$status" -ne 0 ]
    [[ "$output" == *"does not exist"* ]]
}

@test "uses a caller-supplied client secret when the environment names one" {
    run bash -c "GREMION_UI_OIDC_CLIENT_SECRET=fixture-ui-secret python3 '$RENDER' --realm citest | python3 -c '
import json, sys
d = json.load(sys.stdin)
c = [c for c in d[\"clients\"] if c[\"clientId\"] == \"gremion-ui\"][0]
print(c[\"secret\"])
'"
    [ "$status" -eq 0 ]
    [ "$output" = "fixture-ui-secret" ]
}
