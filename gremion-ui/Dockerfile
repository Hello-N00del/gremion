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
COPY packages/nats-auth/package.json ./packages/nats-auth/
# The bin file must exist when pnpm installs, or pnpm cannot link
# gremion-ui/node_modules/.bin/nats-auth and `pnpm exec nats-auth init` (the
# tenant-create call in make nats-init, gremion-deploy, pooled-stack-proof)
# fails "Command not found" (TASK-024 image.test.ts, scripts/image-check.sh).
COPY packages/nats-auth/bin ./packages/nats-auth/bin/
COPY packages/ports/package.json ./packages/ports/
COPY packages/storage/package.json ./packages/storage/
COPY packages/tokens/package.json ./packages/tokens/
# TASK-043 G4: the tenant-create verbs (gremion-tenant init/create/suspend/
# resume/reconcile) run @gremion/provisioning over TASK-021's lifecycle, the
# edge router render and the module catalogue -- devDependencies of
# gremion-ui, so, like nats-auth, they live in this builder stage only.
COPY packages/provisioning/package.json ./packages/provisioning/
COPY packages/tenant-store/package.json ./packages/tenant-store/
COPY packages/module-catalogue/package.json ./packages/module-catalogue/
COPY packages/generated-clients/package.json ./packages/generated-clients/
COPY packages/edge-routers/package.json ./packages/edge-routers/
# TASK-077 G6: the tenancy primitives gremion-ui's tenant/ files re-export (bundled, ssr.noExternal).
COPY packages/tenancy-core/package.json ./packages/tenancy-core/
COPY gremion-ui/package.json ./gremion-ui/
RUN pnpm install --frozen-lockfile

# Copy workspace package sources
COPY packages/db ./packages/db/
# @gremion/nats-auth is a gremion-ui DEVdependency (TASK-024 G5, Q11): the
# builder stage -- the migrate/tenant-create image -- runs `nats-auth init` and
# ensureTenantAccount; `deploy --prod` below leaves it out of the runner, so the
# long-running gremion-ui cannot load it.
COPY packages/nats-auth ./packages/nats-auth/
COPY packages/ports ./packages/ports/
COPY packages/storage ./packages/storage/
COPY packages/tokens ./packages/tokens/
COPY packages/provisioning ./packages/provisioning/
COPY packages/tenant-store ./packages/tenant-store/
COPY packages/module-catalogue ./packages/module-catalogue/
COPY packages/generated-clients ./packages/generated-clients/
COPY packages/edge-routers ./packages/edge-routers/
COPY packages/tenancy-core ./packages/tenancy-core/
# TASK-043 G4: the module catalogue tenant-create enables from -- every
# module.json (loadCatalogue's one-entry-per-directory rule) and the migration
# directory of each module that declares a database. No module source, no
# module package.json (they would become workspace projects of this install).
COPY modules/board/module.json ./modules/board/
COPY modules/board/migrations ./modules/board/migrations/
COPY modules/calendar/module.json ./modules/calendar/
COPY modules/calendar/migrations ./modules/calendar/migrations/
COPY modules/content/module.json ./modules/content/
COPY modules/content/migrations ./modules/content/migrations/
COPY modules/finance/module.json ./modules/finance/
COPY modules/finance/migrations ./modules/finance/migrations/
COPY modules/publishing/module.json ./modules/publishing/
COPY modules/publishing/migrations ./modules/publishing/migrations/
COPY modules/vault/module.json ./modules/vault/
COPY modules/vault/migrations ./modules/vault/migrations/
COPY modules/elections/module.json ./modules/elections/
COPY modules/files/module.json ./modules/files/
COPY modules/handover/module.json ./modules/handover/
COPY modules/messaging/module.json ./modules/messaging/
COPY modules/votes/module.json ./modules/votes/
# TASK-205 Q1: the in-process half of every ENABLED module (routes, api routes, lib/server,
# components, manifest) lives once under modules/<id>/app and is copied onto gremion-ui/src by
# scripts/interim-module-overlay.mjs, the first step of `pnpm build`'s prebuild. Without these COPYs
# the overlay would find no module and refuse (zero modules), so the image build fails loudly
# instead of shipping a kernel with no module routes. disabled.json is what keeps a disabled
# module out of the overlay. interim-module-overlay.test.mjs pins this list against modules/*/app.
COPY modules/disabled.json ./modules/
COPY modules/board/app ./modules/board/app/
COPY modules/calendar/app ./modules/calendar/app/
COPY modules/files/app ./modules/files/app/
COPY modules/messaging/app ./modules/messaging/app/
COPY modules/votes/app ./modules/votes/app/
COPY modules/elections/app ./modules/elections/app/
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
