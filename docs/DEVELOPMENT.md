# Development Guide

Complete guide to setting up and developing the **Gremion governance kernel** locally.

Gremion is an open, self-hostable digital-governance kernel (AGPL-3.0-only). This guide is the operational/technical layer for local development. For the vision, the open-core architecture, the governance charter & invariants, the module SDK, and licensing, read **[docs/about-gremion.md](about-gremion.md)** first.

> The kernel ships the governance domain only — identity & auth, multi-tenancy, the org/committee model, protocols & resolutions (*Beschlüsse*) with a hash-chained audit trail, and the quorum-aware decision engine. Feature modules (elections, newsletter, calendar, files, messages, board, users, finance, content, vault, handover) and ready-made verticals live in **their own repositories** — one repository per module — and attach over the module SDK; none of them are present here. The kernel builds and boots standalone with zero modules.
>
> For testing see [TESTING.md](TESTING.md) (infrastructure / shell) and [TESTING-UI.md](TESTING-UI.md) (gremion-ui Vitest).

The two apps in this repository are `gremion-ui` (the authenticated admin shell) and `gremion-public` (the read-only public portal). Both are a **non-normative reference shell**: they are what the kernel was extracted with, not a ratified UI contract.

## Prerequisites

- Docker 24+ with Compose v2
- `openssl` command-line tool (used to generate secrets)
- `git`
- Node 26 + pnpm (`npm i -g pnpm`) — for the dev server, `check`, `vitest`, and `build`
- ~4 GB RAM available for containers (the kernel runs 7 services, not the full 19-service product)
- macOS, Linux, or Windows (with WSL2)

## The governance-only stack

Local `docker compose` (base + the auto-loaded `docker-compose.override.yml`) brings up **7 services**:

| Service | Purpose | Dev URL |
|---------|---------|---------|
| `postgres` | Postgres 16 — Keycloak DB, the kernel app DB (`gremion`), and the tenancy control-plane DB (`control`) | `localhost:5433` |
| `keycloak` | OIDC identity provider (realm `sturaos`) | http://localhost:8082/auth |
| `gremion-ui` | SvelteKit admin shell (the kernel app) | http://localhost:3001 |
| `gremion-public` | Read-only public portal (no auth, no sessions) | http://localhost:3002 |
| `legal` | Static legal pages (Impressum, GDPR) | http://localhost:8083 |
| `vector` | Log pipeline with IP pseudonymisation | (internal) |
| `mailpit` | SMTP catcher — traps all outgoing mail in dev | http://localhost:8026 |

The production profile adds `traefik` + `docker-socket-proxy` (`docker-compose.yml`, `profiles: [production]`) and `pgbouncer` + `cloudflared` (`docker-compose.prod.yml`). Those are not started in local dev.

## Quick start (5–10 minutes)

```bash
git clone <this-repo> gremion
cd gremion
cp .env.example .env
./scripts/setup.sh        # or: make setup
```

