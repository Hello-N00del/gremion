#!/bin/sh
# Make the config directory writable by www-data before the installation.
# A file bound into a named-volume directory makes Docker create that directory
# root-owned (755), which blocks the installer from writing config.php.
chown www-data:root /var/www/html/config
chmod 750 /var/www/html/config
