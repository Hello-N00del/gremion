#!/bin/bash
# Substitute env vars in the homeserver config template, fetch the Keycloak
# realm JWT public key, then hand off to the official Synapse entrypoint.
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

if [ -f "$TEMPLATE" ]; then
  # Render the YAML via the shim so that registration_shared_secret
  # is stripped unless BOOTSTRAP_MODE=1. The shim's `exec "$@"` at the end
  # is satisfied by `true`, a deliberate no-op — we want the render to
  # complete in-place and continue this script (which still needs to do
  # the Keycloak key injection below).
  SYNAPSE_TEMPLATE="$TEMPLATE" SYNAPSE_CONFIG="$OUTPUT" "$RENDER_SHIM" true

  # Fetch the Keycloak realm RSA public key and inject it into jwt_config.secret
  # as a PEM block. Required because docker-compose env vars cannot safely carry
  # multi-line PEM (newlines collapse, breaking authlib's PEM framing parser).
  # Keycloak's realm root endpoint exposes the signing public key as a base64
  # SPKI string under `public_key`; we wrap it into a standard PEM envelope.
  #
  # Two URLs are used because Keycloak stamps tokens with a public-facing iss
  # claim that the matrix container itself cannot reach over Docker DNS:
  #   * KEYCLOAK_ISSUER_URL    — the iss claim Synapse must validate
  #                              (e.g. https://example.org/auth/realms/<realm>)
  #   * KEYCLOAK_INTERNAL_URL  — the Docker-internal URL the entrypoint hits
  #                              to fetch the realm's public_key
  #                              (e.g. http://keycloak:8080/auth/realms/<realm>)
  # If KEYCLOAK_INTERNAL_URL is unset, KEYCLOAK_ISSUER_URL is used for both.
  #
  # If Keycloak is unreachable, the Python step disables jwt_config so Synapse
  # still starts (instead of crashing on an empty/malformed secret).
  KC_FETCH_URL="${KEYCLOAK_INTERNAL_URL:-${KEYCLOAK_ISSUER_URL:-}}"
  if [ -n "${KC_FETCH_URL}" ]; then
    echo "[gremion-synapse] Waiting for Keycloak realm at ${KC_FETCH_URL}..."
    KC_TRIES=0
    KC_MAX=30
    until curl -sf --max-time 5 "${KC_FETCH_URL}" >/dev/null 2>&1; do
      KC_TRIES=$((KC_TRIES + 1))
      if [ "$KC_TRIES" -ge "$KC_MAX" ]; then
        echo "[gremion-synapse] WARNING: Keycloak unreachable after ${KC_MAX} attempts — jwt_config will be disabled." >&2
        break
      fi
      sleep 2
    done
  fi

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
fi

exec /start.py "$@"
