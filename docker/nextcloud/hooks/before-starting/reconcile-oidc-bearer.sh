#!/bin/sh
# before-starting hook: runs on EVERY container start (after Nextcloud's install or
# upgrade step, before apache accepts traffic), unlike post-installation, which
# fires only on the very first install.
#
# The user_oidc Keycloak provider must have --check-bearer=1 for Nextcloud to
# accept the Keycloak access token gremion-ui presents as `Authorization: Bearer`
# on WebDAV. A provider registered WITHOUT that flag makes WebDAV answer 401 for
# every file request. This hook re-asserts the flag on every start, idempotently.
#
# Best-effort by design: every step is guarded, so a hiccup here never blocks the
# container from starting. It does NOT touch allow_local_remote_servers: the
# provider's discovery URI is the customer's PUBLIC issuer, so Nextcloud's SSRF
# guard stays on.
set -u
OCC="php /var/www/html/occ"

# Only meaningful once Nextcloud is installed.
$OCC status 2>/dev/null | grep -q "installed: true" || exit 0

# Group Folders backs the per-committee workspace mounts; re-enable it as a
# per-start safety net (a no-op when it is absent or already enabled).
$OCC app:enable groupfolders >/dev/null 2>&1 || true

# Re-assert bearer validation on the Keycloak provider when it exists. Passing
# only these flags is an update that keeps client id, secret and discovery URI.
if $OCC user_oidc:provider 2>/dev/null | grep -q "Keycloak"; then
  $OCC user_oidc:provider Keycloak \
    --check-bearer=1 \
    --bearer-provisioning=1 \
    --unique-uid=0 >/dev/null 2>&1 \
    && echo "reconcile-oidc-bearer: ensured check-bearer=1 on provider Keycloak" \
    || echo "reconcile-oidc-bearer: provider update skipped (non-fatal)"
fi

exit 0
