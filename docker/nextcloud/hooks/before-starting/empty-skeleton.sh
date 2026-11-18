#!/bin/sh
# before-starting hook: runs on EVERY container start (after Nextcloud's install or
# upgrade step, before apache accepts traffic).
#
# New users must start with an empty home. Nextcloud copies its skeleton directory
# (Readme.md, Nextcloud.png, a sample document) into every newly created user's
# files. config/custom.config.php sets 'skeletondirectory' to the empty string, but
# that file reaches the persistent data volume only on the very first start, so a
# stale volume keeps the default. This hook re-asserts the empty value through occ
# on every start. It only changes what NEW users receive; the files of existing
# users are not touched.
#
# Best-effort: a failure warns but never blocks the container from starting.
set -u
OCC="php /var/www/html/occ"

# Only meaningful once Nextcloud is installed.
$OCC status 2>/dev/null | grep -q "installed: true" || exit 0

if $OCC config:system:set skeletondirectory --value= >/dev/null 2>&1; then
  echo "empty-skeleton: ensured skeletondirectory is empty"
else
  echo "empty-skeleton: WARNING skeletondirectory set failed (non-fatal); new users may get sample files"
fi

exit 0
