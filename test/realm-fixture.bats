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

# --- gremion#6: the platform SMTP block -------------------------------------
# The base template carries the sender as __SMTP_*__ sentinels, filled on the
# product path by smtpServerBlock() in
# gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts. This renderer is
# the SECOND consumer of that template (.github/workflows/ci.yml pipes its
# stdout straight into the Keycloak Admin API), so a sentinel it does not know
# is a CI integration lane that cannot create its realm at all.

@test "the rendered realm carries a resolved smtpServer the Admin API can accept" {
    run bash -c "python3 '$RENDER' --realm citest --apex ci.local | python3 -c '
import json, sys
s = json.load(sys.stdin)[\"smtpServer\"]
bad = [k for k in (\"host\", \"port\", \"from\", \"user\", \"password\", \"auth\", \"starttls\", \"ssl\")
       if not str(s.get(k, \"\")).strip() or \"__\" in str(s.get(k, \"\"))]
print(\",\".join(bad) or \"none\")
'"
    [ "$status" -eq 0 ]
    [ "$output" = "none" ]
}

@test "the rendered smtpServer mirrors the provisioner's 465-vs-other TLS carrier rule" {
    # ONE source of truth: RealmRepresentation has no requireTLS field, so
    # starttls/ssl are the carrier — 465 is the single implicit-TLS port and
    # every other port must negotiate STARTTLS (realm-doc.ts smtpServerBlock).
    # A fixture that renders a different transport proves a realm the product
    # never composes.
    run bash -c "python3 '$RENDER' --realm citest --apex ci.local --smtp-port 465 | python3 -c '
import json, sys
s = json.load(sys.stdin)[\"smtpServer\"]
print(s[\"port\"], s[\"ssl\"], s[\"starttls\"])
'"
    [ "$status" -eq 0 ]
    [ "$output" = "465 true false" ]
    run bash -c "python3 '$RENDER' --realm citest --apex ci.local --smtp-port 587 | python3 -c '
import json, sys
s = json.load(sys.stdin)[\"smtpServer\"]
print(s[\"port\"], s[\"ssl\"], s[\"starttls\"])
'"
    [ "$status" -eq 0 ]
    [ "$output" = "587 false true" ]
}

@test "the fixture sender is the unroutable sink, never the platform submission host" {
    # CI creates this realm in a LIVE Keycloak. A fixture that inherited
    # mail.<apex> would make an integration run authenticate to the platform
    # relay and deliver real mail, so the default host is the sink and the
    # password is generated, never a committed literal.
    run bash -c "python3 '$RENDER' --realm citest --apex ci.local | python3 -c '
import json, sys
s = json.load(sys.stdin)[\"smtpServer\"]
print(s[\"host\"])
'"
    [ "$status" -eq 0 ]
    [ "$output" = "null-sink" ]
    # …and the whole rendered document names the apex mail host nowhere.
    run bash -c "python3 '$RENDER' --realm citest --apex ci.local | grep -c 'mail\.ci\.local'"
    [ "$output" = "0" ]
}

@test "refuses an SMTP port outside the port range" {
    # Mirrors smtpServerBlock's own refusal. Asserted on the MESSAGE, not just
    # the exit code: argparse rejects an unknown option with the same non-zero
    # status, so an exit-code-only test would pass against a renderer that never
    # learned the option at all.
    run python3 "$RENDER" --realm citest --apex ci.local --smtp-port 70000
    [ "$status" -ne 0 ]
    [[ "$output" == *"refusing"* ]]
    [[ "$output" == *"70000"* ]]
}

# Security sweep 2 (findings 3 and 6): the realm the CI stack actually imports
# carries the OTP-or-deny step-up gate, the password policy, refresh-token
# rotation and PKCE on gremion-ui. A fixture realm without them would let the
# integration suite pass against a weaker realm than production runs.
@test "the rendered realm carries the OTP-or-deny stepup-2fa, never a REQUIRED OTP form" {
    run bash -c "python3 '$RENDER' --realm citest --apex ci.local | python3 -c '
import json, sys
d = json.load(sys.stdin)
flows = {f[\"alias\"]: f for f in d[\"authenticationFlows\"]}
f2 = flows[\"stepup-2fa\"][\"authenticationExecutions\"]
assert not [e for e in f2 if e.get(\"authenticator\") == \"auth-otp-form\"]
sub = [e for e in f2 if e.get(\"authenticatorFlow\")]
assert len(sub) == 1 and sub[0][\"requirement\"] == \"REQUIRED\"
kids = sorted(flows[sub[0][\"flowAlias\"]][\"authenticationExecutions\"], key=lambda e: e[\"priority\"])
assert [(e[\"authenticator\"], e[\"requirement\"]) for e in kids] == [(\"auth-otp-form\", \"ALTERNATIVE\"), (\"deny-access-authenticator\", \"ALTERNATIVE\")]
print(\"ok\")
'"
    [ "$status" -eq 0 ]
    [ "$output" = "ok" ]
}

@test "the rendered realm carries the password policy and gremion-ui PKCE S256, and no refresh-token rotation" {
    run bash -c "python3 '$RENDER' --realm citest --apex ci.local | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d[\"passwordPolicy\"] == \"length(12) and notUsername and notEmail and passwordHistory(3)\"
assert \"revokeRefreshToken\" not in d and \"refreshTokenMaxReuse\" not in d
ui = [c for c in d[\"clients\"] if c[\"clientId\"] == \"gremion-ui\"][0]
assert ui[\"attributes\"][\"pkce.code.challenge.method\"] == \"S256\"
print(\"ok\")
'"
    [ "$status" -eq 0 ]
    [ "$output" = "ok" ]
}
