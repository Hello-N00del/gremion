# apps/control-panel/Dockerfile — the ops control panel (TASK-043, section 11 (a)).
#
# Built like gremion-ui (adapter-node, `pnpm deploy --prod`), with every FROM
# pinned by digest, a non-root runtime user and nothing written at runtime, so
# the container runs with a read-only root filesystem (compose: read_only,
# cap_drop ALL, no-new-privileges). The HEALTHCHECK probes /healthz, which
# checks the process and a valid configuration only -- never Keycloak or a
# database -- so the panel is healthy before `gremion-tenant init`.
#
# Build context: the repository root.
#   docker build -f apps/control-panel/Dockerfile -t ghcr.io/hello-n00del/gremion-control-panel:<tag> .

FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS builder
WORKDIR /repo

# node:26-alpine bundles no corepack (dropped from core in Node 25+); the pnpm
# version is still pinned by package.json's "packageManager".
RUN npm install -g corepack && corepack enable pnpm

# Manifests first (cache-friendly); the panel depends on no workspace package.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-panel/package.json ./apps/control-panel/
RUN pnpm install --frozen-lockfile --filter control-panel...

COPY apps/control-panel ./apps/control-panel/
WORKDIR /repo/apps/control-panel
RUN pnpm build

WORKDIR /repo
RUN pnpm --filter control-panel deploy --prod --legacy /deploy

# The code map (apps/control-panel/codemap): a page of the Gremion code that the panel shows to the operator
# (/codemap). It is made HERE, once per image, from the repository as copied below, so it always matches the
# code in this image. It must never be able to fail this build: image-step.sh never exits non-zero, it times
# out its own extractor (300 s, 3 GiB), and on ANY failure it writes a status file that says why and removes
# the half-made files, so the panel shows a notice instead of a map. The "|| true" is a second lock on the same
# door. Nothing here reaches the network, and the copy is filtered so that secret-class files (env files, keys,
# `secrets` folders) do not enter this builder layer: Dockerfile.dockerignore is an allow-list for this image. Only the
# status file and the page reach the runner stage, a read-only folder.
COPY . /codemap-src
RUN mkdir -p /codemap-out && { sh /repo/apps/control-panel/codemap/image-step.sh /codemap-src /codemap-out /repo/apps/control-panel || true; }

# ---- runtime ----
FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    BODY_SIZE_LIMIT=2M

COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./
COPY --from=builder /repo/apps/control-panel/build ./build
# status.json always, code-map.html when the map was made; read-only at runtime (CODEMAP_DIR defaults to /app/codemap)
COPY --from=builder /codemap-out ./codemap

# AGPL §4/§5: a conveyed copy carries its licence.
COPY LICENSE NOTICE /usr/share/doc/gremion/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "build"]
