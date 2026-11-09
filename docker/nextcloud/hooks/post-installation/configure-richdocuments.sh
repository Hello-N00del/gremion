#!/bin/sh
# Point Nextcloud Office (richdocuments) at Collabora. This hook runs once, after
# Nextcloud's first installation.
#
#   COLLABORA_PUBLIC_URL    the browser-facing editor base: the pilot tenant host's
#                           /office router (https://<tenant host>/office).
#   COLLABORA_SERVICE_ROOT  Collabora's net.service_root (/office): the internal
#                           discovery and WOPI mount moves with it.
#
# The internal wopi_url is always the Collabora service name on the state network.
set -u

PUBLIC_URL="${COLLABORA_PUBLIC_URL:-}"
INTERNAL_URL="http://collabora:9980${COLLABORA_SERVICE_ROOT:-}"

if [ -z "$PUBLIC_URL" ]; then
  echo "WARNING: COLLABORA_PUBLIC_URL is unset: richdocuments is not configured" >&2
  exit 0
fi

php /var/www/html/occ app:install richdocuments || php /var/www/html/occ app:enable richdocuments \
  || echo "WARNING: richdocuments could not be installed or enabled (app store unreachable?); gremion-services wire will refuse until it is" >&2

# wopi_url        Nextcloud -> Collabora (the internal network)
# public_wopi_url browser -> Collabora (the tenant host)
php /var/www/html/occ config:app:set richdocuments wopi_url --value="$INTERNAL_URL"
php /var/www/html/occ config:app:set richdocuments public_wopi_url --value="$PUBLIC_URL"

# Documents the file picker offers to the editor. A PDF opens in annotation mode.
php /var/www/html/occ config:app:set richdocuments mimetypes \
  --value='application/pdf,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation'

# Fetch the WOPI discovery from Collabora and cache it. Collabora may come up after
# Nextcloud finishes installing, so retry up to 10 times, 10 seconds apart.
max_retries=10
retries=0
activated=0
while [ "$retries" -lt "$max_retries" ]; do
  if php /var/www/html/occ richdocuments:activate-config 2>/dev/null; then
    echo "richdocuments: WOPI discovery cached"
    activated=1
    break
  fi
  retries=$((retries + 1))
  echo "richdocuments: Collabora not ready yet, retry ${retries}/${max_retries} in 10 s"
  sleep 10
done

if [ "$activated" -ne 1 ]; then
  echo "WARNING: richdocuments could not reach Collabora after ${max_retries} tries; gremion-services wire runs occ richdocuments:activate-config again" >&2
fi

# activate-config resets wopi_callback_url: set it back. It must be the internal
# URL, so Collabora can reach Nextcloud for WOPI file operations.
php /var/www/html/occ config:app:set richdocuments wopi_callback_url --value="http://nextcloud"

echo "richdocuments hook finished: internal=${INTERNAL_URL}, public=${PUBLIC_URL}"
exit 0
