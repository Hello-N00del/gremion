**English** | [Deutsch](./README.de.md)

# calendar

Events and event types with recurrence, per-committee calendar settings, a public flag for
portal display, and automations that create events (holiday sync, Helios ballots, protocol
minutes). Events are pushed to CalDAV, and change events are relayed over NATS through a
transactional outbox. Status: **supported** ([docs/modules.md](../../docs/modules.md)).

| | |
|---|---|
| Directory / `module.json` id | `calendar` |
| Manifest id (`config.modules` key) | `calendar` |
| Package | `calendar-service` |
| Navigation segment | `/calendar` (minimum role: guest) |
| Leaf service | yes, listens on `PORT` (default 8080) |

## Layout

| Path | Contents |
|---|---|
| `app/` | The in-process half, overlaid onto `gremion-ui/src/`: pages, API routes, calendar components, CalDAV client and sync, notification scheduler, audit consumer, backend port, manifest, seeder. |
| `src/` | The leaf service: `http/`, `store/`, `tenant-store.ts`, `caldav/`, `outbox.ts` and the NATS relay, `scheduler.ts`. |
| `migrations/` | Leaf schema and the generated `manifest.json`. |
| `scripts/` | `build-migration-manifest.mjs` (runs as `prebuild`) and `backfill.ts`, a one-shot copy of calendar rows from a kernel tenant database into the leaf database (verify-only mode available). |
| `test/` | Leaf unit and integration tests. |

## Routes and API surface

Kernel app (`app/routes/`):

| Route | Methods |
|---|---|
| `/calendar`, `/calendar/invite/[uid]` | pages |
| `/api/calendar/events` | GET, POST |
| `/api/calendar/events/[id]` | GET, PATCH, DELETE |
| `/api/calendar/event-types`, `/api/calendar/event-types/[id]` | GET, POST; DELETE |
| `/api/calendar/settings/shared` | GET, PATCH |
| `/api/calendar/settings/committees/[id]` | GET, PATCH |
| `/api/calendar/automations/holidays/sync` | POST |
| `/api/calendar/automations/helios` | POST |
| `/api/calendar/automations/minutes`, `.../minutes/confirm` | POST |

Leaf (`src/http/routes.ts`), shared-secret guard except `/healthz`:

`/api/v1/events` (GET, POST), `/api/v1/events/:id` (GET, PATCH, DELETE),
`/api/v1/events/by-external/:source/:externalId` (GET, DELETE), `/api/v1/event-types` (GET,
POST), `/api/v1/event-types/:id` (GET, DELETE), `/api/v1/committee-settings/:committeeId`
(GET, PUT), `GET /api/v1/caldav/failed`, and `GET /healthz/tenants`.

## Migrations

One database per tenant (`calendar_<slug>`), with a control database `calendar_control`
holding the tenant catalogue. The leaf runs `migrations/*.sql` in order on first contact
with a tenant and verifies each file's SHA-256 against `migrations/manifest.json`.

| File | Content |
|---|---|
| `001_init.sql` | `event_types`, `calendar_events`, `event_recurrence`, `event_committees`, `committee_calendar_settings`, `caldav_sync_queue`, `calendar_audit`, `outbox` |
| `002_add_is_public.sql` | `is_public` flag on `calendar_events` |
| `003_holiday_unique.sql` | partial unique index on holiday events by `(source, external_id)` |

Disabling the module for a tenant exports the database with `pg_dump` under the retention
profile `rp-cal-module-data` (`module.json`).

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `CALENDAR_BACKEND` | kernel app | `inprocess` (default) or `service`. |
| `CALENDAR_SERVICE_URL` | kernel app | Base URL of the leaf when the backend is `service`. |
| `INTERNAL_CALENDAR_SECRET` | both | Shared secret in `x-internal-auth`. |
| `CALENDAR_PG_URL` | leaf | PostgreSQL server of the module; required, no default. |
| `NATS_URL` | both | Enables the outbox relay; unset leaves the relay off with one boot log line. |
| `KERNEL_BASE_URL` | leaf | Kernel base URL; read, but no kernel callback is made today. |
| `NEXTCLOUD_URL`, `NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` | both | CalDAV push target and credentials. |
| `CALDAV_SHARED_CALENDAR`, `CALDAV_SHARED_USER`, `CALDAV_TENANT_CALENDARS`, `CALDAV_CALENDAR_TEMPLATE` | both | Which CalDAV calendar receives which events. |
| `CALENDAR_SCHEDULER_ENABLED`, `SCHEDULER_ENABLED` | leaf | Switch the 30-second CalDAV drain. A non-empty `CALENDAR_SCHEDULER_ENABLED` wins over the shared `SCHEDULER_ENABLED`; only the exact string `false` disables; default on. |
| `SHUTDOWN_TIMEOUT_MS` | leaf | Graceful shutdown limit. |
| `PORT`, `TRACE_EXPORTER` | leaf, app | Listen port; tracing exporter. |

The module's PostgreSQL server is `calendar-postgres` under the compose profile `calendar`
(`CALENDAR_PG_USER`, `CALENDAR_PG_PASSWORD`).

## External services

- Nextcloud, for CalDAV.
- NATS, for the outbox relay (optional at boot).
- The module's PostgreSQL server.

## Enabling and disabling

- Build: included in the default build.
- Per customer: `--enable calendar` at creation, or the panel's `enable_module` and
  `disable_module` requests ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md)).
- Instance setting: `config.modules.calendar = false` answers `/calendar` and
  `/api/calendar` with the module-disabled surface.
- Leaf: `docker build -f modules/calendar/Dockerfile .` from the repository root.

## Tests

- `pnpm --filter calendar-service test` (unit, `test/`), `typecheck`, `typecheck:tests`.
- `pnpm --filter calendar-service test:integration`: needs a throwaway PostgreSQL via
  `CALENDAR_TEST_PG_URL` (see `vitest.integration.config.ts` and the guard in `test/`).
- Tests under `app/` sit next to the code and are not collected by the package's `test`
  script.

## Not established from the code

- Which of the variables listed as "both" the kernel app (as opposed to the leaf) reads for
  the in-process CalDAV client was taken from a search for environment reads, not from a
  full trace of both halves.
