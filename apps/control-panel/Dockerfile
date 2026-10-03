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

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS builder
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

# ---- runtime ----
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./
COPY --from=builder /repo/apps/control-panel/build ./build

# AGPL §4/§5: a conveyed copy carries its licence.
COPY LICENSE NOTICE /usr/share/doc/gremion/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "build"]
