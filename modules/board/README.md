# board

Task board for organisational units: boards hold stacks, stacks hold cards, and a card's
status is the stack it sits in. Protocol action items can be listed as promotable and
promoted to cards. Status: **supported** ([docs/modules.md](../../docs/modules.md)).

| | |
|---|---|
| Directory / `module.json` id | `board` |
| Manifest id (`config.modules` key) | `board` |
| Package | `board-service` |
| Navigation segment | `/tasks` (minimum role: member) |
| Leaf service | yes, listens on `PORT` (default 8080) |

## Layout

| Path | Contents |
|---|---|
| `app/` | The in-process half, overlaid onto `gremion-ui/src/`: pages, API routes, the backend port (`inprocess` or `service`), the manifest (`app/lib/modules/manifests/board.ts`), card components, the seeder. |
| `src/` | The leaf service: `app.ts` (the one construction path), `http/` (router, guard, routes), `store/`. |
| `migrations/` | Leaf schema and the generated `manifest.json`. |
| `scripts/build-migration-manifest.mjs` | Writes `migrations/manifest.json` (SHA-256 per migration); runs as `prebuild`. |
| `test/` | Leaf unit and integration tests, including a bundle smoke test. |

## Routes and API surface

Kernel app (`app/routes/`):

| Route | Methods |
|---|---|
| `/tasks` | page |
| `/api/board` | GET |
| `/api/board/[id]` | GET |
| `/api/board/[id]/cards` | POST, PATCH |
| `/api/board/[id]/promotable` | GET |
| `/api/board/[id]/promote` | POST |

Leaf (`src/http/routes.ts`), all under the shared-secret guard except `/healthz`:

`GET|POST /api/v1/boards`, `GET /api/v1/boards/:id`, `POST /api/v1/boards/:id/stacks`,
`GET /api/v1/boards/:id/deck`, `POST /api/v1/boards/:id/promote`, `POST /api/v1/cards`,
`PATCH /api/v1/cards/:id/move`, `POST /api/v1/cards/promoted`.

## Migrations

One database per tenant and board. `migrations/001_init.sql` creates `board`, `stack` and
`card`. The foreign keys to the kernel tables (organisational units, protocol action items)
are omitted because they would cross databases. The leaf never creates or migrates a
database itself; enabling the module for a tenant does that, and a schema gate checks the
applied files against `migrations/manifest.json` before a tenant database is used.
When the module is disabled for a tenant, its data is exported with `pg_dump` under the
retention profile `rp-brd-module-data` (`module.json`).

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `BOARD_BACKEND` | kernel app | `inprocess` (default) or `service`; any other value is refused. |
| `BOARD_SERVICE_URL` | kernel app | Base URL of the leaf when the backend is `service`. |
| `INTERNAL_BOARD_SECRET` | both | Shared secret in the `x-internal-auth` header. Unset: the leaf boots and every guarded route answers 403. |
| `GREMION_BOARD_PG_URL` | leaf | PostgreSQL server of the module; the database name is replaced per tenant (`t_<hex32>__board`). Required, there is no default; the leaf refuses to start without it. |
| `PORT` | leaf | Listen port, default 8080. |
| `TRACE_EXPORTER` | kernel app | Tracing exporter selection. |

The module's PostgreSQL server is the `board-postgres` service under the compose profile
`board`; its credentials come from `BOARD_PG_USER` and `BOARD_PG_PASSWORD`.

## External services

None besides the kernel and the module's PostgreSQL server.

## Enabling and disabling

- Build: included in the default build.
- Per customer: enable with `--enable board` at creation or through the panel's
  `enable_module` request; `disable_module` exports and verifies the module database before
  it is dropped ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md)).
- Instance setting: `config.modules.board = false` makes `/tasks` and `/api/board` answer
  with the module-disabled surface.
- Leaf: `docker build -f modules/board/Dockerfile .` from the repository root.

`docs/pilot/module-defaults.md` states that board is not part of the pilot module set and
what the repository does and does not show about it being off on a running system.

## Tests

- `pnpm --filter board-service test`: leaf unit tests (`test/`), no database.
- `pnpm --filter board-service test:integration`: needs a throwaway PostgreSQL;
  `BOARD_TEST_PG_URL` and `BOARD_TEST_PG_CONTAINER` are both required (see
  `vitest.integration.config.ts`).
- `pnpm --filter board-service test:bundle`: builds and smoke-tests the bundle.
- `pnpm --filter board-service typecheck`.
- Tests under `app/` sit next to the code they cover and are not part of the package's own
  `test` script (its `include` is `test/**`). That they run with the `gremion-ui` suite
  after the overlay is inferred from the overlay script, not checked here.

## Not established from the code

- `app/lib/modules/manifests/board.ts` still describes a `board_<slug>` database catalogue
  in a comment; `src/app.ts` resolves per-tenant databases through `@gremion/tenant-store`.
  This README follows `src/app.ts`.
