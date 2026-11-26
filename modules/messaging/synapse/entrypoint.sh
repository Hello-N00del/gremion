#!/bin/bash
# Render the homeserver config from the baked template (fail-closed), fetch
# the identity provider's realm JWT public key, run the database preflight,
# then hand off to the official Synapse entrypoint (/start.py).
set -euo pipefail

TEMPLATE=/config/homeserver.yaml.tpl
OUTPUT=/data/homeserver.yaml
RENDER_SHIM=/render-homeserver.sh

# SYNAPSE_JWT_LOGIN=on|off (default on). off: the render has no jwt_config and no
# oidc_providers, so there is no realm key to fetch and nothing to inject -- the
# fetch and inject-jwt-key.py below are skipped (the injector would put a
# jwt_config block back into the rendered file).
JWT_LOGIN="${SYNAPSE_JWT_LOGIN-on}"
case "$JWT_LOGIN" in
  on|off) ;;
  *) echo "[gremion-synapse] ERROR: SYNAPSE_JWT_LOGIN must be 'on' or 'off'" >&2; exit 1 ;;
esac

# The realm key wait (below, only with the JWT login on) is judged here, before any step runs.
if [ "$JWT_LOGIN" = "on" ]; then
  KC_MAX="${SYNAPSE_KC_MAX:-30}"
  case "$KC_MAX" in
    ''|*[!0-9]*|0) echo "[gremion-synapse] ERROR: SYNAPSE_KC_MAX must be a positive integer" >&2; exit 1 ;;
  esac
  KC_BUDGET="${SYNAPSE_KC_WAIT_S:-$((KC_MAX * 7))}"
  case "$KC_BUDGET" in
    ''|*[!0-9]*|0) echo "[gremion-synapse] ERROR: SYNAPSE_KC_WAIT_S must be a positive integer (seconds)" >&2; exit 1 ;;
  esac
  KC_INTERVAL="${SYNAPSE_KC_INTERVAL:-2}"
  case "$KC_INTERVAL" in
    ''|*[!0-9]*) echo "[gremion-synapse] ERROR: SYNAPSE_KC_INTERVAL must be a non-negative integer (seconds)" >&2; exit 1 ;;
  esac
fi

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
# The key is fetched until the realm serves a usable key set: a refused
# connection, an HTTP error page (the edge answers one while the identity provider
# is still starting), a body that is not JSON and a document without a usable
# public_key all count as "not yet" (inject-jwt-key.py exits 3). The wait is bounded
# by SYNAPSE_KC_MAX x 7 s (default 30 x 7 = 210 s), which fits inside the
# healthcheck start_period and the deploy tool's wait for the state tier;
# SYNAPSE_KC_WAIT_S overrides the budget in seconds and SYNAPSE_KC_INTERVAL the
# pause between attempts (both for the tests). When the budget is spent the
# container EXITS non-zero (the restart policy tries again): with the JWT login on,
# Synapse never boots without its jwt_config. /synapse-healthcheck.sh remains the
# check of what is actually offered.
if [ "$JWT_LOGIN" = "off" ]; then
  echo "[gremion-synapse] SYNAPSE_JWT_LOGIN=off: jwt_config and oidc_providers are not rendered; the realm key fetch and the key injection are skipped."
else
  KC_FETCH_URL="$("$RENDER_SHIM" --fetch-url)"
  echo "[gremion-synapse] Waiting for the identity provider realm key at ${KC_FETCH_URL} (up to ${KC_BUDGET} s)..."
  KC_TRIES=0
  KC_START=$SECONDS
  while :; do
    KC_RC=0
    KEYCLOAK_FETCH_URL="${KC_FETCH_URL}" python3 /inject-jwt-key.py "$OUTPUT" || KC_RC=$?
    [ "$KC_RC" -eq 0 ] && break
    if [ "$KC_RC" -ne 3 ]; then
      echo "[gremion-synapse] ERROR: the realm key injection failed (exit ${KC_RC}); the container ends." >&2
      exit "$KC_RC"
    fi
    KC_TRIES=$((KC_TRIES + 1))
    KC_ELAPSED=$((SECONDS - KC_START))
    if [ "$KC_ELAPSED" -ge "$KC_BUDGET" ]; then
      echo "[gremion-synapse] ERROR: no realm key from the identity provider after ${KC_TRIES} attempts in ${KC_ELAPSED} s; the container ends instead of starting without jwt_config." >&2
      exit 1
    fi
    echo "[gremion-synapse] realm key not available yet (attempt ${KC_TRIES}, ${KC_ELAPSED} of ${KC_BUDGET} s); retrying in ${KC_INTERVAL} s"
    sleep "$KC_INTERVAL"
  done
fi

# Rendered file must be readable/writable by the synapse user.
if [ "$(id -u)" = "0" ]; then
  chown "${SYNAPSE_USER_UID}:${SYNAPSE_USER_GID}" "$OUTPUT"
fi

# The database preflight: C collation and ctype, PostgreSQL 18, on every
# boot, before Synapse starts. A non-zero exit ends the container here
# (set -e); Synapse never sees a database it would corrupt.
python3 /db-preflight.py "$OUTPUT"

exec /start.py "$@"
