**English** | [Deutsch](./README.de.md)

# publishing

Newsletter: mailing lists and members, newsletter drafts with recipients (lists or kernel
groups), preview, scheduled and immediate send, per-recipient delivery records, unsubscribe
links, and an audit log. Drafts can be edited in Collabora. Status: **supported**
([docs/modules.md](../../docs/modules.md)).

The module is registered as `newsletter`, not `publishing`.

| | |
|---|---|
| Directory / `module.json` id | `publishing` |
| Manifest id (`config.modules` key) | `newsletter` |
| Package | `newsletter-service` |
| Navigation segment | `/newsletter` (minimum role: finance) |
| Leaf service | yes, listens on `PORT` (default 8080); it is the only backend |

## Layout

| Path | Contents |
|---|---|
| `app/` | The in-process half, overlaid onto `gremion-ui/src/`: pages under `/newsletter`, API routes, the service client behind the backend port, Collabora conversion helper, manifest (`app/lib/modules/manifests/newsletter.ts`). |
| `src/` | The leaf: `http/`, `store/`, `tenant-store.ts`, `dispatch.ts` (send pipeline), `outbox.ts` and the NATS relay, `scheduler.ts`, `kernel-client.ts`. |
| `migrations/` | Leaf schema and the generated `manifest.json`. |
| `scripts/` | `build-migration-manifest.mjs` (runs as `prebuild`); `backfill.ts` (one-shot copy from an earlier SQLite store); `seed-sample-sqlite.mjs` (builds a synthetic SQLite fixture for it). |
| `test/` | Leaf unit and integration tests. |

## Routes and API surface

Kernel app (`app/routes/`):

| Route | Methods |
|---|---|
| `/newsletter`, `/newsletter/new`, `/newsletter/[id]`, `/newsletter/[id]/preview`, `/newsletter/lists`, `/newsletter/lists/[id]`, `/newsletter/unsubscribe` | pages |
| `/api/newsletter` | GET, POST |
| `/api/newsletter/[id]` | GET, PATCH |
| `/api/newsletter/[id]/preview` | GET |
| `/api/newsletter/[id]/schedule`, `/api/newsletter/[id]/send-now` | POST |
| `/api/newsletter/[id]/wopi-token` | GET |
| `/api/newsletter/lists`, `.../lists/[id]`, `.../lists/[id]/members`, `.../members/[memberId]` | GET, POST; DELETE; GET, POST; DELETE |
| `/api/newsletter/unsubscribe` | POST |
| `/api/internal/newsletter/{render,resolve-group,send-mail}` | POST (leaf-to-kernel callbacks; outside the module's route prefixes, so they keep working when the module is off) |

Leaf (`src/http/routes.ts`), shared-secret guard except `/healthz`: `/api/v1/lists` (and
`/:id`, `/:id/members`, `/:id/members/:memberId`), `/api/v1/newsletters` (`GET`, `POST`,
`/:id` GET and PATCH, `/:id/recipients` GET and PUT, `/:id/schedule`, `/:id/send`,
`/:id/audit`), `POST /api/v1/unsubscribe`, `GET /api/v1/stats`, `GET /healthz/tenants`.

## Migrations

One database per tenant (`newsletter_<slug>`, with a control database `newsletter_control`
holding the tenant catalogue), created by the leaf's tenant store.
`migrations/001_init.sql` creates `mailing_lists`, `mailing_list_members`, `newsletters`,
`newsletter_recipients`, `unsubscribes`, `send_tokens`, `newsletter_audit`, `deliveries` and
`outbox`. The leaf checks each file against `migrations/manifest.json`.

Disabling the module for a tenant exports the database with `pg_dump` (retention profile
`rp-nws-module-data`), withholding `public.unsubscribes.token` and `public.send_tokens.token`
(`module.json`).

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `NEWSLETTER_BACKEND` | kernel app | `service` (default) is the only valid value; anything else is a resolve error. |
| `NEWSLETTER_SERVICE_URL` | kernel app | Base URL of the leaf. |
| `INTERNAL_NEWSLETTER_SECRET` | both | Shared secret in `x-internal-auth`. |
| `NEWSLETTER_PG_URL` | leaf | PostgreSQL server of the module; required, no default. |
| `NATS_URL` | leaf | Enables the outbox relay. |
| `KERNEL_BASE_URL` | leaf | Kernel base URL for the render, resolve-group and send-mail callbacks. |
| `PUBLIC_BASE_URL`, `ORIGIN` | leaf, app | Public base URL used to build links. |
| `NEWSLETTER_ALLOW_LOOPBACK_LINKS` | leaf | Permits loopback link bases (development). |
| `NEWSLETTER_SCHEDULER_ENABLED`, `SCHEDULER_ENABLED` | leaf | Switch the send scheduler; the per-module variable wins when non-empty. |
| `COLLABORA_INTERNAL_URL` | app | Internal Collabora URL for draft conversion. |
| `SHUTDOWN_TIMEOUT_MS`, `PORT`, `TRACE_EXPORTER` | leaf, app | Shutdown limit, listen port, tracing. |

The module's PostgreSQL server is `newsletter-postgres` under the compose profile
`newsletter` (`NEWSLETTER_PG_USER`, `NEWSLETTER_PG_PASSWORD`).

## External services

- The module's PostgreSQL server.
- NATS, for the outbox relay.
- SMTP, reached through the kernel's send-mail callback; the module does not hold mail
  credentials. Kernel system mail (password reset, notifications) does not go through this
  module.
- Collabora, for draft editing and conversion.

## Enabling and disabling

- Build: included in the default build.
- Per customer: `--enable publishing` at creation (the catalogue id is the `module.json`
  id), or the panel's `enable_module` and `disable_module` requests
  ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md)).
- Instance setting: `config.modules.newsletter = false` gates the newsletter pages and
  `/api/newsletter`, drops the navigation entry, and makes the demo seed skip it.
- Leaf: `docker build -f modules/publishing/Dockerfile .` from the repository root.

## Tests

- `pnpm --filter newsletter-service test` (unit, `test/`), `typecheck`, `typecheck:tests`.
- `pnpm --filter newsletter-service test:integration`: needs a throwaway PostgreSQL via
  `NEWSLETTER_TEST_PG_URL`.
- Tests under `app/` sit next to the code and are not collected by the package's `test`
  script.

## Not established from the code

- Which of `PUBLIC_BASE_URL` and `ORIGIN` each half reads was taken from a search for
  environment reads, not from a full trace.
