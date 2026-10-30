# messaging

Chat rooms and video calls. The kernel app serves the pages and API; the leaf is a thin,
stateless proxy to the Matrix homeserver (Synapse) and LiveKit that acts with each user's own
Matrix token. The directory also carries the Synapse image and its configuration, so the
homeserver ships with the kernel tree. Status: **supported**
([docs/modules.md](../../docs/modules.md)).

| | |
|---|---|
| Directory / `module.json` id | `messaging` |
| Manifest id (`config.modules` key) | `messages` |
| Package | `messages-service` |
| Navigation | segment `/messages` (minimum role: member); an extra entry `/messages/manage` ("Raeume", council administrators) |
| Leaf service | yes, stateless (no database, no NATS, no scheduler), listens on `PORT` (default 8080) |
| Platform server | Synapse, with PostgreSQL service `messaging-postgres` and database `synapse` (`module.json`) |

## Layout

| Path | Contents |
|---|---|
| `app/` | The in-process half, overlaid onto `gremion-ui/src/`: pages, API routes, Element Call and LiveKit endpoints, push endpoint, Matrix token routes, backend port, manifest. |
| `src/` | The leaf: `http/` (server, guard, dependencies), `matrix/` (client), `operations.ts`. |
| `synapse/` | The Synapse image: `Dockerfile`, `homeserver.yaml` template, `render-homeserver.sh`, `entrypoint.sh`, `bootstrap.sh`, `db-preflight.py`, `inject-jwt-key.py`, `healthcheck.sh`, `log.config`, `postgres-init/10-synapse-db.sh`, and its own `test/`. |
| `test/` | Leaf unit and integration tests. |

## Routes and API surface

Kernel app (`app/routes/`):

| Route | Methods |
|---|---|
| `/messages`, `/messages/manage` | pages |
| `/api/messages/sync` | GET |
| `/api/messages/rooms` | GET, POST |
| `/api/messages/rooms/[roomId]` | PATCH, DELETE |
| `/api/messages/rooms/[roomId]/{archive,read}` | POST |
| `/api/messages/rooms/[roomId]/messages` | GET, POST |
| `/api/messages/rooms/[roomId]/media` | GET, POST |
| `/api/messages/rooms/[roomId]/typing` | PUT |
| `/api/messages/rooms/[roomId]/unit` | GET |
| `/api/auth/matrix-token` | GET |
| `/api/auth/matrix-device` | DELETE |
| `/api/video/token`, `/api/video/meeting-room`, `/api/video/matrix-widget-action` | POST |
| `/api/video/openid-token` | GET |
| `/element-call/[...path]` | GET |
| `/livekit/jwt/get_token`, `/livekit/jwt/sfu/get` | POST |
| `/api/internal/push` | POST (push notification callback) |

Leaf (`src/operations.ts`), shared-secret guard except `/healthz`, all `POST`:
`/api/v1/messages/{sync,rooms,list,send,read,typing}`, `/api/v1/messages/media/{download,upload}`,
`/api/v1/video/{token,meeting-room,openid-token,widget-action}` and
`/api/v1/auth/{matrix-token,matrix-device}`.

## Migrations

None for the module's own data (`database: null`). The Synapse database is created by the
initdb script `synapse/postgres-init/10-synapse-db.sh` on the first start of
`messaging-postgres`: a `synapse` role without superuser and a `synapse` database with `C`
collation. It aborts the first initialisation when `SYNAPSE_DB_PASSWORD` is empty. At every
Synapse start `db-preflight.py` checks the collation and the PostgreSQL major version.

## Configuration

Kernel app and leaf:

