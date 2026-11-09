#!/bin/sh
# Install user_oidc and, when both inputs are present, register Keycloak as the
# provider. This hook runs after Nextcloud's first installation.
#
# On the pilot install neither input exists at the first install: the customer's
# realm is created later, from the panel. The hook therefore installs the app and
# SKIPS the registration; `gremion-services wire <slug>` registers the provider
# once the realm and its `nextcloud` client secret exist.
#
# Why user_oidc with --unique-uid=0: the Nextcloud user id becomes the raw Keycloak
# UUID (the `sub` claim). The committee provisioning in gremion-ui adds members to
# Nextcloud groups by that UUID, so the ids must match exactly.
#
# Inputs (environment, only when set):
#   NEXTCLOUD_OIDC_CLIENT_SECRET  the Keycloak `nextcloud` confidential client secret
#   KEYCLOAK_OIDC_DISCOVERY_URI   the PUBLIC discovery URL of the customer realm: the
#                                 issuer in that document has to match the `iss`
#                                 claim of the tokens Keycloak issues.
set -u

php /var/www/html/occ app:install user_oidc \
  || php /var/www/html/occ app:enable user_oidc \
  || echo "WARNING: user_oidc could not be installed or enabled (app store unreachable?); gremion-services wire will refuse until it is" >&2

if [ -z "${NEXTCLOUD_OIDC_CLIENT_SECRET:-}" ] || [ -z "${KEYCLOAK_OIDC_DISCOVERY_URI:-}" ]; then
  echo "user_oidc: no client secret or discovery URI at install: provider registration skipped (gremion-services wire registers it)"
  exit 0
fi

# `user_oidc:provider <identifier>` is create-or-update, so this is idempotent.
# --check-bearer=1: validate a Keycloak access token presented as
#   `Authorization: Bearer` on WebDAV and API requests. gremion-ui's files proxy
#   authenticates to WebDAV AS each user with their own access token, which must
#   carry `aud: nextcloud` (the gremion-ui client's audience mapper).
# --bearer-provisioning=1: provision a user on the first bearer use as a safety net.
php /var/www/html/occ user_oidc:provider Keycloak \
  --clientid="nextcloud" \
  --clientsecret="${NEXTCLOUD_OIDC_CLIENT_SECRET}" \
  --discoveryuri="${KEYCLOAK_OIDC_DISCOVERY_URI}" \
  --unique-uid=0 \
  --check-bearer=1 \
  --bearer-provisioning=1 \
  || echo "WARNING: the user_oidc provider could not be registered" >&2

# Circles is unused (groupfolders handles committee folders) and throws on every
# federated group event.
php /var/www/html/occ app:disable circles 2>/dev/null || true

echo "user_oidc hook finished"
exit 0
