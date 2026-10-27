# modules/board/Dockerfile
# House pattern: the build context is the REPO ROOT, NOT modules/board — the
# pnpm-lock.yaml and pnpm-workspace.yaml live OUTSIDE this directory, so a
# modules/board-only context cannot resolve the workspace. Build with:
#   docker build -f modules/board/Dockerfile -t gremion/board:<tag> .
# Mirrors gremion-ui/Dockerfile. The board leaf bundles @gremion/tenant-store (per-tenant
# board store) and its workspace deps @gremion/db + @gremion/module-catalogue (+ @gremion/generated-clients), so those
# packages are copied from the tree; NO @gremion/ports.
FROM node:26-alpine AS builder
WORKDIR /repo

# node:26-alpine no longer bundles corepack (dropped from core in Node 25+);
# install it from npm first so `corepack enable pnpm` has a binary to enable.
# The pnpm version actually used is still pinned by package.json's
# "packageManager" field (read lazily on first `pnpm` invocation, i.e. after
# the COPY below), so this does not change which pnpm version builds the app.
RUN npm install -g corepack && corepack enable pnpm

# Install workspace deps (cache-friendly: package manifests first).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/generated-clients/package.json ./packages/generated-clients/
COPY packages/module-catalogue/package.json ./packages/module-catalogue/
COPY packages/tenant-store/package.json ./packages/tenant-store/
COPY modules/board/package.json ./modules/board/
RUN pnpm install --frozen-lockfile

# Copy workspace package sources + the service sources.
COPY packages/db ./packages/db/
COPY packages/generated-clients ./packages/generated-clients/
COPY packages/module-catalogue ./packages/module-catalogue/
COPY packages/tenant-store ./packages/tenant-store/
COPY modules/board ./modules/board/

# Compile TypeScript → modules/board/dist
WORKDIR /repo/modules/board
RUN pnpm build

# pnpm deploy resolves the package into a self-contained dir.
WORKDIR /repo
RUN pnpm --filter board-service deploy --prod --legacy /deploy

# ---- runtime ----
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./
COPY --from=builder /repo/modules/board/dist ./dist
COPY --from=builder /repo/modules/board/migrations ./migrations

# A-021: run as the image's built-in non-root `node` user (uid/gid 1000).
USER node

EXPOSE 8080

# Liveness/readiness probe. The health route is guard-exempt and answers
# {"status":"ok"} on :8080.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
