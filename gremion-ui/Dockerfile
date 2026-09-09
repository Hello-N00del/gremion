FROM node:26-alpine AS builder
WORKDIR /repo

# node:26-alpine no longer bundles corepack (dropped from core in Node 25+);
# install it from npm first so `corepack enable pnpm` has a binary to enable.
# The pnpm version actually used is still pinned by package.json's
# "packageManager" field (read lazily on first `pnpm` invocation, i.e. after
# the COPY below), so this does not change which pnpm version builds the app.
RUN npm install -g corepack && corepack enable pnpm

# Install workspace deps (cache-friendly: package manifests first)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/ports/package.json ./packages/ports/
COPY gremion-ui/package.json ./gremion-ui/
RUN pnpm install --frozen-lockfile

# Copy workspace package sources
COPY packages/db ./packages/db/
COPY packages/ports ./packages/ports/
COPY gremion-ui ./gremion-ui/

# Build the SvelteKit app (@gremion/db + @gremion/ports bundled via ssr.noExternal)
WORKDIR /repo/gremion-ui
RUN pnpm build

# pnpm deploy resolves workspace symlinks into a self-contained dir
WORKDIR /repo
RUN pnpm --filter gremion-ui deploy --prod --legacy /deploy

# ---- runtime ----
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./
COPY --from=builder /repo/gremion-ui/build ./build
COPY --from=builder /repo/gremion-ui/migrations ./migrations
# P2.1c (#202): control-plane registry migrations (tenant registry + fleet
# ledger) read at boot by runControlMigrations(). Without this COPY the runtime
# image lacks /app/migrations-control and boot fails ENOENT — a deploy bug latent
# until the first deploy since P2.1a.
COPY --from=builder /repo/gremion-ui/migrations-control ./migrations-control

# AGPL §4/§5: a conveyed copy must be accompanied by the licence text. This
# image IS a conveyed copy — without these two files the recipient of the image
# has the program and not its licence. NOTICE additionally carries the OFL-1.1
# notices for the three font families Vite bakes into ./build.
COPY LICENSE NOTICE /usr/share/doc/gremion/

# Per-tenant config files live here (/data/<slug>/config.json — see registry.ts
# configPathForTenant). This dir formerly also held the newsletter SQLite store,
# removed in Task 23; the dir handling stays because tenant config still uses it.
# A-021: run as the image's built-in non-root `node` user (uid/gid 1000) and give
# it ownership of /data so the provisioner's per-tenant config writes succeed
# under runAsNonRoot. /app is world-readable from the COPYs above (read-only at runtime).
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000
CMD ["node", "build"]
