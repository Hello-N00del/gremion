FROM node:22-alpine AS builder
WORKDIR /repo

RUN corepack enable pnpm

# Install workspace deps (cache-friendly: package manifests first)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY gremion-public/package.json ./gremion-public/
RUN pnpm install --frozen-lockfile

# Copy workspace package sources
COPY packages/db ./packages/db/
COPY gremion-public ./gremion-public/

# v12 apex topology — WHERE the portal is mounted is a BUILD-time decision
# (SvelteKit inlines kit.paths.base into the client bundle), so it arrives as a
# build arg, not a runtime env var. Unset/empty = portal at `/`, the kernel
# default. An instance that fans one origin out into landing/portal/auth/app
# builds with `--build-arg BASE_PATH=/portal`.
#
# If you DO set this, the container healthcheck must probe the same path —
# probing `/` returns 404 under a base path, which marks the container unhealthy
# and makes an orchestrator (or Traefik v3, which drops unhealthy containers'
# routers) take the portal offline with no error anywhere in its own log.
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH

# Build (@gremion/db is bundled via ssr.noExternal in vite.config.ts)
WORKDIR /repo/gremion-public
RUN pnpm build

# pnpm deploy resolves workspace symlinks into a self-contained dir
WORKDIR /repo
RUN pnpm --filter gremion-public deploy --prod --legacy /deploy

# ---- runtime ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./
COPY --from=builder /repo/gremion-public/build ./build

# AGPL §4/§5: a conveyed copy must be accompanied by the licence text. See the
# same COPY in gremion-ui/Dockerfile.
COPY LICENSE NOTICE /usr/share/doc/gremion/

# A-021: run as the image's built-in non-root `node` user (uid/gid 1000).
# The SSR server only reads /app (world-readable from the COPYs) and writes
# nothing to disk, so no chown is needed.
USER node

EXPOSE 3000
CMD ["node", "build"]
