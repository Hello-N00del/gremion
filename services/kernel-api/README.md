# @gremion/kernel-api

The kernel API (TASK-077, L3-17): tenancy resolution and the module registry, as a spec-first
service on `@gremion/fastify-service-template`. TRD-407 (first half), TRD-082, TRD-353.

- **Spec:** `openapi/kernel-core.json` (OpenAPI 3.1, the service's only spec; registry entry
  `kernel-core`, generated client `createKernelCoreClient`). Dependants append their operations
  under their own tag and their handlers to `src/handlers/index.ts`, sorted by operationId.
- **Routes:** `GET /healthz` (no tenant), `GET /api/v1/tenancy/self`, `GET /api/v1/modules`.
  `pnpm --filter @gremion/fastify-service-template routes:check` diffs the route table against the spec.

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
`service:kernel-api`, class `tenant-store`) lives in each customer's kernel database, ledger
`idt.schema_migration`, beside the legacy kernel-data ledger `public.schema_migrations`. The service
never migrates on a request or at boot; it refuses to boot when a shipped file does not match its
manifest (TRD-353).

```
kernel-api migrate                    # every active/suspended customer (the kernel-api-migrate one-shot)
kernel-api migrate --customer <id>    # one customer (also provisioning), e.g. after it is created
```

Per customer: its control row, the same credentials on the direct server
(`GREMION_KERNEL_PG_DIRECT_URL`, never PgBouncer), TASK-029's chain check, ONE pre-migration dump
(`GREMION_MIGRATION_DUMP_DIR`, TASK-075), `SET ROLE k_<hex32>_owner`, apply, verify. It goes on past a
failure and exits non-zero naming every failed customer. The generic
`packages/tenant-store/src/dump/cli.ts migrate` refuses this chain.

## Environment

| Variable | Use |
|---|---|
| `TENANT_PROXY_SHARED_SECRET` | required; the proxy trust header's value |
| `PLATFORM_DOMAIN` | required; the apex whose reserved names never resolve |
| `KERNEL_API_CONTROL_DB_URL`, `KERNEL_API_PLATFORM_DB_URL` | required; the reader role (`ensureKernelApiReader`) |
| `KERNEL_API_MODULE_SECRET_<ID>` | one per module that calls back in (24+ characters) |
| `GREMION_RELEASE_REF` | the release this image ships (gate, ledger, dump) |
| `GREMION_KERNEL_PG_DIRECT_URL`, `GREMION_MIGRATION_DUMP_DIR` | migrate only |
| `PORT` | default 3000 |

## Tests

`pnpm --filter @gremion/kernel-api test` (in-process: fakes, local jose issuers);
`pnpm --filter @gremion/kernel-api test:integration` (a scratch PostgreSQL 18 started by
`test/harness/stack.mjs` with `docker run`, named `t077-<sha8>-*`, removed by name).
