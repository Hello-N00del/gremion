#!/bin/sh
# Install and enable Group Folders after Nextcloud's first installation. The app
# id is still `groupfolders` despite the "Team folders" display name.
# app:install downloads and enables in one step; app:enable covers an app that
# was already downloaded. A failure is NOT silent: it prints a warning the
# container log keeps, and `gremion-services wire` reads `occ app:list` back and
# fails while the app is not enabled. It never blocks the install.
set -u

php /var/www/html/occ app:install groupfolders \
  || php /var/www/html/occ app:enable groupfolders \
  || echo "WARNING: groupfolders could not be installed or enabled (app store unreachable?); gremion-services wire will refuse until it is" >&2

echo "groupfolders hook finished"
exit 0
