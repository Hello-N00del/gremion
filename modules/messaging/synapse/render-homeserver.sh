#!/usr/bin/env bash
# Renders /data/homeserver.yaml from the template with optional
# bootstrap-mode injection of registration_shared_secret.
#
# registration_shared_secret only appears in the rendered
# config when BOOTSTRAP_MODE=1. Outside of that one-time bootstrap
# window, the line is stripped so the shared-secret admin-register
# endpoint is unreachable even if the env var is still set.
#
# The script is invoked from two places:
#   1. modules/messaging/synapse/entrypoint.sh (real container init)
#   2. modules/messaging/synapse/test/*.test.mjs (the module's tests)
#
# Inputs (env vars):
#   SYNAPSE_TEMPLATE   path to the YAML template
#                      (default: /etc/synapse/homeserver.yaml.tpl)
#   SYNAPSE_CONFIG     path to the rendered YAML
#                      (default: /data/homeserver.yaml)
#   BOOTSTRAP_MODE     "1" -> keep registration_shared_secret;
#                      anything else -> strip it (default: "0")
#
# After rendering, `exec "$@"` so the script can be used as an
# entrypoint prefix without forking a subshell.
set -euo pipefail

TPL="${SYNAPSE_TEMPLATE:-/etc/synapse/homeserver.yaml.tpl}"
OUT="${SYNAPSE_CONFIG:-/data/homeserver.yaml}"

# Env-gated security knobs. envsubst has no ${VAR:-default}
# syntax, so the defaults live HERE: unset vars get the conservative
# production posture (password auth OFF, Synapse's upstream rate-limit
# defaults). The dev compose override opts in to the relaxed dev values.
export SYNAPSE_PASSWORD_AUTH="${SYNAPSE_PASSWORD_AUTH:-false}"
# The OIDC provider's display name (was a fixed literal in the template).
export SYNAPSE_IDP_NAME="${SYNAPSE_IDP_NAME:-Gremion}"
case "$SYNAPSE_PASSWORD_AUTH" in
  true|false) ;;
  *)
    echo "[render-homeserver] ERROR: SYNAPSE_PASSWORD_AUTH must be 'true' or 'false', got '${SYNAPSE_PASSWORD_AUTH}'." >&2
    exit 1
    ;;
esac
export SYNAPSE_RC_LOGIN_ADDRESS_PER_SECOND="${SYNAPSE_RC_LOGIN_ADDRESS_PER_SECOND:-0.003}"
export SYNAPSE_RC_LOGIN_ADDRESS_BURST="${SYNAPSE_RC_LOGIN_ADDRESS_BURST:-5}"
export SYNAPSE_RC_LOGIN_ACCOUNT_PER_SECOND="${SYNAPSE_RC_LOGIN_ACCOUNT_PER_SECOND:-0.003}"
export SYNAPSE_RC_LOGIN_ACCOUNT_BURST="${SYNAPSE_RC_LOGIN_ACCOUNT_BURST:-5}"
export SYNAPSE_RC_MESSAGE_PER_SECOND="${SYNAPSE_RC_MESSAGE_PER_SECOND:-0.2}"
export SYNAPSE_RC_MESSAGE_BURST="${SYNAPSE_RC_MESSAGE_BURST:-10}"
# Numeric guard — a non-numeric value would inject raw YAML into the render.
for v in SYNAPSE_RC_LOGIN_ADDRESS_PER_SECOND SYNAPSE_RC_LOGIN_ADDRESS_BURST \
         SYNAPSE_RC_LOGIN_ACCOUNT_PER_SECOND SYNAPSE_RC_LOGIN_ACCOUNT_BURST \
         SYNAPSE_RC_MESSAGE_PER_SECOND SYNAPSE_RC_MESSAGE_BURST; do
  val="${!v}"
  case "$val" in
    ''|*[!0-9.]*|*.*.*)
      echo "[render-homeserver] ERROR: $v must be a plain non-negative number, got '${val}'." >&2
      exit 1
      ;;
  esac
done

envsubst < "$TPL" > "$OUT"

if [[ "${BOOTSTRAP_MODE:-0}" != "1" ]]; then
  # Strip the registration_shared_secret line. Only matches at column 0
  # so commented references in surrounding text are left untouched.
  sed -i '/^registration_shared_secret:/d' "$OUT"
fi

# Object storage (DEFAULT-OFF): when SYNAPSE_MEDIA_S3_ENABLED=true, append an
# S3 media-storage-provider block so Synapse offloads its media repository to
# MinIO/S3. The synapse-s3-storage-provider module is baked into the image
# (modules/messaging/synapse/Dockerfile); the S3 knobs arrive as SYNAPSE_MEDIA_S3_* env from
# the matrix service (docker-compose.yml). The flag is unset/false by default, so
# the block is ABSENT and the rendered config is byte-identical to the pre-feature
# render — Synapse keeps using the local media_store_path. Every knob is defaulted
# here so a `SYNAPSE_MEDIA_S3_ENABLED=true`-only render never aborts under set -u.
if [[ "${SYNAPSE_MEDIA_S3_ENABLED:-false}" == "true" ]]; then
  cat >> "$OUT" <<EOF

# Object storage — S3-backed media repository. store_local keeps a local
# copy; store_remote uploads to S3. Knobs: SYNAPSE_MEDIA_S3_* (docker-compose.yml).
media_storage_providers:
  - module: s3_storage_provider.S3StorageProviderBackend
    store_local: true
    store_remote: true
    store_synchronous: true
    config:
      bucket: "${SYNAPSE_MEDIA_S3_BUCKET:-synapse-media}"
      region_name: "${SYNAPSE_MEDIA_S3_REGION:-us-east-1}"
      endpoint_url: "${SYNAPSE_MEDIA_S3_ENDPOINT:-http://minio:9000}"
      access_key_id: "${SYNAPSE_MEDIA_S3_ACCESS_KEY:-}"
      secret_access_key: "${SYNAPSE_MEDIA_S3_SECRET_KEY:-}"
EOF
fi

exec "$@"
