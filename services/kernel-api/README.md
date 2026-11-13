# @gremion/kernel-api

The kernel API (TASK-077, L3-17): tenancy resolution and the module registry, as a spec-first
service on `@gremion/fastify-service-template`, and on top of them the identity domain (bodies,
seats, persons, memberships, tenures; TASK-080) and the authorization decision point (TASK-081).
TRD-407 (first half), TRD-082, TRD-353.

- **Specs:** `openapi/kernel-core.json` (OpenAPI 3.1; registry entry `kernel-core`, generated
  client `createKernelCoreClient`) and `asyncapi/idt.json` (the identity event class; registry
  entry `kernel-api-idt-events`). Dependants append their operations under their own tag and their
  handlers to `src/handlers/index.ts`, sorted by operationId.
- **Routes:** `GET /healthz` (no tenant); tenancy and modules: `GET /api/v1/tenancy/self`,
  `GET /api/v1/modules`, `GET /api/v1/customer/settings`; identity: `GET /api/v1/bodies/tree`,
  `POST /api/v1/bodies`, `GET /api/v1/bodies/{bodyId}/seats`, `GET|POST
  /api/v1/bodies/{bodyId}/memberships`, `GET /api/v1/seats/{seatId}/tenures`, `POST
  /api/v1/persons`, `GET /api/v1/persons/{personId}`, `GET|PUT /api/v1/persons/me/preference`;
  authorization: `POST /api/v1/authz/decisions`, `GET|POST /api/v1/authz/grants`, `POST
  /api/v1/authz/grants/{grantId}/revoke`, `POST /api/v1/authz/persons/{personId}/revoke-all`.
  `pnpm --filter @gremion/fastify-service-template routes:check` diffs the route table against the spec.
- **Commands:** `node dist/index.js` serves; `migrate [--customer <id>]` (below);
  `authz sync|sweep [--customer <id>]` writes the role and capability catalogue or sweeps grants
  (expired, due, and those of disabled modules); `bodies <verb> --customer <id>` is the operator's
  engine interface to the identity domain (`status`, `create-body`, `create-org-unit`,
  `create-seat`, `create-wahlperiode`, `invite-person`, `start-membership`, `start-tenure`).

## How a request finds its customer

Every operation but `getHealth` passes the tenancy hook (`src/tenancy/hook.ts`):

1. `x-proxy-trust` equals `TENANT_PROXY_SHARED_SECRET` (required at boot), else 403, nothing read.
2. `X-Forwarded-Host` normalises (`@gremion/tenancy-core`, the one normaliser) and `Host` names the
   same host, else 404; a reserved platform name is 404. No registry read in either case.
3. One lookup of the whole host in the control registry (`tenant_domain` joined to `tenant`):
   unbound or provisioning/deleting/deleted is 404 (one `tenant.host.rejected` event), suspended is
   503, the registry down is 503. Nothing is cached.
4. A bearer access token of that customer's realm: exact `iss`, `aud` containing
   `gremion-kernel-api`, RS256, `exp`/`nbf`, keys from that realm's JWKS only. Else 401.
5. The customer's kernel database (`t_<hex32>__kernel`, reached through its own `db_conn_ref`
   secret, never an env fallback) is at the kernel-api manifest in `idt.schema_migration`, else 503
   for that customer only.

A module calling back in (`x-gremion-module`) instead proves its own `KERNEL_API_MODULE_SECRET_<ID>`,
asserts the customer id (`x-tenant-id`, a UUIDv7), may call only the allow-listed operations, and must
be enabled for that customer.

Every response body is checked against the spec before it is sent: an undeclared field is a 500
`response-contract-violation`, never a silent drop.

## Migrations

The kernel-api chain (`scripts/migrations/ranges.json` id `kernel-api`, database
`service:kernel-api`, class `tenant-store`; shipped directories `migrations/{core,bodies,authz}`; the register also names `roles` and `erasure`, which do not exist yet)
lives in each customer's kernel database, ledger `idt.schema_migration`, beside the legacy kernel-data ledger `public.schema_migrations`. The service
never migrates on a request or at boot; it refuses to boot when a shipped file does not match its
manifest (TRD-353).

```
node dist/index.js migrate                    # every active/suspended customer (the kernel-api-migrate one-shot)
node dist/index.js migrate --customer <id>    # one customer (also provisioning), e.g. after it is created
```

Per customer: its control row, the same credentials on the direct server
(`GREMION_KERNEL_PG_DIRECT_URL`, never PgBouncer), TASK-029's chain check, ONE pre-migration dump
(`GREMION_MIGRATION_DUMP_DIR`, TASK-075), `SET ROLE k_<hex32>_owner`, apply, verify. It goes on past a
failure and exits non-zero naming every failed customer. The generic
`packages/tenant-store/src/dump/cli.ts migrate` refuses this chain.

## Environment

| Variable | Use |
|---|---|
| `TENANT_PROXY_SHARED_SECRET` | required, 24+ characters; the proxy trust header's value |
| `PLATFORM_DOMAIN` | required; the apex whose reserved names never resolve |
| `KERNEL_API_CONTROL_DB_URL`, `KERNEL_API_PLATFORM_DB_URL` | required; the reader role (`ensureKernelApiReader`) |
| `KERNEL_API_MODULE_SECRET_<ID>` | one per module that calls back in (24+ characters) |
| `GREMION_RELEASE_REF` | the release this image ships (gate, ledger, dump) |
| `GREMION_KERNEL_PG_DIRECT_URL`, `GREMION_MIGRATION_DUMP_DIR` | migrate only (`KERNEL_API_PG_DUMP_CONTAINER`: scratch stacks only, runs `pg_dump` inside that container) |
| `NATS_URL`, `NATS_SECRETS_DIR` | the broker the identity event relay publishes to (secrets default `/run/secrets/nats`); `NATS_URL` unset: the relay is off, outbox rows wait |
| `AUTHZ_SWEEP_INTERVAL_MS` | the in-process grant sweep cadence in ms (`0` = off); a malformed value refuses boot |
| `KERNEL_API_MODULES_ROOT`, `KERNEL_API_KERNEL_ROOT` | where `modules/<key>/module.json` and `scripts/migrations/ranges.json` are read from (defaults mirror the tree under `/app`) |
| `UPLOAD_CEILING_BYTES` | the request body and upload ceiling (default 50 MiB) |
| `PORT` | default 3000 |

## Tests

`pnpm --filter @gremion/kernel-api test` (in-process: fakes, local jose issuers);
`pnpm --filter @gremion/kernel-api test:integration` (a scratch PostgreSQL 18 started by
`test/harness/stack.mjs` with `docker run`, named `t077-<sha8>-*`, removed by name).
