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

# Object storage (DEFAULT-OFF): the synapse-s3-storage-provider module lets
# homeserver.yaml offload the media repository to S3/MinIO when
# SYNAPSE_MEDIA_S3_ENABLED=true (render-homeserver.sh appends the
# media_storage_providers block). Installed unconditionally into Synapse's venv
# (pip on PATH is the matrix-synapse venv pip) — it is inert until the rendered
# config references it. Pinned; bump via Dependabot after smoke-testing.
RUN pip install --no-cache-dir synapse-s3-storage-provider==1.6.1

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
