# Nextcloud for the pilot's files and votes modules (service `nextcloud`, image
# gremion-nextcloud). The official apache image, pinned by digest: the tag names
# the major, the digest is what runs. To re-pin after an intentional bump:
#   docker buildx imagetools inspect nextcloud:33-apache --format '{{.Manifest.Digest}}'
FROM nextcloud:33-apache@sha256:81cb09055a20142521a267cea2bc27e6a81a065871c70850d209f08803567dbc

# Custom configuration, copied into the Nextcloud source tree. On the first
# container start the entrypoint copies /usr/src/nextcloud into /var/www/html (the
# data volume), this file included, with the right ownership. It is not
# bind-mounted: a single file bound into a named-volume directory makes Docker
# create that directory root-owned, which breaks the installer's write of
# config.php.
COPY config/custom.config.php /usr/src/nextcloud/config/custom.config.php

# Apps are NOT installed at build time: `occ app:install` needs a configured
# instance (config.php and a database) that does not exist during `docker build`.
# groupfolders, polls, user_oidc and richdocuments are installed at runtime by the
# post-installation hooks below. Those hooks end in a visible warning, never in a
# silent failure, and never block the install; `gremion-services wire` reads
# `occ app:list` back and fails if an app is not enabled.

# Entrypoint hooks:
#   post-installation  first install only
#   before-starting    every start (self-heals config drift)
# (No pre-installation hook: nothing is bind-mounted into the config directory.)
COPY hooks/post-installation/ /docker-entrypoint-hooks.d/post-installation/
COPY hooks/before-starting/   /docker-entrypoint-hooks.d/before-starting/
RUN find /docker-entrypoint-hooks.d -name "*.sh" -exec chmod +x {} \;
