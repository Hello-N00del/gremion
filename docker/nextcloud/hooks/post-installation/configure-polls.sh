#!/bin/sh
# Install and enable the Polls app after Nextcloud's first installation (the
# votes module's Polls client talks to it). app:install downloads from the app
# store and enables in one step; app:enable covers an app that was already
# downloaded. A failure prints a warning instead of vanishing, and never blocks
# the install: `gremion-services wire` reads `occ app:list` back and fails while
# polls is not enabled.
set -u

php /var/www/html/occ app:install polls \
  || php /var/www/html/occ app:enable polls \
  || echo "WARNING: polls could not be installed or enabled (app store unreachable?); gremion-services wire will refuse until it is" >&2

echo "polls hook finished"
exit 0
