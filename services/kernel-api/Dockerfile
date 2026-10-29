# services/kernel-api/Dockerfile -- the Gremion kernel API (TASK-077, L3-17).
#
# One image, two commands (the compose services kernel-api and
# kernel-api-migrate share it):
#   node dist/index.js                          serve on PORT (default 3000)
#   node dist/index.js migrate [--customer id]  the per-customer migrate job
#
# Built like the house services: esbuild bundles the service and the workspace
# packages it uses into dist/index.js (Node refuses TypeScript type stripping
# under node_modules, and `pnpm deploy --prod` puts workspace packages there
# with `exports` pointing at ./src/*.ts), the npm packages that stay external
# come from `pnpm deploy --prod`, every FROM is pinned by digest, the runtime
# user is not root and nothing is written at runtime (compose: read_only,
# cap_drop ALL, no-new-privileges; the migrate job gets a tmpfs-free dump
# volume of its own).
#
# The image mirrors the kernel tree under /app so main.ts finds the register
# (scripts/migrations/ranges.json) and the module declarations
# (modules/<key>/module.json -- registry DATA only, never module code) the same
# way it does in a checkout:
#   /app/services/kernel-api/{dist,openapi,migrations,node_modules,package.json}
#   /app/scripts/migrations/ranges.json
#   /app/modules/<key>/module.json
#
# pg_dump / pg_restore 18 (TASK-075's pre-migration dump, same major as the
# PostgreSQL 18 server) come from the Alpine package of the matching major.
#
# Build context: the repository root.
#   docker build -f services/kernel-api/Dockerfile -t ghcr.io/hello-n00del/gremion-kernel-api:<tag> .

FROM node:26-alpine@sha256:7c6af15abe4e3de859690e7db171d0d711bf37d27528eddfe625b2fe89e097f8 AS builder
WORKDIR /repo

# node:26-alpine bundles no corepack (dropped from core in Node 25+); the pnpm
# version is still pinned by package.json's "packageManager".
RUN npm install -g corepack && corepack enable pnpm

# Manifests first (cache-friendly): the service and the workspace packages it
# depends on, directly or through them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/kernel-api/package.json ./services/kernel-api/
COPY packages/db/package.json ./packages/db/
# TASK-080-a: the identity event relay (events) and the NATS seed store / connect options (nats-auth, ports).
COPY packages/events/package.json ./packages/events/
COPY packages/nats-auth/package.json ./packages/nats-auth/
COPY packages/ports/package.json ./packages/ports/
# tenant-store's devDependency: `pnpm deploy --legacy` resolves it although nothing bundles it.
COPY packages/retention/package.json ./packages/retention/
COPY packages/tenant-store/package.json ./packages/tenant-store/
COPY packages/tenancy-core/package.json ./packages/tenancy-core/
COPY packages/fastify-service-template/package.json ./packages/fastify-service-template/
COPY packages/module-catalogue/package.json ./packages/module-catalogue/
COPY packages/generated-clients/package.json ./packages/generated-clients/
RUN pnpm install --frozen-lockfile --filter @gremion/kernel-api...

COPY packages/db ./packages/db/
COPY packages/events ./packages/events/
COPY packages/nats-auth ./packages/nats-auth/
COPY packages/ports ./packages/ports/
COPY packages/retention ./packages/retention/
COPY packages/tenant-store ./packages/tenant-store/
COPY packages/tenancy-core ./packages/tenancy-core/
COPY packages/fastify-service-template ./packages/fastify-service-template/
COPY packages/module-catalogue ./packages/module-catalogue/
COPY packages/generated-clients ./packages/generated-clients/
COPY services/kernel-api ./services/kernel-api/
# The register reader the migrate job composes (imported relatively, bundled) and
# the register itself.
COPY scripts/migrations/pre-apply.mjs scripts/migrations/ranges.json ./scripts/migrations/
WORKDIR /repo/services/kernel-api
RUN pnpm build

WORKDIR /repo
RUN pnpm --filter @gremion/kernel-api deploy --prod --legacy /deploy

# Registry data only: each module's declaration, nothing else of modules/.
COPY modules ./modules/
RUN mkdir -p /registry/modules \
 && for f in modules/*/module.json; do d="$(dirname "$f")"; mkdir -p "/registry/$d"; cp "$f" "/registry/$f"; done

# ---- runtime ----
FROM node:26-alpine@sha256:7c6af15abe4e3de859690e7db171d0d711bf37d27528eddfe625b2fe89e097f8 AS runner
RUN apk add --no-cache postgresql18-client
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY --from=builder /deploy/node_modules ./services/kernel-api/node_modules
COPY --from=builder /repo/services/kernel-api/package.json ./services/kernel-api/
COPY --from=builder /repo/services/kernel-api/dist ./services/kernel-api/dist
COPY --from=builder /repo/services/kernel-api/openapi ./services/kernel-api/openapi
COPY --from=builder /repo/services/kernel-api/migrations ./services/kernel-api/migrations
COPY --from=builder /repo/scripts/migrations/ranges.json ./scripts/migrations/ranges.json
COPY --from=builder /registry/modules ./modules

# AGPL s4/s5: a conveyed copy carries its licence.
COPY LICENSE NOTICE /usr/share/doc/gremion/

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "services/kernel-api/dist/index.js"]
