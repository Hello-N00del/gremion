#!/bin/sh
# before-starting hook: runs on EVERY container start (after Nextcloud's install or
# upgrade step, before apache accepts traffic), unlike post-installation, which
# fires only on the very first install.
#
# One Nextcloud serves every customer host. The primary customer's user_oidc provider is
# named Keycloak; a customer on a secondary host has its own provider, Keycloak-<slug>
# (gremion-services wire registers it). A provider needs --check-bearer=1 for Nextcloud to
# accept the Keycloak access token gremion-ui presents as `Authorization: Bearer` on
# WebDAV; one registered WITHOUT that flag makes WebDAV answer 401 for every file request
# of that customer. This hook re-asserts the flags on EVERY provider that occ lists, on
# every start, idempotently.
#
# Only the provider named exactly Keycloak is told --unique-uid=0 (the raw Keycloak id, which
# the committee provisioning relies on). A secondary customer's provider keeps the uid scheme
# it was registered with (hashed with its provider id, so an id its realm signs can never be
# the id of an account of the primary customer): the hook never passes --unique-uid for it.
#
# Best-effort by design: every step is guarded, so a hiccup here never blocks the
# container from starting, and one provider that fails to update is a warning that names it
# while the others are still updated. It does NOT touch allow_local_remote_servers: the
# provider's discovery URI is the customer's PUBLIC issuer, so Nextcloud's SSRF guard stays on.
set -u
OCC="${OCC:-php /var/www/html/occ}"

# Only meaningful once Nextcloud is installed.
$OCC status 2>/dev/null | grep -q "installed: true" || exit 0

# Group Folders backs the per-committee workspace mounts; re-enable it as a
# per-start safety net (a no-op when it is absent or already enabled).
$OCC app:enable groupfolders >/dev/null 2>&1 || true

# Re-assert bearer validation on every provider. Passing only these flags is an update that
# keeps client id, secret and discovery URI.
if providers="$($OCC user_oidc:provider --output=json 2>&1)"; then
  # The identifiers, tolerant of a compact or a pretty-printed list.
  ids="$(printf '%s
' "$providers"     | grep -o '"identifier"[[:space:]]*:[[:space:]]*"[^"]*"'     | sed 's/^"identifier"[[:space:]]*:[[:space:]]*"//; s/"$//')"
  primary_seen=0
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    # An identifier is a plain name; anything else is never handed to occ as an argument.
    if ! printf '%s' "$id" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'; then
      echo "reconcile-oidc-bearer: ignoring a provider whose identifier is not a plain name (non-fatal)"
      continue
    fi
    uid_flag=""
    if [ "$id" = "Keycloak" ]; then
      primary_seen=1
      uid_flag="--unique-uid=0"
    fi
    # shellcheck disable=SC2086 # $OCC is a command line, $uid_flag is empty or one option
    $OCC user_oidc:provider "$id"       --check-bearer=1       --bearer-provisioning=1       $uid_flag </dev/null >/dev/null 2>&1       && echo "reconcile-oidc-bearer: ensured check-bearer=1 on provider $id"       || echo "reconcile-oidc-bearer: WARNING provider update failed for $id (non-fatal); WebDAV may answer 401 for that customer until the flag is set"
  done <<EOF_IDS
$ids
EOF_IDS
  if [ "$primary_seen" -eq 0 ]; then
    echo "reconcile-oidc-bearer: WARNING no provider named Keycloak is registered (non-fatal); WebDAV answers 401 until gremion-services wire registers it"
  fi
else
  echo "reconcile-oidc-bearer: WARNING occ user_oidc:provider failed (non-fatal): $(printf '%s' "$providers" | head -n 1)"
fi

exit 0
