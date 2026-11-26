**English** | [Deutsch](./README.de.md)

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
| Leaf service | yes, listens on `PORT` (default 8080); it serves every customer whose board is in its own database |

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
| `/api/board/[id]/cards` | POST, PATCH, DELETE |
| `/api/board/[id]/promotable` | GET |
| `/api/board/[id]/promote` | POST |

Leaf (`src/http/routes.ts`), all under the shared-secret guard except `/healthz`:

`GET|POST /api/v1/boards`, `GET /api/v1/boards/:id`, `POST /api/v1/boards/:id/stacks`,
`GET /api/v1/boards/:id/deck`, `POST /api/v1/boards/:id/promote`, `POST /api/v1/cards`,
`PATCH|DELETE /api/v1/cards/:id`, `PATCH /api/v1/cards/:id/move`, `POST /api/v1/cards/promoted`.

## Where a customer's board lives

A customer's board is in one of two places, and one row says which: `location` in the table
`board_location` (kernel migration `gremion-ui/migrations/0066_board_location.sql`, one row at most
per customer database; no row means `kernel`).

| `location` | Where the board is | Which customers |
|---|---|---|
| `module` | The customer's own database `t_<hex32>__board` on `board-postgres`, served by the leaf `board-service` | A customer created with board ticked: the create flow enables the module (which creates the database and applies `migrations/`) and then sets the flag |
| `kernel` or no row | The tables `board`, `stack` and `card` of the customer's own kernel database, created by `gremion-ui/migrations/0034_deck_board.sql`, served in the kernel app | A customer created without board ticked, and every customer created before board had its own database |
| `moving` | Reserved for a later step that moves a board; nothing in this release writes it | none |

Board is chosen when the customer is created. Leaving it unticked does not give the customer a
board database later: switching board on afterwards for an active customer whose flag is not
`module` is refused before anything is written, because the enable would create an empty database
beside the kernel rows.

Moving an existing customer's board from the kernel tables into its own database is not available
yet. Until it is, a customer that already holds its board in the kernel keeps it there. The
operator's read-only check that lists where every customer's board is, and the order for creating
the real customer, are in the runbook section
[Board: where a customer's board lives](../../docs/runbooks/tenant-lifecycle.md).

## Migrations

`module.json` declares the module's own database (`board-postgres`, the directory `migrations/`) and
its export (`pg_dump`, retention profile `rp-brd-module-data`, read from `module.json` by
`packages/provisioning/src/catalogue-rows.ts`). One database per customer. Enabling the module
creates `t_<hex32>__board`, applies `migrations/` through `runMigrations` from
`@gremion/tenant-store`, and the leaf only opens it: the leaf never creates or migrates a database
itself and connects as the module's app role. `migrations/001_init.sql` creates `board`, `stack` and
`card`. The foreign keys to the kernel tables (organisational units, protocol action items) are
omitted because they would cross databases. A schema gate checks the applied files against
`migrations/manifest.json` before a customer's database is used. The leaf answers
`404 tenant_not_provisioned` for a customer that has no such database; with `BOARD_BACKEND=auto` a
customer whose board is in the kernel never reaches the leaf.

The kernel tables `board`, `stack` and `card` (migration `0034_deck_board.sql`) exist in every
customer's kernel database whether the module is on or off; for a customer located `module` they
stay empty.

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `BOARD_BACKEND` | kernel app | `auto` (default): per customer, the location flag (`board_location`, migration 0066) decides between the kernel tables and the leaf; a customer with no flag row is served from the kernel tables. `inprocess` or `service` force one backend and ignore the flag. Any other value is refused. |
| `BOARD_SERVICE_URL` | kernel app | Base URL of the leaf; the app env template points it at the leaf of the same colour. |
| `INTERNAL_BOARD_SECRET` | both | Shared secret in the `x-internal-auth` header. Unset: the leaf boots and every guarded route answers 403. |
| `GREMION_BOARD_PG_URL` | leaf | PostgreSQL server of the module, as the module's app role `m_board_app`; the database name is replaced per tenant (`t_<hex32>__board`). Required, there is no default; the leaf refuses to start without it. |
| `BOARD_APP_PASSWORD` | leaf | The password of `m_board_app`; `gremion-init-secrets` takes it from the file the module lifecycle sets the role from, so the URL and the role cannot disagree. |
| `PORT` | leaf | Listen port, default 8080. |
| `TRACE_EXPORTER` | kernel app | Tracing exporter selection. |

The module's PostgreSQL server is the `board-postgres` service and the leaf is `board-service`, both
under the compose profile `board`, which a pilot host renders from `infra/host/module-profiles.json`.
The server's credentials come from `BOARD_PG_USER` and `BOARD_PG_PASSWORD`.

## External services

None besides the kernel, the leaf and the leaf's PostgreSQL server (`board-postgres`).

## Enabling and disabling

- Build: included in the default build.
- Per customer: tick board when the customer is created (`--enable board`, or the panel's create
  form). Board passes the same isolation gate as the other modules. A council cannot switch board in
  its own settings: it is held back there. The panel's `enable_module` request enables board only
  for a customer whose board already lives in its own database (for example to restore it inside the
  Karenz); for any other active customer it is refused.
- Switching board off (`disable_module`) for a customer whose board is in its own database exports
  the database, verifies the export and blocks the database; a switch-on inside the 30 days unblocks
  it with the same boards. On day 30 the blocked database is dropped and the export is kept for a
  fixed period after that, not deleted with it
  ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md), the Karenz table and the
  retention catalogue rows RC-MOD-EXPORT and RC-BRD).
- A board that is still in the kernel tables has no database to export. Do not switch it off through
  the platform: a platform `disable_module` for such a customer, where it had a board enablement, only
  hides the board and opens the 30-day clock (nothing is exported and nothing is deleted), a switch-on
  is refused by the same gate as a later enable (see above), and while the platform row is disabled the
  reconciler below puts a hand-set `config.modules.board` back to false. The hide is one-way in this
  release; hide such a board with `config.modules.board = false` alone.
- Instance setting: `config.modules.board = false` makes `/tasks` and `/api/board` answer with the
  module-disabled surface. This is the way to hide a board that is in the kernel tables.
- What hides the board after a platform `disable_module` is the app's module-switch
  reconciler, which sets `config.modules.board = false` within about a minute. It runs only
  when `PLATFORM_MODULES_DATABASE_URL` is set; the deploy wiring leaves it empty when
  `UI_MODULES_DB_PASSWORD` is unset, and the app then logs `module self-service reconciler
  off`. On such a host the `disable-module` verb refuses `board` (before anything is written,
  the message names `UI_MODULES_DB_PASSWORD`), so a platform disable is never reported as done
  while the board stays reachable; set the variable, run `init` and recreate the app
  containers first, or set `config.modules.board` to false by hand. After an app restart the platform's hold is
  forgotten until the first alignment pass, so for that short window a settings write can
  still turn the board on; the pass puts it back.
- Leaving board unticked at creation does not hide it, and it cannot be ticked later. The board
  follows the platform only where a platform enablement exists. A customer created without it is
  unmanaged and, like every toggleable module except elections, on by default, served from the
  kernel tables; hiding it needs `config.modules.board = false`.
- Leaf: `docker build -f modules/board/Dockerfile .` from the repository root.

`docs/pilot/module-defaults.md` states that board is part of the pilot create request and passes
the enable gate; only vault is still refused by name.

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
