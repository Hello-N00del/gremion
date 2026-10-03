#!/bin/sh
# Synapse's healthcheck (TASK-198, TRD-178; release-1 D7.4). Baked into the
# image as /synapse-healthcheck.sh and named by both the Dockerfile
# HEALTHCHECK and the compose service.
#
# Healthy means LOGIN WORKS, not "the process answers": the entrypoint boots
# Synapse with jwt_config disabled when the identity provider's realm key
# cannot be fetched, and /_matrix/client/versions answers 200 either way. So
# this reads GET /_matrix/client/v3/login and exits 0 only when its flows list
#   - org.matrix.login.jwt (gremion-ui's token exchange), and
#   - an m.login.sso flow whose identity_providers include oidc-keycloak.
# Anything else -- a missing arm, an unreachable listener, a body that is not
# a login-flows document -- exits 1 and says which.
#
# SYNAPSE_PROBE_URL overrides the URL (the tests feed file:// bodies);
# SYNAPSE_PROBE_MAX_TIME bounds the request (seconds, default 5).
set -eu

url="${SYNAPSE_PROBE_URL:-http://127.0.0.1:8008/_matrix/client/v3/login}"
max_time="${SYNAPSE_PROBE_MAX_TIME:-5}"

if ! body="$(curl -sf --max-time "$max_time" "$url")"; then
  echo "synapse-healthcheck: GET $url failed" >&2
  exit 1
fi

printf '%s' "$body" | python3 -c '
import json
import sys

try:
    doc = json.load(sys.stdin)
except ValueError:
    print("synapse-healthcheck: the login endpoint did not answer JSON", file=sys.stderr)
    sys.exit(1)
flows = doc.get("flows") if isinstance(doc, dict) else None
if not isinstance(flows, list):
    print("synapse-healthcheck: no flows list in the login response", file=sys.stderr)
    sys.exit(1)
types = [f.get("type") for f in flows if isinstance(f, dict)]
idps = [
    p.get("id")
    for f in flows
    if isinstance(f, dict) and f.get("type") == "m.login.sso"
    for p in (f.get("identity_providers") or [])
    if isinstance(p, dict)
]
problems = []
if "org.matrix.login.jwt" not in types:
    problems.append("login flow org.matrix.login.jwt is not offered (jwt_config disabled?)")
if "oidc-keycloak" not in idps:
    problems.append("SSO identity provider oidc-keycloak is not offered")
for p in problems:
    print("synapse-healthcheck: " + p, file=sys.stderr)
sys.exit(1 if problems else 0)
'
