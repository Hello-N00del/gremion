# Development Guide

Guide to setting up and developing the **Gremion governance kernel** locally.

Gremion is an open, self-hostable digital-governance kernel (AGPL-3.0-only). This guide is the operational/technical layer for local development. For the vision, the open-core architecture, the governance charter & invariants, the module SDK, and licensing, read **[docs/about-gremion.md](about-gremion.md)** first.

> The kernel is the governance domain — identity & auth, multi-tenancy, the org/committee model, protocols & resolutions (*Beschlüsse*) with a hash-chained audit trail, and the quorum-aware decision engine. Its own manifests are `core` and `governance`. The feature modules (board, calendar, content, elections, files, finance, handover, messaging, publishing, vault, votes) live under `modules/` in this tree ([modules.md](modules.md)) and the verticals under `verticals/`; modules are switched on per customer and bring their own services only when enabled, so the default local stack runs none of them.
>
> For testing see [TESTING.md](TESTING.md) (infrastructure / shell) and [TESTING-UI.md](TESTING-UI.md) (gremion-ui Vitest).

The reference shell is two apps, `gremion-ui` (the authenticated admin shell) and `gremion-public` (the read-only public portal). Both are a **non-normative reference shell**: they are what the kernel was extracted with, not a ratified UI contract. The tree also holds the operator's `apps/control-panel` and the services under `services/` (`kernel-api`, `governance`).

## Prerequisites

- Docker 24+ with Compose v2
- `openssl` command-line tool (used to generate secrets)
- `git`, `make` and `bash` (`setup.sh` is a bash script; Git Bash or WSL2 on Windows)
- Node 26 + pnpm 10 (`npm i -g pnpm`; the workspace pins `pnpm@10.33.0`) — for the dev server, `check`, `vitest`, and `build`
- ~4 GB RAM available for containers
- macOS, Linux, or Windows (with WSL2)

## The local stack

`make up` starts two compose projects (the pooled stack): the state project `dev-state` (`docker-compose.yml` + the auto-loaded `docker-compose.override.yml`, with `COMPOSE_PROFILES=dev` from `.env`) and one app colour, `dev-app-blue` (`docker-compose.app.yml` + `docker-compose.app.dev.yml`). Together they run **11 services**:

| Service | Project | Purpose | Dev URL |
|---------|---------|---------|---------|
| `postgres` | state | PostgreSQL 18 — the Keycloak DB, the kernel app DB (`gremion`) and the tenancy control-plane DB (`control`) | `localhost:5433` |
| `governance-postgres` | state | PostgreSQL server of the governance service (one database per customer) | (internal) |
| `nats` | state | Message broker | (internal) |
| `keycloak` | state | OIDC identity provider (one realm per tenant) | http://localhost:8082/auth |
| `legal` | state | Static legal pages (Impressum, GDPR) | http://localhost:8083 |
| `vector` | state | Log pipeline with IP pseudonymisation | (internal) |
| `mailpit` | state (`dev` profile) | SMTP catcher | http://localhost:8026 |
| `gremion-ui` | app | SvelteKit admin shell (the kernel app) | http://localhost:3001 (with `curl` and the resolver headers, not from a browser; see below) |
| `gremion-public` | app | Read-only public portal (no auth, no sessions) | http://localhost:3002 |
| `control-panel` | app | Operator panel | (internal) |
| `kernel-api` | app | Kernel API | (internal) |

The `production` profile adds `traefik` + `docker-socket-proxy` (`docker-compose.yml`, `profiles: [production]`), and `docker-compose.prod.yml` adds `pgbouncer` and `fallback`. Those are not started in local dev.

