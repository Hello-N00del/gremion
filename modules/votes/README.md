# votes

Open polls and the combined `/votes` list ("Abstimmungen & Wahlen"): the list merges the
tenant's open polls with the ballots of tracked Helios elections. Polls are Nextcloud Polls
quick-polls created and answered through the kernel app. The leaf is a stateless
aggregation proxy. Status: **supported** ([docs/modules.md](../../docs/modules.md)); it is the
one module the pilot create request enables
([pilot/module-defaults.md](../../docs/pilot/module-defaults.md)).

| | |
|---|---|
| Directory / `module.json` id | `votes` |
| Manifest id (`config.modules` key) | `votes` |
| Package | `votes-service` |
| Navigation | segments `/polls` and `/votes` (minimum role: member), one merged rail entry at `/votes` |
| Leaf service | yes, stateless (no database), listens on `PORT` (default 8080) |

## Layout

| Path | Contents |
|---|---|
| `app/` | The in-process half, overlaid onto `gremion-ui/src/`: the `/votes` and `/polls` pages, `/api/polls`, the polls client, manifest. |
| `src/` | The leaf: `http/` (server, guard), `helios/` (read client), `polls/` (Nextcloud Polls client and the per-tenant poll marker), `aggregator/` (mapping and merge), `boot-config.ts`. |
| `test/` | Leaf unit tests; the integration config exists but no integration test does. |

## Routes and API surface

Kernel app (`app/routes/`):

| Route | Methods |
|---|---|
| `/votes`, `/polls`, `/polls/new`, `/polls/[id]` | pages |
| `/api/polls` | GET, POST |
| `/api/polls/[id]` | GET, POST (vote) |
| `/api/polls/[id]/options` | GET |

The `/votes` page hides every Helios item while the elections module is off for the tenant.

Leaf (`src/http/server.ts`): `/healthz` (no guard); behind the shared-secret guard, only
`POST /api/v1/votes` (compose the list from a set of election UUIDs; ballots that cannot be
reached come back as degraded instead of being dropped) and `POST /api/v1/polls` (create a
poll). Malformed bodies answer 400, upstream failures 502. The leaf has no by-id poll route;
reading and voting on a poll are in the app's polls client.

Each poll carries a server-written marker for the calling tenant (`x-tenant-id`) and the
list is filtered by it. Polls without a marker belong to no tenant unless
`VOTES_LEGACY_POLL_TENANT_ID` claims them for one.

## Migrations

None. The leaf keeps no database (`module.json`: `database: null`).

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `INTERNAL_VOTES_SECRET` | both | Shared secret in `x-internal-auth`. Unset: the leaf boots and every guarded route answers 403. |
| `HELIOS_URL`, `PUBLIC_HELIOS_URL` | leaf, app | Internal and browser-facing Helios URL; the leaf logs a warning and falls back to `http://helios:8000` when `HELIOS_URL` is unset. |
| `NEXTCLOUD_URL` | leaf, app | Nextcloud base URL; falls back to `http://nextcloud` with a warning. |
| `NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` | leaf, app | Admin credential for Nextcloud Polls. The leaf refuses to boot without it. |
| `VOTES_LEGACY_POLL_TENANT_ID` | leaf | Tenant that owns polls created before the marker existed. |
| `PUBLIC_BASE_URL` | app | Public base URL. |
| `PORT` | leaf | Listen port. |

The backend flag for this module (`VOTES_BACKEND`, `inprocess` or `service`, with
`VOTES_SERVICE_URL`) is read by code under `modules/elections/app/lib/server/elections/backend/`,
not by this module's app half; see [../elections/README.md](../elections/README.md).

## External services

- Nextcloud with the Polls app.
- Helios, only to show ballots (the Helios administration is in the elections module).

Neither is defined in the compose files at the repository root; the operator supplies them.

## Enabling and disabling

- Build: included in the default build.
- Per customer: named explicitly at creation (`--enable votes`); the pilot request does.
  The panel's `enable_module` and `disable_module` requests work as for the other modules
  ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md)).
- Instance setting: `config.modules.votes = false` makes `/votes`, `/polls` and `/api/polls`
  answer with the module-disabled surface.
- Leaf: `docker build -f modules/votes/Dockerfile .` from the repository root.

## Tests

- `pnpm --filter votes-service test` (unit, `test/`), `typecheck`.
- `pnpm --filter votes-service test:integration` collects nothing today.
- Tests under `app/` (poll API, degraded rendering, reflow) sit next to the code and are not
  collected by the package's `test` script.

## Not established from the code

- Whether the app half's polls client and the leaf are both used in a given deployment, or
  only one of them, depends on how the instance is wired and was not traced.