`./scripts/setup.sh` (idempotent — it won't overwrite an existing `.env`):

1. Prompts for a domain (press Enter for `localhost`).
2. Creates `.env` from `.env.example` (mode `600`) and replaces every `CHANGE_ME_` placeholder with a freshly generated secret.
3. Makes the helper scripts executable.
4. Mints the internal TLS CA + Keycloak server cert (needed by the production overlay; harmless in dev).
5. Regenerates `docker/keycloak/realm-export.json` **only if** a vertical `config.json` is supplied (`CONFIG_PATH=…` or `config/config.json`). With neither present it keeps the committed **governance-only** realm (the `gremion-ui` + `gremion-admin` clients only — no feature-module groups/roles).
6. Builds the images and starts the core services (`postgres`, `keycloak`, `gremion-ui`).
7. Waits for `gremion-ui` to report healthy (~60–90s on first run) and prints the app URL.

When it finishes:

```
App:       http://localhost:3001
Keycloak:  http://localhost:8082/auth
```

All credentials live in `.env` — keep it safe.

### Seed an organisation

The kernel starts empty. Seeding (committees, org-unit tree, members, test users) is done through the one-time HTTP endpoint, gated by `SEED_TOKEN` (in `.env`):

```bash
curl -X POST -H "X-Seed-Token: $SEED_TOKEN" http://localhost:3001/api/setup/seed
```

Seeded users get the password in `SEED_USER_PASSWORD` (generated into `.env` by `setup.sh`, which prints it once at the end of its run). Set `GREMION_DISABLE_SEEDS=true` to disable seeding entirely (the dev override already sets this; the endpoint remains the explicit seeding path).

## Everyday commands

```bash
make up                  # docker compose up -d (all 7 services)
make down                # stop, keep volumes
make ps                  # show running containers
make logs                # follow all logs
make logs SERVICE=gremion-ui   # follow one service
make build               # build custom images
make rebuild             # build + up -d --force-recreate
make health              # service status + endpoint checks (gremion-ui 3001, KC 8082, legal 8083)
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

The kernel uses **three** Postgres databases, all created by `docker/postgres/init-databases.sh` on first init:

- `gremion` — the governance app data plane (committees, org units, protocols, resolutions, the INV-1 audit log).
- `control` — the tenancy control-plane registry + fleet-migration ledger. `gremion-ui` connects to it **directly** (never via the production PgBouncer overlay).
- `keycloak` — Keycloak's own database.

## gremion-ui dev server (hot reload)

The SvelteKit app can run as a hot-reload dev server against the running Docker stack instead of inside the container.

```bash
make up                  # bring the stack up first
make dev-configure       # patches gremion-ui/.env.local + registers the dev redirect URI
make dev-ui              # starts Vite (or: cd gremion-ui && pnpm dev)
```

`make dev-configure` runs `scripts/dev-configure.sh`, which writes the local env file and ensures `http://localhost:5173` is a valid Keycloak redirect URI. The Vite dev server then serves at http://localhost:5173.

> **All app env vars are read via `$env/dynamic/private`** — they are resolved at server startup, not baked in at build time. Never switch to `$env/static/private`.

## Build, type-check, and unit tests

```bash
pnpm install
pnpm -C gremion-ui check                 # svelte-check + tsc (+ kernel guards, see below)
pnpm -C gremion-ui exec vitest run       # unit tests
pnpm -C gremion-ui build                 # adapter-node production build
```

`pnpm -C gremion-ui check` also runs the kernel guard scripts, including:

- `boundary/kernel-clean.test.ts` (via the boundary enforcer in `gremion-ui/src/lib/server/boundary/`) — fails if the kernel imports any feature module by name. The dependency direction is **kernel → never a module**.
- `scripts/check-domain-regex.mjs` — fails the build if a real prod `DOMAIN` is set with an empty `DOMAIN_REGEX`.
- `scripts/check-app-port-binding.mjs` — enforces the loopback-only dev port bind.
- `scripts/check-tenant-secrets-dir.mjs` — fails if the tenant provisioner credential resolves inside `TENANT_SECRETS_DIR`.

For shell/infra tests (`make test-unit`, `make test-integration`) and the full UI test reference, see [TESTING.md](TESTING.md) and [TESTING-UI.md](TESTING-UI.md).

## Keycloak

The realm is `sturaos` and imports `docker/keycloak/realm-export.json` at container start. The governance-only realm ships exactly two OIDC clients: `gremion-ui` (the app) and `gremion-admin` (the admin REST service account). Both client secrets are substituted into the realm file at boot by `docker/keycloak/substitute-realm-secrets.sh` from `.env` (`GREMION_UI_OIDC_CLIENT_SECRET`, `GREMION_ADMIN_OIDC_CLIENT_SECRET`) — `setup.sh` generates them.

```
Keycloak Admin: http://localhost:8082/auth/admin
Username: admin
Password: (from: grep '^KEYCLOAK_ADMIN_PASSWORD=' .env | cut -d= -f2)
```

```bash
make keycloak-configure   # (re)apply OIDC client secrets after first start
make shell-kc             # bash in the Keycloak container
make logs SERVICE=keycloak
```

In dev, Keycloak runs `start-dev` over plain HTTP on `:8080` (host `:8082`) with the realm at `sslRequired: external`, so pure-local browser login works without per-developer CA trust. Production runs `start` with internal TLS (`keycloak:8443`) and the realm at `sslRequired: all`.

### Create test users

Use the admin console (Realm `sturaos` → Users → Add user → set a password under Credentials), or seed a fixture set via the seed endpoint above. Assign users to governance groups/roles for committee and resolution access.

## Regenerating the realm for a vertical

The realm export is generated from the module manifests plus a vertical's `config.json` (`modules.<id> = true/false`). The kernel ships exactly two manifests — `core` (`id 'core'`, not toggleable) and `governance` (`id 'governance'`, not toggleable) — so the committed realm equals the base realm. To target a vertical that enables private modules:

```bash
CONFIG_PATH=/path/to/config.json make gen-realm   # run BEFORE docker compose up
```

`make gen-realm` requires a config (`CONFIG_PATH` or `config/config.json`); with neither it errors out rather than silently producing an empty realm.

## Environment variables

All configuration lives in `.env`. See [`.env.example`](../.env.example) for the full, commented list. The most relevant for local dev:

| Variable | Purpose |
|----------|---------|
| `DOMAIN` | `localhost` for dev; a real domain for deployment |
| `POSTGRES_PASSWORD` | Postgres superuser password |
| `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` | Keycloak bootstrap admin |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | `gremion-admin` service-account secret (admin REST) |
| `AUTH_SECRET` | Auth.js session-cookie signing key |
| `AUTH_KEYCLOAK_ID` / `AUTH_KEYCLOAK_SECRET` / `AUTH_KEYCLOAK_ISSUER` | gremion-ui ↔ Keycloak OIDC |
| `GREMION_DB_USER` / `GREMION_DB_PASSWORD` / `GREMION_DB_NAME` | App (governance) database |
| `CONTROL_DB_USER` / `CONTROL_DB_PASSWORD` / `CONTROL_DB_NAME` | Tenancy control-plane database |
| `PUBLIC_DB_PASSWORD` / `GREMION_PUBLIC_DB_URL` | Read-only role used by `gremion-public` |
| `SEED_TOKEN` / `SEED_USER_PASSWORD` | The `/api/setup/seed` endpoint |
| `INTERNAL_PUSH_SECRET` / `INTERNAL_BASE_URL` | Server-only internal HTTP calls |
| `PUBLIC_CONTACT_*` / `PUBLIC_IMPRINT_RESPONSIBLE` | Public-portal Impressum (TMG §5) |

`setup.sh` fills every `CHANGE_ME_*` placeholder. Run `make validate-env` to confirm none are left.

### Outgoing email

By default the stack sends all mail to the **Mailpit** catcher (`host=mailpit port=1025`, no auth, TLS off) — nothing leaves the host. Read trapped messages at http://localhost:8026. Switching to a real outbound relay is a pure `.env` change (host/port/from are set in the app's Settings → E-Mail wizard; only the SMTP password comes from `EMAIL_HOST_PASSWORD`). See `docs/runbooks/email-smtp.md`.

## Common tasks

### Reset everything

```bash
docker compose down -v     # stop and remove all containers + volumes
rm .env                    # regenerate secrets on next setup
make setup
```

### Rebuild after code changes

```bash
docker compose build gremion-ui && docker compose up -d gremion-ui
# or rebuild all custom images
make rebuild
```

### Stop but keep data

```bash
make down                  # docker compose down (volumes preserved)
make up                    # restart
```

### Backup / restore

```bash
./scripts/backup.sh        # back up the databases
ls -lh backups/
./scripts/restore.sh gremion backups/gremion-YYYYMMDD-HHMMSS.sql.gz
./scripts/restore.sh keycloak backups/keycloak-YYYYMMDD-HHMMSS.sql.gz
```

## Troubleshooting

### gremion-ui never becomes healthy

```bash
make logs SERVICE=gremion-ui
```

The health probe sends an `X-Forwarded-Host` header itself because the fail-closed tenant resolver 404s any request without one. A boot failure is usually a missing/empty DB env var. Confirm the `control` and `gremion` databases exist:

```bash
make shell-db
\l            # should list: postgres, keycloak, gremion, control
```

If the control-plane database is missing on an existing volume, see `docs/runbooks/tenant-edge.md` (the init script only creates it on first init).

### Keycloak won't start

```bash
make logs SERVICE=keycloak     # look for DB connection or realm-import errors
make shell-db
\l                             # should show the keycloak database
docker compose restart keycloak
```

A realm-import failure usually means an empty `GREMION_UI_OIDC_CLIENT_SECRET` or `GREMION_ADMIN_OIDC_CLIENT_SECRET` — `substitute-realm-secrets.sh` fails fast if either is empty. Re-run `make setup` or `make keycloak-configure`.

### Port already in use

Dev host ports are `3001` (gremion-ui), `3002` (gremion-public), `8082` (keycloak), `8083` (legal), `8026` (mailpit), `5433` (postgres). To change one, override it in `docker-compose.override.yml`, e.g.:

```yaml
gremion-ui:
  ports:
    - "127.0.0.1:9001:3000"
    - "[::1]:9001:3000"
```

Keep the loopback-only bind — a bare `0.0.0.0` bind would let an off-host client set `x-forwarded-host` and select any tenant (`check-app-port-binding.mjs` enforces this).

### OIDC login fails

```bash
make logs SERVICE=keycloak
```

Verify, in the Keycloak admin console (Clients → `gremion-ui`), that the redirect URIs include your dev origin and that the client secret matches `.env` (`AUTH_KEYCLOAK_SECRET` / `GREMION_UI_OIDC_CLIENT_SECRET`).

## Next steps

1. **[docs/about-gremion.md](about-gremion.md)** — the full overview: open-core architecture, the governance charter & invariants, the module SDK, licensing & contribution, the repo/product family, and the microservice roadmap.
2. **[docs/INDEX.md](INDEX.md)** — the documentation index. These docs were rewritten to the governance kernel during the carve out of the StuRaOS monorepo; remaining carve residuals are tracked in [`KNOWN_ISSUES.md`](../KNOWN_ISSUES.md).
3. **[docs/TESTING.md](TESTING.md)** / **[docs/TESTING-UI.md](TESTING-UI.md)** — the test references.
4. **[CONTRIBUTING.md](../CONTRIBUTING.md)** — DCO sign-off, inbound = outbound under AGPL-3.0-only, no CLA.

## Questions?

- Browse [docs/](.) for more guides.
- Review [`.env.example`](../.env.example) for all configuration.
- Check logs: `make logs SERVICE=<service>`.
