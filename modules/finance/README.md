# finance

Money handling for an organisation: fiscal years and budget plans (groups and items), sub
organisations, projects, expenses with receipts, a multi-signature approval flow, payment
orders and bookings, bank accounts with transaction import (CSV and FinTS), SEPA export,
cash-box reconciliation, and statement and export output (PDF, spreadsheet). Amounts are
integer euro cents. Status: **disabled by default** (listed in `modules/disabled.json`;
[docs/modules.md](../../docs/modules.md)).

**Only the leaf service is in this tree.** There is no `app/` directory, so no pages, no API
routes and no manifest for the kernel app are carried here. The kernel-side half is not
documented in this README.

| | |
|---|---|
| Directory / `module.json` id | `finance` |
| Manifest id (`config.modules` key) | not in this tree (no manifest file) |
| Package | `finance-service` |
| Navigation segment | not in this tree |
| Leaf service | yes, listens on `PORT` (default 8080) |

## Layout

| Path | Contents |
|---|---|
| `src/` | The leaf: `http/` (router, guard, routes, multipart), `store/`, `tenant-store.ts`, `bank/` (transactions, SEPA backend, XSD validation), `csv/` (import and IBAN checks), `fints/` (client, sync, password crypto), `exports/` (PDF, spreadsheet), `storage/` (receipt storage), the org-unit mirror consumer and `kernel-client.ts`. |
| `migrations/` | Leaf schema and the generated `manifest.json`. |
| `scripts/` | `build-migration-manifest.mjs` (runs as `prebuild`) and `backfill.ts` (one-shot copy from a kernel tenant database). |
| `test/` | Leaf unit and integration tests. |
| `RUNBOOK.md` | Operator notes: receipt storage keys, the refusal of migration 006 over duplicate rows and its pre-flight queries, probes. |

## Routes and API surface

Leaf only (`src/http/routes.ts`), all under the shared-secret guard except `/healthz`, all
below `/api/v1`. Groups, not an exhaustive list:

- `budget`, `budget-plans` (with `groups`, `items`, `request-approval`, `activate`, `close`,
  `statement`, `statement/pdf`, `export`, `fiscal-year`), `fiscal-years`
- `projects`, `expenses` (with `receipts` and receipt `publish`), `bookings`
- `approvals` (`pending`, create, `sign`, `reject`) and `request-approval` on projects and
  expenses
- `bank-accounts` (with `fints`, `fints/sync`, `csv-import`), `bank-transactions/:id/allocate-split`
- `payment-orders` (`record-cash-payout`, `record-manual-payout`, `suggest-matches`),
  `sepa/export`, `cash-boxes/:ledgerId/reconcile`
- `sub-org-types`, `sub-orgs` (with `summary`), `org-units/:orgUnitId/finance-refs`
- `finanzordnung` (with `signer-config`)
- `GET /healthz/tenants`, behind the shared secret, booleans only

## Migrations

One database per tenant (`finance_<slug>`). Applied by the leaf, checked against
`migrations/manifest.json`.

| File | Content |
|---|---|
| `001_finance_init.sql` | the `finance` schema: profiles, units, bank and ledger accounts, transactions, FinTS config, CSV import profiles, reserves, fiscal years, budget plans/sections/groups/titles, projects, expenses, receipts, attachments, bookings, payment orders, approvals and stages, inventory, cash audit, discharge, comments, reconciliation |
| `002_org_unit_mirror.sql` | leaf-local org-unit mirror, the governance sub-org type catalogue, the consumer idempotency ledger |
| `003_money_running_no_fiscal_year_idx.sql` | running-number unique index scoped per ledger and fiscal year |
| `004_money_fk_indexes.sql` | indexes on foreign-key columns used by the money routes |
| `005_unwrap_double_encoded_jsonb.sql` | repairs JSONB values stored double-encoded by an earlier backfill |
| `006_approval_single_open.sql` | one open approval per approvable and one live payment order per expense; refuses to apply over existing duplicates (see `RUNBOOK.md`) |

Disabling the module for a tenant exports the database with `pg_dump` (retention profile
`rp-fin-module-data`), withholding `finance.fints_config.password_encrypted` (`module.json`).

## Configuration

| Variable | Meaning |
|---|---|
| `INTERNAL_FINANCE_SECRET` | Shared secret in `x-internal-auth`. |
| `FINANCE_PG_URL` | PostgreSQL server of the module; required, no default. |
| `NATS_URL` | Enables the org-unit mirror consumer (stream `ORGUNIT`); unset leaves it off. |
| `ORGUNIT_CONSUMER_PATTERN` | Subject pattern for that consumer. |
| `FINANCE_FINTS_PASSWORD_KEY` (alias `FINTS_PASSWORD_KEY`) | 64 hex characters (32 bytes), AES-256-GCM key for the stored FinTS password. |
| `FINTS_PRODUCT_ID` | FinTS product registration id. |
| `STORAGE_BACKEND` | Receipt storage: `local` (default) or `nextcloud`. |
| `RECEIPT_STORAGE_DIR` | Root directory for the `local` backend. |
| `STORAGE_NEXTCLOUD_USER` | System user for the `nextcloud` backend (default `NEXTCLOUD_ADMIN_USER`, else `admin`). |
| `NEXTCLOUD_URL`, `NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` | WebDAV target for the `nextcloud` backend. |
| `SHUTDOWN_TIMEOUT_MS`, `PORT` | Shutdown limit, listen port. |

The kernel app reaches the leaf through `FINANCE_SERVICE_URL`
(`infra/host/templates/env/app.env.tmpl`); the code that reads it is not in this tree.

The module's PostgreSQL server is `finance-postgres` under the compose profile `finance`
(`FINANCE_PG_USER`, `FINANCE_PG_PASSWORD`).

## External services

- The module's PostgreSQL server.
- NATS, for the org-unit mirror (optional at boot).
- A bank over FinTS, only when a bank account is configured for it.
- Nextcloud, only with `STORAGE_BACKEND=nextcloud`.

## Enabling and disabling

- Build: **excluded** by `modules/disabled.json`; the tenant-lifecycle runbook requires a
  module not to be in that file before it can be enabled for a customer.
- Leaf: `docker build -f modules/finance/Dockerfile .` from the repository root.
- The per-customer and instance switches need the kernel-side manifest, which this tree does
  not carry.

## Tests

- `pnpm --filter finance-service test` (unit, `test/`), `typecheck`, `typecheck:tests`.
- `pnpm --filter finance-service test:integration`: needs a throwaway PostgreSQL via
  `FINANCE_TEST_PG_URL`.

## Not established from the code

- The `package.json` description says the route surface is locked until a cutover; the
  source comments say every operation is live. This README follows the source.
- The list of routes above was taken from the route table; request and response shapes were
  not documented here.
