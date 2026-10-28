# modules/vault/Dockerfile
# House pattern: the build context is the REPO ROOT, NOT modules/vault — the
# pnpm-lock.yaml and pnpm-workspace.yaml live OUTSIDE this directory, so a
# modules/vault-only context cannot resolve the workspace. Build with:
#   docker build -f modules/vault/Dockerfile -t gremion/vault:<tag> .
# Mirrors modules/board/Dockerfile. The vault leaf is self-contained (postgres +
# zod only — NO @gremion/ports), so no packages/* are copied.
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
COPY modules/vault/package.json ./modules/vault/
# Retry to ride out corepack's pnpm bootstrap (its own 10s connect timeout, not
# governed by pnpm config) + any registry hiccups on a constrained uplink. Fails hard
# after 5 attempts (the `until` loop exits 1) so a broken install never ships.
RUN i=0; until pnpm install --frozen-lockfile; do i=$((i+1)); [ $i -ge 5 ] && exit 1; echo "pnpm install failed, retry $i in 20s"; sleep 20; done

# Copy the service sources.
COPY modules/vault ./modules/vault/

# Compile TypeScript → modules/vault/dist
WORKDIR /repo/modules/vault
RUN pnpm build

# pnpm deploy resolves the package into a self-contained dir.
WORKDIR /repo
RUN pnpm --filter vault-service deploy --prod --legacy /deploy

# ---- runtime ----
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./
COPY --from=builder /repo/modules/vault/dist ./dist
COPY --from=builder /repo/modules/vault/migrations ./migrations

# A-021: run as the image's built-in non-root `node` user (uid/gid 1000).
USER node

EXPOSE 8080

# Liveness/readiness probe. The health route is guard-exempt and answers
# {"status":"ok"} on :8080.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