A bare `docker compose` in the repository addresses neither dev project. Where this guide needs compose directly it uses the two command prefixes `$DS` (state project) and `$DA` (app colour) defined in [TROUBLESHOOTING.md](TROUBLESHOOTING.md#default-services--host-ports-local-dev).

## Quick start (5–10 minutes)

```bash
git clone <this-repo> gremion
cd gremion
./scripts/setup.sh        # or: make setup — writes .env itself; on a fresh clone it stops at the image build
echo "TENANT_PROXY_SHARED_SECRET=$(openssl rand -hex 32)" >> .env
./scripts/setup.sh        # keeps the .env, builds and starts the stack
```

Do not copy `.env.example` to `.env` first: `setup.sh` skips secret generation when
the file exists. Why two runs, and how the app on port 3001 is reached afterwards
(with `curl` and the tenant resolver's headers, not from a browser), is in
[LOCAL_TESTING.md](./LOCAL_TESTING.md#quick-start).

`./scripts/setup.sh` (it won't overwrite an existing `.env`):

1. Checks for `docker`, `docker compose` and `openssl`.
2. Prompts for a domain (press Enter for `localhost`).
3. Creates `.env` from `.env.example` (mode `600`) and replaces every `CHANGE_ME_` placeholder with a freshly generated secret. It does not set `TENANT_PROXY_SHARED_SECRET`, which the app project requires (hence the second run above). It also creates `legal/legal.env` from its example.
4. Makes the helper scripts executable.
5. Mints the internal TLS CA + Keycloak server cert (`docker/keycloak/certs/gen-internal-ca.sh`). `internal-ca.pem` is a bind-mount source of the app tier, so it is needed in dev too.
   Renders `docker/pgbouncer/userlist.txt` (`scripts/render-pgbouncer-userlist.sh`: mode `600`, from `PGBOUNCER_AUTH_PASSWORD`; only the prod overlay mounts it). A Linux host that runs the prod overlay passes `--container-group` (mode `640`, group `70`, the gid PgBouncer reads it as; see `docs/runbooks/pgbouncer.md`).
   Runs `scripts/check-bind-sources.sh --all`, the bind-mount preflight (below).
6. Prepares no realm. Keycloak starts with `master` only; a tenant's realm is composed from `docker/keycloak/realm-export.base.json` and created at tenant-create time.
7. Creates the external networks and shared volumes (`make dev-networks`), builds the images (`make build`) and starts the state project, then the blue app colour (`make up`).
8. Waits for `gremion-ui` to report healthy (~60–90s on first run) and prints a summary.

The summary names two URLs:

```
App:       http://localhost:3001
Keycloak:  http://localhost:8082/auth
```

The Keycloak URL opens in a browser. The app URL does not: on the stack as shipped
a browser gets `403` there, and a freshly initialised kernel has no tenant, so a
request that does carry the resolver headers gets `404` until a tenant exists
([LOCAL_TESTING.md](./LOCAL_TESTING.md#quick-start)). `curl -sf http://localhost:3001/healthz`
answers without headers.

All credentials live in `.env` — keep it safe.

### Seed an organisation

The kernel starts empty. Seeding (committees, org-unit tree, members, test users) is done through the one-time HTTP endpoint, gated by `SEED_TOKEN` (in `.env`):

```bash
curl -X POST -H "X-Seed-Token: $SEED_TOKEN" \
  -H "Host: <a host bound to a tenant>" -H "X-Forwarded-Host: <the same host>" \
  -H "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" \
  http://localhost:3001/api/setup/seed
```

The seed runs in the tenant named by the request, so it needs a bound tenant host
and the resolver headers ([LOCAL_TESTING.md](./LOCAL_TESTING.md#the-seed-endpoint-test-fixtures)).

Seeded users get the password in `SEED_USER_PASSWORD`, which `setup.sh` generates into `.env`; read it with `grep '^SEED_USER_PASSWORD=' .env`. `docker-compose.app.yml` sets `GREMION_DISABLE_SEEDS=true`, which keeps the migration runner from applying the `*_seed.sql` files; the endpoint is the explicit seeding path.

### Generated bind-mount sources and the preflight

Two compose bind-mount sources are not in the checkout; every other one is tracked. A missing source is not a compose error: Docker creates it as a root-owned *directory* and the container starts broken.

| Source | Mounted by | Generated by |
|---|---|---|
| `docker/keycloak/certs/internal-ca.pem` | `docker-compose.app.yml` (gremion-ui, control-panel, tenant-create) | `gen-internal-ca.sh` (`make setup`; hosts: `gremion-render`) |
| `docker/pgbouncer/userlist.txt` | `docker-compose.prod.yml` (pgbouncer) | `scripts/render-pgbouncer-userlist.sh` (`make setup`; hosts: `gremion-render`) |

`make preflight` (`scripts/check-bind-sources.sh`) runs before `make up` / `make rebuild`, names every missing source with its generator, and exits non-zero. Add `--all` to include the prod overlay and `compose/`.

## Everyday commands

```bash
make up                  # start the state project, then the blue app colour
make down                # stop both projects, keep volumes
make ps                  # show running containers of both projects
make logs                # follow all logs of both projects
make logs SERVICE=gremion-ui   # follow one service (control-panel and kernel-api: $DA logs -f <service>)
make build               # build custom images (tagged dev)
make rebuild             # build + up -d --force-recreate, both projects
make health              # service status + endpoint checks (KC 8082, legal 8083; its gremion-ui line reads NOT REACHABLE locally, use /healthz)
```

### Shell access

```bash
make shell-db            # psql in the postgres container (postgres superuser)
make shell-kc            # bash in the Keycloak container
```

### Database access from the host

```bash
# App database (governance schema) on the host-mapped port 5433
PGPASSWORD=$(grep '^GREMION_DB_PASSWORD=' .env | cut -d= -f2) \
  psql -h localhost -p 5433 -U gremion -d gremion

# Or use the in-container superuser shell
make shell-db
```

`docker/postgres/init-databases.sh` creates **three** databases on the `postgres` server on first init:

- `gremion` — the governance app data plane (committees, org units, protocols, resolutions, the INV-1 audit log).
- `control` — the tenancy control-plane registry + fleet-migration ledger. `gremion-ui` connects to it **directly** (never via the production PgBouncer overlay).
- `keycloak` — Keycloak's own database.

The same script creates the read-only `gremion_public_reader` role. The governance service has its own server, `governance-postgres`, whose per-customer databases are created by tenant-create.

## gremion-ui dev server (hot reload)

`gremion-ui` can also run as a Vite dev server on the host, next to the Docker stack:

```bash
make up                  # bring the stack up first
make dev-configure       # writes gremion-ui/.env.local + registers the dev redirect URI
make dev-ui              # starts Vite (cd gremion-ui && npm run dev)
```

`make dev-configure` runs `scripts/dev-configure.sh`. It creates `gremion-ui/.env.local` from the root `.env` if it is missing (mode `600`) and points the Keycloak URLs at `http://localhost:8082/auth`, sets `ORIGIN` and `PUBLIC_BASE_URL` to `http://localhost:4001`, and `DATABASE_URL` to the host-mapped Postgres port `5433`. Once Keycloak answers, it adds `http://localhost:4001/auth/callback/keycloak` to the redirect URIs of the `gremion-ui` client in the realm `KEYCLOAK_REALM` names. `make dev-ui` then serves on http://localhost:4001 (`gremion-ui/vite.config.ts`, `strictPort`).

The realm has to exist for the second step, and a request to the dev server goes through the same tenant resolver as the container, so it needs a host bound to a tenant. The local stack creates neither ([LOCAL_TESTING.md](./LOCAL_TESTING.md#setting-up-a-tenant)); this guide carries no verified end-to-end login through the dev server.

> **All app env vars are read via `$env/dynamic/private`** — they are resolved at server startup, not baked in at build time. Never switch to `$env/static/private`.

## Build, type-check, and unit tests

```bash
pnpm install
pnpm -C gremion-ui check                 # i18n compile, the guard scripts below, svelte-kit sync, svelte-check
pnpm -C gremion-ui exec vitest run       # unit tests
pnpm -C gremion-ui build                 # adapter-node production build
```

`pnpm -C gremion-ui check` runs three guard scripts before `svelte-check`:

- `scripts/check-tenant-env-guard.mjs --enforce` — fails on a direct env read of a per-tenant variable outside the tenant-resolver path.
- `scripts/check-app-port-binding.mjs` — enforces the loopback-only dev port bind.
- `scripts/check-tenant-secrets-dir.mjs` — fails if the tenant provisioner credential resolves inside `TENANT_SECRETS_DIR`.

The open-core boundary is a unit test, so it runs with `vitest`, not with `check`: `gremion-ui/src/lib/server/boundary/kernel-clean.test.ts` fails if a kernel source file imports feature-module code. The dependency direction is **kernel → never a module**.

For shell/infra tests (`make test-unit`, `make test-integration`) and the full UI test reference, see [TESTING.md](TESTING.md) and [TESTING-UI.md](TESTING-UI.md).

## Keycloak

The realm name is whatever the last path segment of `AUTH_KEYCLOAK_ISSUER` says. `.env` also ships `KEYCLOAK_REALM`, which is the realm the dev/ops scripts address over the Admin API (`scripts/dev-configure.sh`, `scripts/configure-keycloak-clients.sh`) — the two name ONE realm, so renaming it means editing both. `scripts/check-realm-env.sh` (run by `make validate-env` and by `configure-keycloak-clients.sh` before it writes anything) fails the run when they disagree. The realm document is composed per tenant from `docker/keycloak/realm-export.base.json`, which carries five clients: `gremion-ui` (the app), `gremion-admin` (the admin REST service account), `synapse`, `nextcloud` and `gremion-mobile`. Nothing is imported at boot — `buildTenantRealmDoc` substitutes the client secrets into the composed per-tenant realm document at tenant-create time; the two the app itself uses come from `.env` (`GREMION_UI_OIDC_CLIENT_SECRET`, `GREMION_ADMIN_OIDC_CLIENT_SECRET`), which `setup.sh` generates.

```
Keycloak Admin: http://localhost:8082/auth/admin
Username: admin
Password: (from: grep '^KEYCLOAK_ADMIN_PASSWORD=' .env | cut -d= -f2)
```

```bash
make keycloak-configure   # (re)apply OIDC client secrets to the realm KEYCLOAK_REALM names
make shell-kc             # bash in the Keycloak container
make logs SERVICE=keycloak
```

In dev, Keycloak runs `start-dev` over plain HTTP on `:8080` (host `:8082`). `buildTenantRealmDoc` nevertheless pins every realm it composes to `sslRequired: all`, so a dev realm refuses plain-HTTP requests until you either trust the internal CA or apply a per-realm delta (`$DS exec keycloak /opt/keycloak/bin/kcadm.sh update realms/<realm> -s sslRequired=external`). Production runs `start` with internal TLS (`keycloak:8443`).

### Create test users

Use the admin console (your realm → Users → Add user → set a password under Credentials), or seed a fixture set via the seed endpoint above. Assign users to governance groups/roles for committee and resolution access.

## Inspecting the realm template of a vertical

`make gen-realm` composes `realm-export.base.json` with the realm fragments of the modules a vertical's `config.json` enables (`modules.<id> = true/false`) and writes the result to the gitignored `docker/keycloak/realm-export.json`. Nothing reads that file at boot; it is for inspection only.

```bash
CONFIG_PATH=/path/to/config.json make gen-realm
```

`make gen-realm` requires a config (`CONFIG_PATH` or `config/config.json`); with neither it errors out rather than silently producing an empty realm.

## Environment variables

All configuration lives in `.env`. [ENVIRONMENT.md](ENVIRONMENT.md) is the reference and [`.env.example`](../.env.example) the commented template. The most relevant for local dev:

| Variable | Purpose |
|----------|---------|
| `DOMAIN` | `localhost` for dev; a real domain for deployment |
| `POSTGRES_PASSWORD` | Postgres superuser password |
| `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` | Keycloak bootstrap admin |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | `gremion-admin` service-account secret (admin REST) |
| `AUTH_SECRET` | Auth.js session-cookie signing key |
| `AUTH_KEYCLOAK_ID` / `AUTH_KEYCLOAK_SECRET` | gremion-ui ↔ Keycloak OIDC (the issuer comes from the tenant row, not env) |
| `GREMION_DB_USER` / `GREMION_DB_PASSWORD` / `GREMION_DB_NAME` | App (governance) database |
| `CONTROL_DB_USER` / `CONTROL_DB_PASSWORD` / `CONTROL_DB_NAME` | Tenancy control-plane database |
| `PUBLIC_DB_PASSWORD` | Password of the read-only role `gremion-public` connects as |
| `TENANT_PROXY_SHARED_SECRET` | Proxy-trust secret; required by the app project and not generated by `setup.sh` |
| `SEED_TOKEN` / `SEED_USER_PASSWORD` | The `/api/setup/seed` endpoint |
| `INTERNAL_PUSH_SECRET` | Server-only internal HTTP calls |
| `PUBLIC_CONTACT_*` / `PUBLIC_IMPRINT_RESPONSIBLE` | Public-portal Impressum (TMG §5) |

`setup.sh` fills every `CHANGE_ME_*` placeholder. Run `make validate-env` to confirm none are left.

### Outgoing email

The `dev` profile runs the **Mailpit** catcher (`mailpit:1025` on the state network, no auth, TLS off; web UI at http://localhost:8026). Nothing sends to it by default: a tenant's SMTP host, port and sender are set in the app's Settings → E-Mail and start out unconfigured, and the app accepts `mailpit` and port `1025` there only while `gremion-ui` runs with `SMTP_TEST_ALLOW_PRIVATE=1`. See `docs/runbooks/email-smtp.md`.

## Common tasks

### Reset everything

```bash
make down && $DS down -v && $DA down -v   # stop both projects and delete their volumes
rm .env                                    # regenerate secrets on next setup
./scripts/setup.sh                         # then both runs of the quick start again
```

The external volumes and networks `make dev-networks` created stay; see
[LOCAL_TESTING.md](./LOCAL_TESTING.md#cleanup).

### Rebuild after code changes

```bash
$DA build gremion-ui && $DA up -d gremion-ui
# or rebuild all custom images of both projects
make rebuild
```

### Stop but keep data

```bash
make down                  # both projects down (volumes preserved)
make up                    # restart
```

### Backup / restore

`scripts/backup.sh` and `scripts/restore.sh` take no project flag, so name the state project in the environment of each call ([OPERATIONS.md](OPERATIONS.md#which-compose-project-the-scripts-address)); both need `restic`:

```bash
COMPOSE_PROJECT_NAME=dev-state ./scripts/backup.sh
COMPOSE_PROJECT_NAME=dev-state ./scripts/restore.sh --list-snapshots
COMPOSE_PROJECT_NAME=dev-state ./scripts/restore.sh --snapshot latest gremion
```

## Troubleshooting

### gremion-ui never becomes healthy

```bash
make logs SERVICE=gremion-ui
```

The container's health probe requests `/healthz`, which answers without the tenant resolver's headers. A boot failure is usually a missing/empty DB env var. Confirm the `control` and `gremion` databases exist:

```bash
make shell-db
\l            # should list: postgres, keycloak, gremion, control
```

If the control-plane database is missing on an existing volume, see `docs/runbooks/tenant-edge.md` (the init script only creates it on first init).

### Keycloak won't start

```bash
make logs SERVICE=keycloak     # look for DB connection errors
make shell-db
\l                             # should show the keycloak database
$DS restart keycloak
```

A tenant-create failure usually means an empty `GREMION_UI_OIDC_CLIENT_SECRET` or `GREMION_ADMIN_OIDC_CLIENT_SECRET` — `buildTenantRealmDoc` throws when a confidential client has no generated secret. `setup.sh` generates both when it writes `.env`; on an existing `.env` set them by hand.

### Port already in use

Dev host ports are `3001` (gremion-ui), `3002` (gremion-public), `8082` (keycloak), `8083` (legal), `8026` (mailpit), `5433` (postgres). `gremion-ui` and `gremion-public` are bound in `docker-compose.app.dev.yml`, Keycloak, Mailpit and Postgres in `docker-compose.override.yml`, legal in `docker-compose.yml`. To change the app port, edit `docker-compose.app.dev.yml`, e.g.:

```yaml
gremion-ui:
  ports:
    - "127.0.0.1:9001:3000"
    - "[::1]:9001:3000"
```

Keep the loopback-only bind — a bare `0.0.0.0` bind would let an off-host client set `x-forwarded-host` and select any tenant (`check-app-port-binding.mjs` enforces this).

### OIDC login fails

A login needs a browser session on a tenant host, which the local stack as shipped does not offer; this applies to a deployment behind an edge.

```bash
make logs SERVICE=keycloak
```

Verify, in the Keycloak admin console (Clients → `gremion-ui`), that the redirect URIs include the origin you log in from and that the client secret matches `.env` (`AUTH_KEYCLOAK_SECRET` / `GREMION_UI_OIDC_CLIENT_SECRET`).

## Next steps

1. **[docs/about-gremion.md](about-gremion.md)** — the full overview: open-core architecture, the governance charter & invariants, the module SDK, licensing & contribution, the repo/product family, and the microservice roadmap.
2. **[docs/INDEX.md](INDEX.md)** — the documentation index. Open residuals are tracked in [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md).
3. **[docs/TESTING.md](TESTING.md)** / **[docs/TESTING-UI.md](TESTING-UI.md)** — the test references.
4. **[CONTRIBUTING.md](../CONTRIBUTING.md)** — DCO sign-off, inbound = outbound under AGPL-3.0-only, no CLA.

## Questions?

- Browse [docs/](.) for more guides.
- Review [`.env.example`](../.env.example) for all configuration.
- Check logs: `make logs SERVICE=<service>`.
