# services/finance/Dockerfile
# House pattern: build context is the REPO ROOT, NOT services/finance — the
# workspace dep (packages/ports), pnpm-lock.yaml and pnpm-workspace.yaml live
# OUTSIDE this directory, so a services/finance-only context cannot resolve them.
# Build with:
#   docker build -f services/finance/Dockerfile -t gremion/finance-service:<tag> .
# Mirrors services/content/Dockerfile. Lane E1 added @gremion/ports (+ nats): the
# finance leaf is now a NATS consumer of the kernel org-unit mirror stream.
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
COPY services/finance/package.json ./services/finance/
RUN pnpm install --frozen-lockfile

# Copy workspace package sources + the service sources.
COPY upstream/gremion/packages/ports ./upstream/gremion/packages/ports/
COPY services/finance ./services/finance/

# Compile TypeScript → services/finance/dist
WORKDIR /repo/services/finance
RUN pnpm build

# pnpm deploy resolves workspace symlinks into a self-contained dir.
WORKDIR /repo
RUN pnpm --filter finance-service deploy --prod --legacy /deploy

# ---- backfill (TASK-009 lane C / finance-plan.md §2.3, §5) ----
# The RUNTIME image ships only dist/ + production deps — no scripts/, no tsx —
# so the cutover runbook's backfill command cannot run inside it. This target
# is just the fully-built BUILDER stage (full monorepo node_modules incl. the
# tsx devDependency, plus scripts/ and src/ — pnpm build already ran, but the
# backfill script is run directly via tsx, not the compiled dist/). Build:
#   docker build -f services/finance/Dockerfile --target backfill -t <tag> .
# Run (netcup-cutover.md Step 37b / finance-cutover.md step 3):
#   docker run --rm --network <net> -e SRC=... -e TGT=... <tag> \
#     sh -c 'cd /repo/services/finance && exec node_modules/.bin/tsx scripts/backfill.ts ...'
FROM builder AS backfill
WORKDIR /repo

# ---- runtime ----
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /deploy/node_modules ./node_modules
COPY --from=builder /deploy/package.json ./
COPY --from=builder /repo/services/finance/dist ./dist
COPY --from=builder /repo/services/finance/migrations ./migrations
# R2-C3 B3 finding: xsd-validator.ts resolves the vendored EPC pain.001.001.09
# XSD relative to ITS OWN file's directory at runtime
# (dirname(fileURLToPath(import.meta.url)) + '__fixtures__/...'), and esbuild
# bundles everything into dist/index.js — so that directory is dist/, not
# src/bank/. Nothing previously copied src/bank/__fixtures__ into the runtime
# image, so exportSepa's XSD validation would ENOENT on first real call in
# production despite every local test passing (they all run against src/, not
# the built dist/ + this Dockerfile). Verified missing via `docker run --rm
# <tag> node -e "fs.existsSync('/app/dist/__fixtures__/...')"` -> false before
# this line; true after.
COPY --from=builder /repo/services/finance/src/bank/__fixtures__ ./dist/__fixtures__

# A-021: run as the image's built-in non-root `node` user (uid/gid 1000).
USER node

EXPOSE 8080

# Liveness/readiness probe. The health route is guard-exempt and answers
# {"status":"ok"} on :8080.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
