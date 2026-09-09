# Gremion — Setup Runbook

This is the operational guide for bringing up the Gremion governance kernel
locally (or on a single host). For the vision, architecture, and governance
charter, see [`about-gremion.md`](../about-gremion.md) — this document is the
technical/operational layer only.

The kernel ships exactly two modules — `core` and `governance` — plus identity
& auth, multi-tenancy, the module SDK, and the shared `@gremion/db` /
`@gremion/ports` packages. Feature modules (elections, newsletter, calendar,
files, messages, board, users, finance, content, vault, handover)
are **not** part of the kernel; each lives in its own repository and attaches
over a stable API.

## Prerequisites

- Docker + Docker Compose v2
- `openssl` (used by `scripts/setup.sh` to generate secrets)
- `make` (GNU Make) — for the convenience targets
- Node 26 + pnpm 10.33.0 — only needed for local SvelteKit development outside
  Docker, or to regenerate the Keycloak realm export from module manifests

## Quick start

The fastest path is the first-run script, which generates all secrets, mints
the internal TLS certs, ensures the realm export exists, and starts the core
services:

```bash
./scripts/setup.sh
# or:
make setup
```

When it finishes it prints the app and Keycloak URLs and reminds you that all
credentials now live in `.env`.

## What `scripts/setup.sh` does

The script is idempotent and runs these steps:

1. **Checks prerequisites** — fails fast if Docker, Docker Compose v2, or
   `openssl` is missing.
2. **Prompts for a domain** — press Enter for `localhost` (local dev), or enter
   a real domain (e.g. `gov.example.com`) for a deployment. The value is
   written to `DOMAIN` in `.env`.
3. **Creates `.env` from `.env.example`** (only if `.env` does not already
   exist) and `chmod 600 .env` so the secrets it is about to write are not
   world-readable.
4. **Generates random secrets** for every `CHANGE_ME_*` placeholder — the
   Postgres superuser password, the Keycloak DB and admin passwords, the
   application DB password, the control-plane (tenant-registry) DB password,
   the PgBouncer auth password, the read-only public-portal DB password, the
   Auth.js session secret, the OIDC client secrets (`gremion-ui` and
   `gremion-admin`), the seed-endpoint token, the internal-fetch shared secret,
   and the restic backup passphrase. It then aborts if any `CHANGE_ME_`
   placeholder remains.
5. **Makes the helper scripts executable** (`scripts/*.sh`,
   `docker/postgres/init-databases.sh`).
6. **Mints internal TLS certificates** via
   `docker/keycloak/certs/gen-internal-ca.sh` (an internal CA + a Keycloak
   server cert with SAN `keycloak,localhost,127.0.0.1`). The dev stack runs
   Keycloak over plain HTTP on `:8080`, so these are only required for the
   production overlay, but they are generated up front to keep prod ready.
