# Gremion — Setup Runbook

This is the operational guide for bringing up the Gremion governance kernel
locally with `scripts/setup.sh`. A production host is not set up this way: it is
built with `infra/host/bootstrap.sh` ([`runbook/install.md`](runbook/install.md)).
For the vision, architecture, and governance charter, see
[`about-gremion.md`](../about-gremion.md) — this document is the
technical/operational layer only.

The kernel's own manifests are `core` and `governance`; next to them it carries
identity & auth, multi-tenancy, the module SDK, and the shared packages under
`packages/` (`@gremion/db`, `@gremion/ports` and others). The feature modules
(board, calendar, content, elections, files, finance, handover, messaging,
publishing, vault, votes) live under `modules/` in this tree
([`../modules.md`](../modules.md)), are switched on per customer and bring their
own services only when enabled, so the default local stack runs none of them.

## Prerequisites

- Docker + Docker Compose v2
- `openssl` (used by `scripts/setup.sh` to generate secrets)
- `make` (GNU Make) and `bash`
- Node 26 + pnpm 10.33.0 — only needed for local SvelteKit development outside
  Docker, for the checks and tests, or for `make gen-realm`

## Quick start

The first-run script generates the secrets, mints the internal TLS certs, builds
the images and starts both compose projects:

```bash
./scripts/setup.sh        # or: make setup — writes .env itself; on a fresh clone it stops at the image build
echo "TENANT_PROXY_SHARED_SECRET=$(openssl rand -hex 32)" >> .env
./scripts/setup.sh        # keeps the .env, builds and starts the stack
```

