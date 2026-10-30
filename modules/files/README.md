# files

Document browser over Nextcloud: list, download, upload (including chunked upload), create
folders, move, copy and delete, plus a per-group file area and in-browser editing of
supported document types through Collabora. The leaf is a thin, stateless WebDAV proxy.
Status: **supported** ([docs/modules.md](../../docs/modules.md)).

| | |
|---|---|
| Directory / `module.json` id | `files` |
| Manifest id (`config.modules` key) | `files` |
| Package | `files-service` |
| Navigation segment | `/files` (minimum role: member; guests have no Nextcloud account) |
| Leaf service | yes, stateless, listens on `PORT` (default 8080) |

## Layout

| Path | Contents |
|---|---|
| `app/` | The in-process half, overlaid onto `gremion-ui/src/`: pages, API routes, file browser components, the Nextcloud client and WebDAV path handling, protocol-document helpers, backend port, manifest. |
| `src/` | The leaf: `http/` (server and the shared-secret guard), `nextcloud/` (WebDAV client and path sanitising). |
| `test/` | Leaf unit and integration tests. |

## Routes and API surface

Kernel app (`app/routes/`):

| Route | Methods |
|---|---|
| `/files`, `/files/[...path]`, `/files/groups/[group]`, `/files/edit/[...path]` | pages |
| `/api/files/[...path]` | GET, PUT, DELETE, PATCH |
| `/api/files/upload-chunk` | POST |
| `/api/files/edit-token/[...path]` | GET: returns a short-lived WOPI token and the Collabora editor URL (via the Nextcloud `richdocuments` API); the browser then talks to Collabora directly |

Leaf (`src/http/server.ts`): `/healthz` (no guard) and the operations `/api/v1/propfind`,
`download`, `upload`, `mkcol`, `delete`, `move`, `copy` (each runs as the logged-in user,
using the user's bearer in `x-webdav-bearer`) and `/api/v1/upload-chunk`. The shared secret
is in `x-internal-auth`, the tenant in `x-tenant-id` and `x-tenant-slug`.

## Migrations

None. The module keeps no database (`module.json`: `database: null`).

## Configuration

| Variable | Used by | Meaning |
|---|---|---|
| `FILES_BACKEND` | kernel app | `inprocess` (default) or `service`; any other value is refused. |
| `FILES_SERVICE_URL` | kernel app | Base URL of the leaf when the backend is `service`. |
| `INTERNAL_FILES_SECRET` | both | Shared secret in `x-internal-auth`. Unset: the leaf boots and every guarded route answers 403. |
| `NEXTCLOUD_URL` | both | Nextcloud base URL; the leaf logs a warning and falls back to `http://nextcloud` when unset. |
| `NEXTCLOUD_ADMIN_USER`, `NEXTCLOUD_ADMIN_PASSWORD` | both | Admin credentials for the Nextcloud client. |
| `PORT`, `TRACE_EXPORTER` | leaf, app | Listen port; tracing exporter. |

## External services

- Nextcloud (WebDAV and the `richdocuments` OCS API).
- Collabora, for editing.

Neither is defined in the compose files at the repository root; the operator supplies them.

## Enabling and disabling

- Build: included in the default build.
- Per customer: `--enable files` at creation, or the panel's `enable_module` and
  `disable_module` requests ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md)).
- Instance setting: `config.modules.files = false` answers `/files` with the module-disabled
  page and `/api/files` with a bare 403, and drops the documents navigation entry. Users
  keep their accounts.
- Leaf: `docker build -f modules/files/Dockerfile .` from the repository root.

## Tests

- `pnpm --filter files-service test` (unit, `test/`), `test:integration` (the config exists;
  what it needs was not checked), `typecheck`.
- Tests under `app/` sit next to the code and are not collected by the package's `test`
  script.

## Not established from the code

- Which Nextcloud app or app password the admin credentials must map to was not traced.