7. **Ensures `docker/keycloak/realm-export.json` exists.** Keycloak imports
   this file at boot, so it must be present before `docker compose up`. The
   governance-only kernel ships no feature modules, so the committed
   `realm-export.json` already equals the base realm (the `gremion-ui` and
   `gremion-admin` OIDC clients only). The script regenerates it only when a
   vertical config is supplied — see [Regenerating the realm export](#regenerating-the-realm-export).
8. **Builds the images** (`docker compose build --quiet`).
9. **Starts the core services** — `postgres`, `keycloak`, `gremion-ui`. The
   `depends_on` health gates bring Postgres and Keycloak up first, so waiting
   on `gremion-ui` health confirms the IdP and database are ready too.
10. **Waits for `gremion-ui` to become healthy** (~60–90s on first run) and
    prints the summary.

> Note: `gremion-ui` is the admin app shell and `gremion-public` is the public
> portal app. Both are a non-normative reference shell — the kernel's guarantees
> do not depend on their markup.

## Environment variables

All configuration lives in `.env` (copied from `.env.example`). The setup
script fills in the secrets and the domain; the rest of the template documents
each variable inline. The most relevant groups:

- **`DOMAIN`** — `localhost` for dev, your real domain for a deployment.
  `DOMAIN_REGEX` (the regexp-escaped domain) is **required in production** for
  the Traefik tenant-wildcard routers.
- **PostgreSQL** — `POSTGRES_USER`/`POSTGRES_PASSWORD`, the Keycloak DB
  (`KEYCLOAK_DB_*`), the application DB (`GREMION_DB_*`), and the control-plane
  DB (`CONTROL_DB_*`, the tenant registry + fleet-migration ledger).
- **Keycloak** — admin credentials, the issuer URL, and the two OIDC client
  secrets (`GREMION_UI_OIDC_CLIENT_SECRET`, `GREMION_ADMIN_OIDC_CLIENT_SECRET`)
  that are substituted into `realm-export.json` at container start.
- **App** — `AUTH_SECRET` (session-cookie signing), `AUTH_KEYCLOAK_*`,
  `INTERNAL_PUSH_SECRET` (internal-fetch auth), `INTERNAL_BASE_URL`.
- **Seeding** — `SEED_TOKEN` gates `POST /api/setup/seed`;
  `SEED_USER_PASSWORD` is set on every seeded user. Leave `SEED_TOKEN` empty to
  disable the endpoint.
- **Email** — defaults route to the bundled **Mailpit** catcher
  (`host=mailpit`, `port=1025`); nothing leaves the host. Read trapped mail at
  `http://localhost:8026`. Point at a real relay only for production.
- **Public portal** — `PUBLIC_DB_PASSWORD` / `GREMION_PUBLIC_DB_URL` (a read-only
  role) plus the Impressum contact fields (TMG §5).
- **Backups** — `RESTIC_PASSWORD` and the provider-agnostic `RCLONE_*` settings.

To validate that no placeholders are left:

```bash
make validate-env
```

## Services

The governance-only stack runs **7 default services**:

| Service        | Purpose                                            |
| -------------- | -------------------------------------------------- |
| `postgres`     | Application, Keycloak, and control-plane databases |
| `keycloak`     | Identity provider (OIDC, roles, LoA/ACR step-up)   |
| `gremion-ui`     | Admin app shell (governance domain)                |
| `gremion-public` | Public portal (read-only)                          |
| `legal`        | Impressum / Datenschutz pages                      |
| `vector`       | Log shipping / processing                          |
| `mailpit`      | Local SMTP catcher (dev/staging)                   |

The **production profile** (`profiles: [production]` in `docker-compose.yml`)
adds `traefik` and `docker-socket-proxy`; `docker-compose.prod.yml` adds
`pgbouncer` and `cloudflared`.

## Verifying the stack

```bash
make ps        # running containers
make health    # service status + endpoint checks
```

`make health` checks `gremion-ui` (`:3001`), Keycloak (`:8082`), and the legal
service (`:8083`). For the local dev URLs:

- App: `http://localhost:3001`
- Keycloak: `http://localhost:8082/auth`
- Mailpit: `http://localhost:8026`

## Seeding a governance org

There is no separate seed script — seed via the one-time endpoint, gated by
`SEED_TOKEN`:

```bash
curl -X POST -H "X-Seed-Token: $SEED_TOKEN" http://localhost:3001/api/setup/seed
```

This bootstraps the governance structure (org-unit tree, committees, members)
for a tenant. See [`../LOCAL_TESTING.md`](../LOCAL_TESTING.md) for the full
walkthrough.

## Regenerating the realm export

`docker/keycloak/realm-export.json` is the source of truth Keycloak imports at
boot. The committed file is the governance-only base realm (the `gremion-ui` and
`gremion-admin` clients). When you target a vertical with extra modules, the
file is generated from the module manifests + the vertical's `config.json`
(`modules.<id> = true|false` — disabled modules contribute no groups/roles).
Regenerate it **before** `docker compose up`:

```bash
# uses ./config/config.json if present, else set CONFIG_PATH explicitly
make gen-realm
CONFIG_PATH=/path/to/config.json make gen-realm
```

`make gen-realm` errors out if neither `CONFIG_PATH` nor `config/config.json`
is present — it does not silently no-op.

## Common operations

```bash
make up                       # start all services
make down                     # stop (keep volumes)
make build                    # build custom images
make rebuild                  # rebuild + force-recreate
make logs SERVICE=gremion-ui    # follow logs for one service
make shell-db                 # psql as the Postgres superuser
make shell-kc                 # shell into the Keycloak container
make keycloak-configure       # apply OIDC client secrets after first start
make dev-configure            # patch gremion-ui/.env.local + KC redirect URIs for the Vite dev server
make dev-ui                   # run the SvelteKit dev server (after dev-configure)
make test                     # unit (BATS) tests
make test-all                 # unit + integration tests (requires a running stack)
make lint                     # shellcheck + yamllint + JSON + compose-config validation
```

## Next steps

- Local development and testing: [`../LOCAL_TESTING.md`](../LOCAL_TESTING.md)
- Day-to-day development workflow: [`../DEVELOPMENT.md`](../DEVELOPMENT.md)
- Concepts, architecture, and the governance charter:
  [`../about-gremion.md`](../about-gremion.md)
