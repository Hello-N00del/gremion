# services/content/Dockerfile
# D-P1-1 house pattern: build context is the REPO ROOT, NOT services/content —
# the workspace dep (packages/ports), pnpm-lock.yaml and pnpm-workspace.yaml
# live OUTSIDE this directory, so a services/content-only context cannot
# resolve them. Build with:
#   docker build -f services/content/Dockerfile -t gremion/content:<tag> .
# Mirrors gremion-ui/Dockerfile:1-22.
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
# #453: @gremion/ports lives in the `upstream/gremion` git submodule (the kernel
# repo), not in this repo. Requires `git submodule update --init` on the host, and
# the in-image path must match the host path or `--frozen-lockfile` rejects the
# importer set. Rationale (no credential in-container for a git dependency):
# gremion-ui/Dockerfile.
COPY upstream/gremion/packages/ports/package.json ./upstream/gremion/packages/ports/
COPY services/content/package.json ./services/content/
RUN pnpm install --frozen-lockfile

# Copy workspace package sources + the service sources.
COPY upstream/gremion/packages/ports ./upstream/gremion/packages/ports/
COPY services/content ./services/content/

# Compile TypeScript → services/content/dist
WORKDIR /repo/services/content
RUN pnpm build

# pnpm deploy resolves workspace symlinks into a self-contained dir.
WORKDIR /repo
RUN pnpm --filter content-service deploy --prod --legacy /deploy

# ---- runtime ----
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./
COPY --from=builder /repo/services/content/dist ./dist
COPY --from=builder /repo/services/content/migrations ./migrations

# A-021: run as the image's built-in non-root `node` user (uid/gid 1000).
USER node

EXPOSE 8080

# Liveness/readiness probe (compose/k8s reference this in Task 17/18). The
# health route is guard-exempt and answers {"status":"ok"} on :8080.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
