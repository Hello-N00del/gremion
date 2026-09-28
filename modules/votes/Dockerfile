# services/votes/Dockerfile
# D-P1-1 house pattern: build context is the REPO ROOT, NOT services/votes —
# pnpm-lock.yaml and pnpm-workspace.yaml live OUTSIDE this directory, so a
# services/votes-only context cannot resolve them. Build with:
#   docker build -f services/votes/Dockerfile -t gremion/votes:<tag> .
# Mirrors services/files/Dockerfile. The votes leaf is stateless (no PG/NATS,
# no migrations) and has no workspace deps — it bundles via esbuild.
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
COPY services/votes/package.json ./services/votes/
RUN pnpm install --frozen-lockfile

# Copy the service sources.
COPY services/votes ./services/votes/

# Compile + bundle TypeScript → services/votes/dist/index.js
WORKDIR /repo/services/votes
RUN pnpm build

# pnpm deploy resolves the prod dependency tree into a self-contained dir.
WORKDIR /repo
RUN pnpm --filter votes-service deploy --prod --legacy /deploy

# ---- runtime ----
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./
COPY --from=builder /repo/services/votes/dist ./dist

# A-021: run as the image's built-in non-root `node` user (uid/gid 1000).
USER node

EXPOSE 8080

# Liveness/readiness probe. The health route is guard-exempt and answers
# {"status":"ok"} on :8080.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