| Variable | Meaning |
|---|---|
| `MESSAGES_BACKEND` | `inprocess` (default) or `service`; any other value is refused. |
| `MESSAGES_SERVICE_URL`, `INTERNAL_MESSAGES_SECRET` | Leaf base URL and shared secret (`x-internal-auth`). |
| `MATRIX_URL` | Internal homeserver URL; the leaf warns and falls back to `http://matrix:8008` when unset. |
| `MATRIX_PUBLIC_URL` | Browser-facing homeserver URL. |
| `SYNAPSE_SERVER_NAME`, `SYNAPSE_ADMIN_TOKEN`, `SYNAPSE_ADMIN_BOT_USER_ID` | Homeserver name, admin access token, id of the room-administration bot. |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Credentials for LiveKit join tokens. Required secret: the leaf refuses to boot when `LIVEKIT_API_SECRET` or `SYNAPSE_ADMIN_TOKEN` is unset or blank. |
| `ELEMENT_CALL_INTERNAL_URL`, `PUBLIC_ELEMENT_CALL_URL` | Element Call, internal and browser-facing. |
| `INTERNAL_PUSH_SECRET`, `GOOGLE_SERVICE_ACCOUNT_JSON` | Push endpoint secret; Firebase Cloud Messaging service account. |
| `AUTH_SECRET`, `PUBLIC_BASE_URL`, `PORT` | Session secret, public base URL, leaf listen port. |

Synapse container (`docker-compose.yml`, service `matrix`): `SYNAPSE_SERVER_NAME` and
`MATRIX_PUBLIC_URL` (both derived from `PLATFORM_DOMAIN`), `SYNAPSE_DB_*`,
`SYNAPSE_KEYCLOAK_ISSUER_URL`, `SYNAPSE_KEYCLOAK_FETCH_URL`, `SYNAPSE_OIDC_CLIENT_SECRET`,
`SYNAPSE_REGISTRATION_SHARED_SECRET` (only rendered in a bootstrap boot),
`SYNAPSE_ADMIN_BOT_USER_ID`, `SYNAPSE_BOOTSTRAP_MODE`, `SYNAPSE_KC_MAX`. The render step
refuses a blank issuer and anything but PostgreSQL.

The module's PostgreSQL server is `messaging-postgres` and the homeserver is `matrix`, both
under the compose profile `messaging` (`MESSAGING_PG_USER`, `MESSAGING_PG_PASSWORD`,
`SYNAPSE_DB_PASSWORD`).

## External services

- Matrix/Synapse: built from this directory and started by the `messaging` profile.
- LiveKit and Element Call, for video: not defined in the compose files at the repository
  root; the operator supplies them.
- Keycloak, as the OpenID provider for Synapse.
- Firebase Cloud Messaging, only for push notifications.

## Enabling and disabling

- Build: included in the default build.
- Per customer: `--enable messaging` at creation (the catalogue id is the `module.json` id;
  the instance key below is the manifest id), or the panel's `enable_module` and
  `disable_module` requests ([runbooks/tenant-lifecycle.md](../../docs/runbooks/tenant-lifecycle.md)).
  The chat poll of the votes module needs the `messaging` profile
  ([pilot/module-defaults.md](../../docs/pilot/module-defaults.md)).
- Instance setting: `config.modules.messages = false` answers `/messages` with the
  module-disabled page, `/api/messages` and `/api/video` with a bare 403, and drops both
  navigation entries.
- Leaf: `docker build -f modules/messaging/Dockerfile .` from the repository root. Synapse:
  `docker build modules/messaging/synapse` (the compose service builds it).

## Tests

- `pnpm --filter messages-service test` (unit, `test/`), `test:integration`, `typecheck`.
- Synapse image tests: `node --test modules/messaging/synapse/test/`; `scripts/check-synapse-stack.mjs`
  checks the stack wiring. `synapse/test/scratch-proof.sh` is a shell proof that needs a
  container runtime (not run for this README).
- Tests under `app/` sit next to the code and are not collected by the package's `test`
  script.

## Not established from the code

- Whether the Synapse tests under `synapse/test/` are run by CI was not checked.
- The exact set of Keycloak objects Synapse requires is created outside this directory.