Do not copy `.env.example` to `.env` first: the script skips secret generation
when the file exists. The reason for the two runs is in
[`../LOCAL_TESTING.md`](../LOCAL_TESTING.md#quick-start).

When it finishes it prints the app and Keycloak URLs and reminds you that all
credentials now live in `.env`. The app URL is reached with `curl` and the
resolver headers, not from a browser (see [Verifying the stack](#verifying-the-stack)).

## What `scripts/setup.sh` does

The script can be run again at any time (it never overwrites an existing `.env`)
and runs these steps:

1. **Checks prerequisites** — fails fast if Docker, Docker Compose v2, or
   `openssl` is missing.
2. **Prompts for a domain** — press Enter for `localhost`. The value is written
   to `DOMAIN` in `.env`. Skipped, like steps 3 and 4, when `.env` exists.
3. **Creates `.env` from `.env.example`** and `chmod 600 .env` so the secrets it
   is about to write are not world-readable.
4. **Generates random secrets** for every `CHANGE_ME_*` placeholder — the
   Postgres superuser password, the Keycloak DB and admin passwords, the
   application DB password, the control-plane (tenant-registry) DB password,
   the PgBouncer auth password, the platform, panel, kernel-API, access-record
   and module-switch role passwords, the governance server's password, the
   read-only public-portal DB password, the Auth.js session secret, the OIDC
   client secrets (`gremion-ui` and `gremion-admin`), the seed-endpoint token and
   the seeded-user password, the internal-fetch shared secret, and the restic
   backup passphrase. It then aborts if any `CHANGE_ME_` placeholder remains.
   It does **not** set `TENANT_PROXY_SHARED_SECRET`, which the app project
   requires.
5. **Creates `legal/legal.env`** from `legal/legal.env.example` if it is missing
   (the state project does not render without it).
6. **Makes the helper scripts executable** (`scripts/*.sh`,
   `docker/postgres/init-databases.sh`).
7. **Mints internal TLS certificates** via
   `docker/keycloak/certs/gen-internal-ca.sh` (an internal CA + a Keycloak
   server cert with SAN `keycloak,localhost,127.0.0.1`). The dev stack runs
   Keycloak over plain HTTP on `:8080`, but `docker-compose.app.yml` bind-mounts
   `internal-ca.pem`, so the file has to exist in dev too.
8. **Renders `docker/pgbouncer/userlist.txt`**
   (`scripts/render-pgbouncer-userlist.sh`; only the prod overlay mounts it) and
   runs the bind-mount preflight (`scripts/check-bind-sources.sh --all`).
9. **Prepares no realm.** Keycloak comes up with `master` only; the
   per-tenant realm is composed from
   `docker/keycloak/realm-export.base.json` by `buildTenantRealmDoc` and
   created at tenant-create time. `make gen-realm` still writes the
   module-composed template to the gitignored
   `docker/keycloak/realm-export.json` for inspection — see
   [Regenerating the realm template](#regenerating-the-realm-template).
10. **Creates the external networks and shared volumes** (`make dev-networks`).
11. **Builds the images** (`make build`, both projects). On a fresh clone the
    first run stops here, because the app project does not render without
    `TENANT_PROXY_SHARED_SECRET`.
12. **Starts the state project, then the blue app colour** (`make up`). There is
    no cross-project `depends_on`: `gremion-ui`'s own boot retry waits for
    Postgres.
13. **Waits for `gremion-ui` to become healthy** (~60–90s on first run) and
    prints the summary.

> Note: `gremion-ui` is the admin app shell and `gremion-public` is the public
> portal app. Both are a non-normative reference shell — the kernel's guarantees
> do not depend on their markup.

## Environment variables

All configuration lives in `.env`, which the setup script writes from
`.env.example`. The script fills in the secrets and the domain; the template
documents each variable inline and [`../ENVIRONMENT.md`](../ENVIRONMENT.md) is the
reference. The most relevant groups:

- **`DOMAIN`** — `localhost` for dev. It names the apex only; tenant hosts are
  bound one by one (no wildcard router, see `docs/runbooks/tenant-edge.md`).
- **PostgreSQL** — `POSTGRES_USER`/`POSTGRES_PASSWORD`, the Keycloak DB
  (`KEYCLOAK_DB_*`), the application DB (`GREMION_DB_*`), and the control-plane
  DB (`CONTROL_DB_*`, the tenant registry + fleet-migration ledger).
- **Keycloak** — admin credentials and the two OIDC client secrets
  (`GREMION_UI_OIDC_CLIENT_SECRET`, `GREMION_ADMIN_OIDC_CLIENT_SECRET`)
  that `buildTenantRealmDoc` places into the composed per-tenant realm document
  at tenant-create time (not at container start).
- **App** — `AUTH_SECRET` (session-cookie signing), `AUTH_KEYCLOAK_*`,
  `INTERNAL_PUSH_SECRET` (internal-fetch auth) and
  `TENANT_PROXY_SHARED_SECRET` (the resolver's proxy-trust secret).
- **Seeding** — `SEED_TOKEN` gates `POST /api/setup/seed`;
  `SEED_USER_PASSWORD` is set on every seeded user. Leave `SEED_TOKEN` empty to
  disable the endpoint.
- **Email** — the `dev` profile runs the **Mailpit** catcher (`mailpit:1025`;
  web UI at `http://localhost:8026`). A tenant sends to it only once its
  Settings → E-Mail name that host and port, which the app accepts only with
  `SMTP_TEST_ALLOW_PRIVATE=1` ([`../runbooks/email-smtp.md`](../runbooks/email-smtp.md)).
- **Public portal** — `PUBLIC_DB_PASSWORD` (a read-only role) plus the Impressum
  contact fields (TMG §5).
- **Backups** — `RESTIC_PASSWORD` and `RCLONE_BUCKET`.

To validate that no placeholders are left:

```bash
make validate-env
```

## Services

`make up` runs two compose projects. The state project `dev-state` runs **7
services**:

| Service        | Purpose                                            |
| -------------- | -------------------------------------------------- |
| `postgres`     | Application, Keycloak, and control-plane databases |
| `governance-postgres` | The governance service's database server    |
| `nats`         | Message broker                                     |
| `keycloak`     | Identity provider (OIDC, roles, LoA/ACR step-up)   |
| `legal`        | Impressum / Datenschutz pages                      |
| `vector`       | Log shipping / processing                          |
| `mailpit`      | Local SMTP catcher (`dev` profile)                 |

The app project `dev-app-blue` runs **4 services**:

| Service          | Purpose                             |
| ---------------- | ----------------------------------- |
| `gremion-ui`     | Admin app shell (governance domain) |
| `gremion-public` | Public portal (read-only)           |
| `control-panel`  | Operator panel                      |
| `kernel-api`     | Kernel API                          |

The **production profile** (`profiles: [production]` in `docker-compose.yml`)
adds `traefik` and `docker-socket-proxy`; `docker-compose.prod.yml` adds
`pgbouncer` and `fallback`.

## Verifying the stack

```bash
make ps        # running containers
make health    # service status + endpoint checks
```

`make health` checks `gremion-ui` (`:3001`), Keycloak (`:8082`), and the legal
service (`:8083`). Its `gremion-ui` line reads `NOT REACHABLE` on a healthy local
stack, because the target requests `/` without the tenant resolver's headers; use
`curl -sf http://localhost:3001/healthz` for `gremion-ui`. For the local dev URLs:

- App: `http://localhost:3001` (with `curl` and the resolver headers, not from a
  browser; see [`../LOCAL_TESTING.md`](../LOCAL_TESTING.md#probing-gremion-ui-by-hand))
- Keycloak: `http://localhost:8082/auth`
- Mailpit: `http://localhost:8026`

## Seeding a governance org

There is no separate seed script — seed via the one-time endpoint, gated by
`SEED_TOKEN`:

```bash
curl -X POST -H "X-Seed-Token: $SEED_TOKEN" \
  -H "Host: <a host bound to a tenant>" -H "X-Forwarded-Host: <the same host>" \
  -H "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" \
  http://localhost:3001/api/setup/seed
```

This bootstraps the governance structure (org-unit tree, committees, members)
for the tenant the request names; it needs a bound tenant host and the resolver
headers. See [`../LOCAL_TESTING.md`](../LOCAL_TESTING.md) for the full
walkthrough.

## Regenerating the realm template

`docker/keycloak/realm-export.json` is a gitignored GENERATOR OUTPUT, not
an input to anything at boot. The source of truth is
`docker/keycloak/realm-export.base.json`, which `buildTenantRealmDoc` composes
each tenant's realm from. `make gen-realm` writes the module-composed template for
a vertical (`modules.<id> = true|false` — disabled modules contribute no
groups/roles), which is useful for inspecting what a vertical's realm will
carry:

```bash
# uses ./config/config.json if present, else set CONFIG_PATH explicitly
make gen-realm
CONFIG_PATH=/path/to/config.json make gen-realm
```

`make gen-realm` errors out if neither `CONFIG_PATH` nor `config/config.json`
is present — it does not silently no-op.

## Common operations

```bash
make up                       # start both projects
make down                     # stop both projects (keep volumes)
make build                    # build custom images
make rebuild                  # rebuild + force-recreate
make logs SERVICE=gremion-ui    # follow logs for one service
make shell-db                 # psql as the Postgres superuser
make shell-kc                 # shell into the Keycloak container
make keycloak-configure       # apply OIDC client secrets to the realm KEYCLOAK_REALM names
make dev-configure            # patch gremion-ui/.env.local + KC redirect URIs for the Vite dev server
make dev-ui                   # run the SvelteKit dev server (after dev-configure)
make test                     # unit (BATS) tests
make test-all                 # unit + integration tests and the NATS/events proofs (the integration part needs a running stack)
make lint                     # shellcheck, yamllint, JSON and compose-config validation plus the repository's static guards
```

## Next steps

- Local development and testing: [`../LOCAL_TESTING.md`](../LOCAL_TESTING.md)
- Day-to-day development workflow: [`../DEVELOPMENT.md`](../DEVELOPMENT.md)
- Concepts, architecture, and the governance charter:
  [`../about-gremion.md`](../about-gremion.md)
