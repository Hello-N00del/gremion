# Synapse image of the chat module (service `matrix`), ported from the
# extraction source's Synapse image.
FROM matrixdotorg/synapse:v1.124.0

# Install envsubst (comes with gettext-base). The synapse upstream image
# expects to start as root so its entrypoint can chown /data to the synapse
# user before dropping privileges (accepted risk: the upstream start.py drops
# to the synapse user itself).
# nosemgrep: dockerfile.security.last-user-is-root.last-user-is-root
USER root
RUN apt-get update -qq && apt-get install -y --no-install-recommends gettext-base && rm -rf /var/lib/apt/lists/*

# No S3 media offload (TASK-198 Q5: MinIO is not deployed, TRD-354): media
# and the signing key live only in the synapse-data volume.

# Bake log.config into the image at a path outside /data.
# Avoids bind-mounting a single file into the named synapse-data volume,
# which on Docker Desktop for Windows causes root-owned /data and breaks
# signing-key generation for the synapse user.
RUN mkdir -p /etc/synapse
COPY log.config /etc/synapse/log.config
RUN chmod 0644 /etc/synapse/log.config

COPY entrypoint.sh /gremion-synapse-entrypoint.sh
COPY render-homeserver.sh /render-homeserver.sh
RUN chmod +x /gremion-synapse-entrypoint.sh /render-homeserver.sh

ENTRYPOINT ["/gremion-synapse-entrypoint.sh"]
