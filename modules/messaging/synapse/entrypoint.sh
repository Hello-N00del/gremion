#!/bin/bash
# Render the homeserver config from the baked template (fail-closed), fetch
# the identity provider's realm JWT public key, run the database preflight,
# then hand off to the official Synapse entrypoint (/start.py).
set -euo pipefail

TEMPLATE=/config/homeserver.yaml.tpl
OUTPUT=/data/homeserver.yaml
RENDER_SHIM=/render-homeserver.sh

# Make sure /data is owned by the synapse user (UID/GID 991 — see the upstream
# matrixdotorg/synapse image's /start.py). The upstream start.py only chowns
# /data in `generate`/`migrate_config` modes, NOT in `run` mode. On Docker
# Desktop for Windows named volumes come up root-owned, which blocks Synapse
# from generating /data/homeserver.signing.key on first start. Do the chown
# here while we still run as root, then let start.py gosu down to 991.
# NOTE: bash exposes $UID as a read-only builtin (current user's uid), so we
# can't use ${UID:-...} for the synapse uid without picking up bash's value
# (= 0 when running as root). Use a distinct variable name and respect any
# SYNAPSE_UID/SYNAPSE_GID overrides from the compose env.
SYNAPSE_USER_UID="${SYNAPSE_UID:-991}"
SYNAPSE_USER_GID="${SYNAPSE_GID:-991}"
if [ "$(id -u)" = "0" ]; then
  chown -R "${SYNAPSE_USER_UID}:${SYNAPSE_USER_GID}" /data
fi

# The template is baked into the image (TASK-198: no bind mount); without it
# there is nothing safe to boot, so its absence is a refusal.
[ -f "$TEMPLATE" ] || { echo "[gremion-synapse] ERROR: $TEMPLATE is missing from the image" >&2; exit 1; }

# Render the YAML via the shim. It refuses (non-zero, and this script exits
# under set -e) a blank required key, a non-integer port and any rendered
# engine other than psycopg2, and strips registration_shared_secret unless
# BOOTSTRAP_MODE=1. The shim's `exec "$@"` at the end is satisfied by
# `true`, a deliberate no-op — the render completes in place and this script
# continues with the key injection below.
SYNAPSE_TEMPLATE="$TEMPLATE" SYNAPSE_CONFIG="$OUTPUT" "$RENDER_SHIM" true

# Fetch the Keycloak realm RSA public key and inject it into jwt_config.secret
# as a PEM block. Required because docker-compose env vars cannot safely carry
# multi-line PEM (newlines collapse, breaking authlib's PEM framing parser).
# Keycloak's realm root endpoint exposes the signing public key as a base64
# SPKI string under `public_key`; we wrap it into a standard PEM envelope.
#
# Two URLs are used because Keycloak stamps tokens with a public-facing iss
# claim, while the key is fetched in-network:
#   * SYNAPSE_KEYCLOAK_ISSUER_URL — the iss claim Synapse must validate
#                                   (e.g. https://example.org/auth/realms/<realm>)
#   * SYNAPSE_KEYCLOAK_FETCH_URL  — where the realm's public_key is fetched;
#                                   blank derives
#                                   http://keycloak:8080/auth/realms/<realm>
#                                   (render-homeserver.sh --fetch-url).
#
# If the realm cannot be reached after SYNAPSE_KC_MAX attempts (default 30,
# about 7 s each), the Python step disables jwt_config so Synapse still
# starts -- degrade-and-boot, made VISIBLE by /synapse-healthcheck.sh, which
# reads unhealthy while the JWT login flow is missing.
KC_FETCH_URL="$("$RENDER_SHIM" --fetch-url)"
KC_MAX="${SYNAPSE_KC_MAX:-30}"
case "$KC_MAX" in
  ''|*[!0-9]*|0) echo "[gremion-synapse] ERROR: SYNAPSE_KC_MAX must be a positive integer" >&2; exit 1 ;;
esac
echo "[gremion-synapse] Waiting for the identity provider realm at ${KC_FETCH_URL}..."
KC_TRIES=0
until curl -sf --max-time 5 "${KC_FETCH_URL}" >/dev/null 2>&1; do
  KC_TRIES=$((KC_TRIES + 1))
  if [ "$KC_TRIES" -ge "$KC_MAX" ]; then
    echo "[gremion-synapse] WARNING: identity provider unreachable after ${KC_MAX} attempts — jwt_config will be disabled." >&2
    break
  fi
  sleep 2
done

KEYCLOAK_FETCH_URL="${KC_FETCH_URL}" python3 - "$OUTPUT" <<'PY'
import json
import os
import sys
import textwrap
import urllib.error
import urllib.request

import yaml

config_path = sys.argv[1]
fetch_url = os.environ.get("KEYCLOAK_FETCH_URL", "").strip()

pem = None
if fetch_url:
    try:
        with urllib.request.urlopen(fetch_url, timeout=10) as r:
            realm_data = json.load(r)
        public_key = realm_data.get("public_key")
        if public_key:
            pem_body = "\n".join(textwrap.wrap(public_key, 64))
            pem = f"-----BEGIN PUBLIC KEY-----\n{pem_body}\n-----END PUBLIC KEY-----\n"
        else:
            sys.stderr.write(
                "[gremion-synapse] Keycloak realm response missing public_key field\n"
            )
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        sys.stderr.write(f"[gremion-synapse] Keycloak fetch failed: {exc}\n")

with open(config_path) as f:
    cfg = yaml.safe_load(f)

jwt_cfg = cfg.setdefault("jwt_config", {})
if pem:
    jwt_cfg["secret"] = pem
    sys.stderr.write(
        "[gremion-synapse] Injected Keycloak realm public key into jwt_config.secret\n"
    )
else:
    # No key available — disable JWT login so Synapse still boots.
    jwt_cfg["enabled"] = False
    jwt_cfg.pop("secret", None)
    sys.stderr.write(
        "[gremion-synapse] WARNING: jwt_config disabled — Keycloak public key unavailable\n"
    )

with open(config_path, "w") as f:
    yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)
PY

# Rendered file must be readable/writable by the synapse user.
if [ "$(id -u)" = "0" ]; then
  chown "${SYNAPSE_USER_UID}:${SYNAPSE_USER_GID}" "$OUTPUT"
fi

# The database preflight: C collation and ctype, PostgreSQL 18, on every
# boot, before Synapse starts. A non-zero exit ends the container here
# (set -e); Synapse never sees a database it would corrupt.
python3 /db-preflight.py "$OUTPUT"

exec /start.py "$@"
