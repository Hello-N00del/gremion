#!/bin/sh
# before-starting hook: runs on EVERY container start (before pin-overwrite-host.sh, by name).
#
# The document editor posts its messages (save, close, UI_Close) to the origin
# Nextcloud recorded when it minted the WOPI token: the host of the request that
# opened the direct-view page. gremion-ui makes that request server-side, by the
# in-network name, so the origin was http://nextcloud and the browser dropped every
# message. gremion-ui now sends the origin the person's browser has as
# X-Forwarded-Host / X-Forwarded-Proto on that one request. Nextcloud honours the
# headers only when
#   - the sender is a trusted proxy (trusted_proxies: the state network),
#   - no overwritehost / overwriteprotocol pins the answer, and
#   - the host is one of the trusted_domains (otherwise it falls back to its own
#     first trusted domain).
# This hook makes the last two true, idempotently, for an install of any age (the
# custom.config.php copy on a persistent volume is only written on the first start).
#
#   NEXTCLOUD_PUBLIC_HOSTS  comma-separated hosts the browser reaches the app on
#                           (the customer host, PILOT_TENANT_HOST); empty: nothing is done.
#   NEXTCLOUD_OVERWRITEHOST / NEXTCLOUD_OVERWRITEPROTOCOL
#                           an operator who still pins either keeps the old behaviour (the
#                           editor then posts to the in-network name); the hook says so and
#                           removes nothing.
#
# Best-effort: every step is guarded and a hiccup never blocks the container from starting.
set -u
OCC="${OCC:-php /var/www/html/occ}"

[ -n "${NEXTCLOUD_PUBLIC_HOSTS:-}" ] || exit 0

# Only meaningful once Nextcloud is installed.
$OCC status 2>/dev/null | grep -q "installed: true" || exit 0

# ensure_trusted <host> -- append the host to trusted_domains unless it is already listed.
ensure_trusted() {
  host="$1"
  i=0
  while [ "$i" -lt 50 ]; do
    cur="$($OCC config:system:get trusted_domains "$i" 2>/dev/null)" || cur=""
    if [ -z "$cur" ]; then
      $OCC config:system:set trusted_domains "$i" --value="$host" >/dev/null 2>&1 \
        && echo "pin-editor-origin: trusted_domains[$i]=${host}" \
        || echo "pin-editor-origin: trusting ${host} failed (non-fatal)"
      return 0
    fi
    if [ "$cur" = "$host" ]; then
      echo "pin-editor-origin: ${host} already trusted"
      return 0
    fi
    i=$((i + 1))
  done
  echo "pin-editor-origin: no free trusted_domains slot for ${host} (non-fatal)"
}

old_ifs="$IFS"
IFS=','
for host in $NEXTCLOUD_PUBLIC_HOSTS; do
  IFS="$old_ifs"
  host="$(printf '%s' "$host" | tr -d '[:space:]')"
  [ -n "$host" ] || continue
  # A host name with an optional port; anything else is a typo, not a domain.
  if printf '%s' "$host" | grep -Eq '^[A-Za-z0-9.-]+(:[0-9]{1,5})?$'; then
    ensure_trusted "$host"
  else
    echo "pin-editor-origin: ignoring '${host}' (not a host name)"
  fi
  IFS=','
done
IFS="$old_ifs"

# overwritehost / overwriteprotocol win over the forwarded headers: drop a stale pin.
if [ -n "${NEXTCLOUD_OVERWRITEHOST:-}" ] || [ -n "${NEXTCLOUD_OVERWRITEPROTOCOL:-}" ]; then
  echo "pin-editor-origin: NEXTCLOUD_OVERWRITEHOST/PROTOCOL is set, so the editor posts to the in-network name" >&2
  exit 0
fi
for key in overwritehost overwriteprotocol; do
  if [ -n "$($OCC config:system:get "$key" 2>/dev/null)" ]; then
    $OCC config:system:delete "$key" >/dev/null 2>&1 \
      && echo "pin-editor-origin: removed stale ${key}" \
      || echo "pin-editor-origin: removing ${key} failed (non-fatal)"
  fi
done

exit 0
