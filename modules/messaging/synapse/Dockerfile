# Synapse image of the chat module (service `matrix`, image gremion-synapse),
# ported from the extraction source's Synapse image (TASK-198).
#
# Upstream pinned by tag AND index digest (TRD-350, TRD-425; Q3: 1.160,
# verified on PostgreSQL 18 by the scratch proof). A bump moves both together.
FROM matrixdotorg/synapse:v1.163.0@sha256:e98ab72138d90fa8b8876c6421fe78a9fdb181c0d7cc690ad740e5173e0c65e6

# No apt layer: the render shim substitutes its named variables in Python
# (the image's own), so gettext-base/envsubst is not installed. The synapse
# upstream image expects to start as root so its entrypoint can chown /data to
# the synapse user before dropping privileges (accepted risk: the upstream
# start.py drops to the synapse user itself).
# nosemgrep: dockerfile.security.last-user-is-root.last-user-is-root
USER root

# No S3 media offload (TASK-198 Q5: MinIO is not deployed, TRD-354): media
# and the signing key live only in the synapse-data volume.

# Bake log.config into the image at a path outside /data.
# Avoids bind-mounting a single file into the named synapse-data volume,
# which on Docker Desktop for Windows causes root-owned /data and breaks
# signing-key generation for the synapse user.
RUN mkdir -p /etc/synapse /config
COPY log.config /etc/synapse/log.config
RUN chmod 0644 /etc/synapse/log.config

# The template is baked too (no bind mount, release-1 D7.5): a template edit
# is an image rebuild, and the running config is always the one the image
# was tested with.
COPY homeserver.yaml /config/homeserver.yaml.tpl
COPY entrypoint.sh /gremion-synapse-entrypoint.sh
COPY render-homeserver.sh /render-homeserver.sh
COPY healthcheck.sh /synapse-healthcheck.sh
COPY db-preflight.py /db-preflight.py
COPY inject-jwt-key.py /inject-jwt-key.py
# The one-time admin-bot bootstrap (docker compose exec matrix bash /bootstrap.sh).
COPY bootstrap.sh /bootstrap.sh
RUN chmod 0644 /config/homeserver.yaml.tpl \
 && chmod 0755 /gremion-synapse-entrypoint.sh /render-homeserver.sh /synapse-healthcheck.sh /db-preflight.py /inject-jwt-key.py /bootstrap.sh

# Healthy means login works (TRD-178): the JWT flow and the oidc-keycloak
# provider are both offered. Replaces the upstream /health probe, which reads
# healthy with jwt_config disabled. start-period: SYNAPSE_KC_MAX (30) key-fetch
# attempts of ~7 s each, plus the measured first boot; compose repeats it.
HEALTHCHECK --interval=15s --timeout=10s --start-period=240s --retries=3 CMD ["/synapse-healthcheck.sh"]

ENTRYPOINT ["/gremion-synapse-entrypoint.sh"]
