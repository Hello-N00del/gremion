**English** | [Deutsch](./README.de.md)

# vault

Secrets store for organisational units: items with metadata, secrets encrypted at rest
(AES-256-GCM) by the leaf process, a reveal path that requires a recent step-up login and
appends to an access log, and a launcher page for an externally run Vaultwarden instance.
Status: **disabled by default** (listed in `modules/disabled.json`, so it is excluded from
the default build and deploy; [docs/modules.md](../../docs/modules.md)).

| | |
|---|---|
| Directory / `module.json` id | `vault` |
| Manifest id (`config.modules` key) | `vault` |
| Package | `vault-service` |
| Navigation | segment `/vault` (minimum role: member) with a "Tresor" entry; `/vault-extern` for the Vaultwarden launcher |
| Leaf service | yes, listens on `PORT` (default 8080); the only backend, there is no in-process implementation |

## Layout

| Path | Contents |
|---|---|
| `app/` | The in-process half, overlaid onto `gremion-ui/src/`: pages, API routes, the service client behind the backend port, vault view helpers, manifest. |
| `src/` | The leaf: `http/` (server, guard, routes), `store/`, `crypto.ts`. |
| `migrations/` | Leaf schema and the generated `manifest.json`. |
| `scripts/build-migration-manifest.mjs` | Writes `migrations/manifest.json`; runs as `prebuild`. |
| `test/` | Leaf unit and integration tests. |

## Routes and API surface

Kernel app (`app/routes/`):

| Route | Methods |
|---|---|
| `/vault`, `/vault-extern` | pages |
| `/api/vault` | GET, POST |
| `/api/vault/[id]` | GET, PUT, DELETE |
| `/api/vault/[id]/secret` | GET (reveal; answers 401 `STEP_UP_REQUIRED` until a fresh second-level login exists) |
| `/api/vault/access-log` | GET |

`/vault-extern` only links to the instance named by `VAULTWARDEN_BASE_URL`; the kernel does
not provision or manage it. Until the variable is set the page shows a disabled state.

Leaf (`src/http/routes.ts`), shared-secret guard except `/health` and `/healthz`:
`GET|POST /items`, `GET|PUT|DELETE /items/:id`, `GET /items/:id/secret`, `GET /access-log`.

## Migrations

The leaf uses one database configured by `VAULT_PG_URL`; migrations run on first store
contact and are checked against `migrations/manifest.json`.

| File | Content |
|---|---|
| `001_init.sql` | `vault_item` (metadata plus secret ciphertext) and `access_log` |
| `002_access_log_survives_delete.sql` | access-log rows are kept when their item is deleted |

Disabling the module for a tenant exports the database with `pg_dump` (retention profile
`rp-pwd-module-data`), withholding `public.vault_item.secret_ciphertext` (`module.json`).

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `VAULT_BACKEND` | kernel app | `service` (default) is the only valid value. |
| `VAULT_SERVICE_URL` | kernel app | Base URL of the leaf. |
| `INTERNAL_VAULT_SECRET` | both | Shared secret in `x-internal-auth`. Unset: the leaf boots and every guarded route answers 403. |
| `VAULT_PG_URL` | leaf | PostgreSQL URL of the leaf's database; required, no default. |
| `VAULT_ENCRYPTION_KEY` | leaf | 64 hex characters (32 bytes), the AES-256-GCM key. Missing or malformed: the leaf refuses to start. |
| `VAULT_REVEAL_REQUIRE_STEPUP` | kernel app | On by default; `false` switches the step-up requirement for reveal off. |
| `STEPUP_FRESHNESS_SECONDS` | kernel app | How recent the second-level login must be. |
| `VAULTWARDEN_BASE_URL` | kernel app | Address of an externally run Vaultwarden for the launcher page. |
| `PORT`, `TRACE_EXPORTER` | leaf, app | Listen port; tracing exporter. |

The module's PostgreSQL server is `vault-postgres` under the compose profile `vault`
(`VAULT_PG_USER`, `VAULT_PG_PASSWORD`).

## External services

- The module's PostgreSQL server.
- Vaultwarden, only for the launcher page and only if the operator runs one.

## Enabling and disabling

- Build: **excluded** by `modules/disabled.json`; the tenant-lifecycle runbook requires a
  module not to be in that file before it can be enabled for a customer.
- Instance setting: `config.modules.vault = false` answers `/vault` and `/api/vault` with the
  module-disabled surface and drops the navigation entry.
- Leaf: `docker build -f modules/vault/Dockerfile .` from the repository root.

## Tests

- `pnpm --filter vault-service test` (unit, `test/`), `typecheck`.
- `pnpm --filter vault-service test:integration`: needs a throwaway PostgreSQL via
  `VAULT_TEST_PG_URL`; `test/support/pg-test-guard.ts` refuses a database that is not a
  disposable local one.
- Tests under `app/` sit next to the code and are not collected by the package's `test`
  script.

## Not established from the code

- The leaf reads one `VAULT_PG_URL`. Anything about how a deployment arranges databases
  above that is outside this directory and not described here.
