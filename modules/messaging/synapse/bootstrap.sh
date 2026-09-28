#!/usr/bin/env bash
# modules/messaging/synapse/bootstrap.sh
# Run ONCE after first `docker compose up`.
# Usage: docker compose exec matrix bash /bootstrap.sh
#
# TODO: After this script succeeds, rotate/remove
# SYNAPSE_REGISTRATION_SHARED_SECRET from .env and restart Synapse.
# enable_registration is already false in homeserver.yaml, but the
# shared-secret-registration admin endpoint stays open as long as the
# secret is set — so we must rotate it post-bootstrap to fully close
# registration.
set -euo pipefail

SYNAPSE_URL="${SYNAPSE_URL:-http://localhost:8008}"
SERVER_NAME="${SYNAPSE_SERVER_NAME:-localhost}"
SHARED_SECRET="${SYNAPSE_REGISTRATION_SHARED_SECRET}"
BOT_LOCALPART="gremion-admin-bot"
BOT_DISPLAYNAME="Gremion Admin Bot"

echo "==> Waiting for Synapse to be ready..."
until curl -sf "${SYNAPSE_URL}/_matrix/client/versions" > /dev/null; do
  sleep 2
done
echo "    Synapse is up."

# Generate HMAC nonce for shared-secret registration
NONCE=$(curl -sf "${SYNAPSE_URL}/_synapse/admin/v1/register" | python3 -c "import sys,json; print(json.load(sys.stdin)['nonce'])")

# Compute MAC: HMAC-SHA1(shared_secret, nonce + NUL + username + NUL + password + NUL + "admin")
PASSWORD=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
MAC=$(python3 - <<EOF
import hmac, hashlib
secret = b"${SHARED_SECRET}"
nonce = b"${NONCE}"
username = b"${BOT_LOCALPART}"
password = b"${PASSWORD}"
admin = b"admin"
message = nonce + b"\x00" + username + b"\x00" + password + b"\x00" + admin
mac = hmac.new(secret, message, hashlib.sha1).hexdigest()
print(mac)
EOF
)

echo "==> Registering admin bot account @${BOT_LOCALPART}:${SERVER_NAME} ..."
# The registration JSON contains the bot password; passing it as a -d
# argv element exposed it via `ps -ef`/`/proc/<pid>/cmdline` while curl ran.
# Feed the body in on stdin with `--data-binary @-` instead so the password
# never appears on the command line. The request body is byte-identical.
REGISTER_RESPONSE=$(printf '{"nonce":"%s","username":"%s","password":"%s","admin":true,"displayname":"%s","mac":"%s"}' \
  "${NONCE}" "${BOT_LOCALPART}" "${PASSWORD}" "${BOT_DISPLAYNAME}" "${MAC}" \
  | curl -sf -XPOST "${SYNAPSE_URL}/_synapse/admin/v1/register" \
      -H "Content-Type: application/json" \
      --data-binary @-)

# Take the access token straight from the register response —
# the shared-secret endpoint returns access_token/user_id/device_id
# directly and is independent of password_config. Do NOT add an
# m.login.password round-trip here: password_config.enabled renders
# from SYNAPSE_PASSWORD_AUTH (render-homeserver.sh) and defaults to
# false, so a password login would be rejected on any hardened
# deployment. The random password above is required by the register
# API but is never used afterwards.
ACCESS_TOKEN=$(echo "${REGISTER_RESPONSE}" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo ""
echo "==> Bootstrap complete."
echo "    Add the following to your .env file:"
echo ""
echo "    SYNAPSE_ADMIN_TOKEN=${ACCESS_TOKEN}"
echo "    SYNAPSE_ADMIN_BOT_USER_ID=@${BOT_LOCALPART}:${SERVER_NAME}"
echo ""
echo "    Then restart the gremion-ui service:"
echo "    docker compose restart gremion-ui"
echo ""
echo "    Rotate SYNAPSE_REGISTRATION_SHARED_SECRET in .env now, then:"
echo "      docker compose restart matrix"
echo "    This fully closes the shared-secret-registration endpoint."
