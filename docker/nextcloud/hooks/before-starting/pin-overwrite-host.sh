#!/bin/sh
# before-starting hook: runs on EVERY container start (after Nextcloud's install or
# upgrade step, before apache accepts traffic).
#
# 'overwritehost' and 'overwrite.cli.url' pin the host Nextcloud uses when it cannot
# detect one from an HTTP request: cron jobs, occ, and getCollaboraEditorUrl's
# server-side fetch of the direct-view page. config/custom.config.php sets both from
# NEXTCLOUD_OVERWRITEHOST / NEXTCLOUD_OVERWRITECLIURL, but that file reaches the
# persistent data volume only on the very first start, so a stale volume keeps a
# stale copy. This hook re-asserts both values through occ on every start.
#
# It acts only when the variable is set: an empty value means "auto-detect" and
# must not clobber a value set another way. Best-effort: every step is guarded, so
# a hiccup never blocks the container from starting.
set -u
OCC="php /var/www/html/occ"

# Only meaningful once Nextcloud is installed.
$OCC status 2>/dev/null | grep -q "installed: true" || exit 0

if [ -n "${NEXTCLOUD_OVERWRITEHOST:-}" ]; then
  $OCC config:system:set overwritehost --value="$NEXTCLOUD_OVERWRITEHOST" >/dev/null 2>&1 \
    && echo "pin-overwrite-host: ensured overwritehost=${NEXTCLOUD_OVERWRITEHOST}" \
    || echo "pin-overwrite-host: overwritehost set skipped (non-fatal)"
fi

if [ -n "${NEXTCLOUD_OVERWRITECLIURL:-}" ]; then
  $OCC config:system:set overwrite.cli.url --value="$NEXTCLOUD_OVERWRITECLIURL" >/dev/null 2>&1 \
    && echo "pin-overwrite-host: ensured overwrite.cli.url=${NEXTCLOUD_OVERWRITECLIURL}" \
    || echo "pin-overwrite-host: overwrite.cli.url set skipped (non-fatal)"
fi

exit 0
