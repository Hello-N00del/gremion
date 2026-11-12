# Troubleshooting Guide

Quick reference for common issues in the **Gremion governance kernel** and their
solutions. For vision, architecture, and the governance charter, see
[about-gremion.md](about-gremion.md). For deeper operational guides:

- [DEVELOPMENT.md](DEVELOPMENT.md) — local development setup
- [LOCAL_TESTING.md](LOCAL_TESTING.md) — first-run + seeding walk-through
- [OPERATIONS.md](OPERATIONS.md) — monitoring, backup, maintenance
- [ENVIRONMENT.md](ENVIRONMENT.md) — environment variable reference
- [deployment.md](deployment.md) — production deployment
- [architecture.md](architecture.md) — technical architecture
- [runbooks/](runbooks/) — `tenant-edge.md`, `tenant-lifecycle.md`, `email-smtp.md`, `pgbouncer.md`, `dead-letter.md`
- [ops/runbook/](ops/runbook/README.md) — install, upgrade, backup and restore on a distribution host

> **Scope.** The kernel is identity & auth (Keycloak OIDC), multi-tenancy, the
> governance domain (committees, members, org-unit tree, protocols,
> resolutions/Beschlüsse, the public portal), the governance invariant hooks, and
> the module SDK. Its own manifests are `core` and `governance`; the feature
> modules (board, calendar, content, elections, files, finance, handover,
> messaging, publishing, vault, votes) live under `modules/` in this tree
> ([modules.md](modules.md)), are switched on or off per customer, and bring their
> own services only when enabled.

---

## Default services & host ports (local dev)

`make up` starts two compose projects: the state project `dev-state` (base file +
`docker-compose.override.yml`, `COMPOSE_PROFILES=dev`) and the app project
`dev-app-blue` (`docker-compose.app.yml` + `docker-compose.app.dev.yml`). The
override files expose these on loopback only:

| Service        | Role                                      | Dev URL / port (localhost) |
|----------------|-------------------------------------------|----------------------------|
| `postgres`     | Database (Keycloak + kernel + control)    | `127.0.0.1:5433` → 5432    |
| `keycloak`     | Identity provider (OIDC/SSO)              | http://localhost:8082/auth |
| `gremion-ui`     | Admin shell (governance app)              | http://localhost:3001      |
| `gremion-public` | Read-only public portal                   | http://localhost:3002      |
| `legal`        | Static legal pages (Impressum, GDPR)      | http://localhost:8083      |
| `mailpit`      | SMTP catcher (web UI)                     | http://localhost:8026      |
| `vector`       | Log pipeline (IP pseudonymisation)        | internal only              |
| `governance-postgres`, `nats`, `control-panel`, `kernel-api` | governance databases, broker, operator panel, kernel API | internal only |

The **production** profile adds `traefik` + `docker-socket-proxy`
(`docker-compose.yml`, `profiles: [production]`), and `docker-compose.prod.yml`
adds `pgbouncer` and `fallback`. Local dev reaches services directly on the ports
above and does not run Traefik.

A bare `docker compose` in the repository addresses neither dev project (the
Makefile runs them with `STACK=dev`). This guide uses the Makefile's two command
prefixes:

```bash
DS="env STACK=dev IMAGE_TAG=dev docker compose -p dev-state"
DA="env STACK=dev COLOUR=blue IMAGE_TAG=dev docker compose -f docker-compose.app.yml -f docker-compose.app.dev.yml -p dev-app-blue"
```

`$DS` is `DEV_STATE` (postgres, governance-postgres, nats, keycloak, legal, vector,
mailpit) and `$DA`
is `DEV_APP` (gremion-ui, gremion-public, control-panel, kernel-api). On a
distribution host use `docker compose --env-file /opt/gremion/etc/env/<project>.env`
instead ([ops/runbook/README.md](ops/runbook/README.md)).

> `gremion-ui` and `gremion-public` are the admin shell app and the public
> portal app, respectively.

---

## General diagnostics

### Check overall health

```bash
# All-in-one: container status + endpoint probes
make health

# Raw compose view of both projects
make ps
make logs                         # all services
make logs SERVICE=gremion-ui        # one service
```

`make health` probes `gremion-ui` (3001), Keycloak (8082) and Legal (8083). Its
`gremion-ui` line reads `NOT REACHABLE` on a healthy local stack: the target
requests `/` without the tenant resolver's headers and gets a 403. Use
`curl -sf http://localhost:3001/healthz` (no headers needed) and the `healthy`
state in `make ps` for `gremion-ui`.

### Verify prerequisites

```bash
docker --version
docker compose version            # must be v2+ (the `docker compose` subcommand)
openssl version                   # required by setup.sh to mint secrets
```

### Validate your `.env`

```bash
make validate-env                 # fails if any CHANGE_ME_ placeholder remains
```

---

## First-run setup (`setup.sh` / `make setup`)

`make setup` runs `scripts/setup.sh`, which: creates `.env` from `.env.example`,
generates random secrets, mints the internal TLS CA, renders the PgBouncer
userlist, checks the compose bind-mount sources, creates the dev networks and
volumes, builds the images, and starts the state project and the blue app colour
(`make up`) — then waits for `gremion-ui` to become healthy. No realm file is
prepared (B-01). Do not copy `.env.example` to `.env` yourself first: the script
skips secret generation when `.env` exists. A first run on a fresh clone stops at
the image build until `TENANT_PROXY_SHARED_SECRET` is added to `.env` (last row of
the table below; the two-run sequence is in
[LOCAL_TESTING.md](LOCAL_TESTING.md#quick-start)).

### Setup aborts before starting containers

| Symptom (`[setup]` error) | Cause | Fix |
|---|---|---|
| `Docker is not installed` / `Docker Compose (v2) is not installed` | Missing/old Docker | Install Docker with the `compose` plugin |
| `openssl is required to generate secrets` | `openssl` not on PATH | Install OpenSSL |
| `Invalid domain name` | Domain prompt got a bad value | Re-run; press Enter for `localhost`, or enter a valid hostname |
| `Some CHANGE_ME_ placeholders were not replaced` | `sed` incompatibility | Check your `sed`; on macOS the script uses BSD `sed -i ''` automatically |
| `gen-realm: set CONFIG_PATH=...` | `make gen-realm` run without a vertical config | Supply `CONFIG_PATH=/path/to/config.json` or add `config/config.json`. Nothing needs `realm-export.json` to exist: B-01 deleted the boot import and the file is a gitignored generator output |
| `required variable TENANT_PROXY_SHARED_SECRET is missing a value` (from `make build` / `make up`) | `docker-compose.app.yml` requires it for `kernel-api`; `.env.example` ships it commented out and `setup.sh` does not set it | Append a value to the `.env` that `setup.sh` wrote (`echo "TENANT_PROXY_SHARED_SECRET=$(openssl rand -hex 32)" >> .env`) and run `./scripts/setup.sh` again. The tenant resolver's proxy-trust gate is then on: a request to port 3001 must carry `x-proxy-trust`, `X-Forwarded-Host` and a matching `Host` ([LOCAL_TESTING.md](LOCAL_TESTING.md#probing-gremion-ui-by-hand)) |

### `.env` already exists — secrets not regenerated

`setup.sh` skips secret generation if `.env` exists, which is also what happens
when `.env.example` was copied to `.env` by hand before the first run (`make
validate-env` then lists the `CHANGE_ME_` placeholders). To start clean:

```bash
rm .env && make setup
```

The new `.env` again lacks `TENANT_PROXY_SHARED_SECRET`; add it as in the table
above.

> `.env` holds the Postgres superuser password, the Keycloak admin password,
> `AUTH_SECRET`, the OIDC client secrets and the restic passphrase. `setup.sh`
> `chmod 600`s it — keep it that way and never commit it.

### `gremion-ui` health check timed out during setup

The wait loop in `setup.sh` polls for ~3 minutes. If it times out:

```bash
make logs SERVICE=gremion-ui
```

`gremion-ui` is in another compose project than Postgres and Keycloak, so it has
no `depends_on` on them: its own boot retry waits for the control database. A
timeout usually means one of them is not up — check `make ps` and the logs for
`postgres` / `keycloak` first.

### Seeding a starter organisation

`fresh-start` is retired; seed via the one-time endpoint after the stack is up and
a tenant exists. The seed runs in the request's tenant context, so the request
names a host that is bound to a provisioned tenant and carries the resolver's
headers (`SEED_TOKEN` and `TENANT_PROXY_SHARED_SECRET` are the values in `.env`):

```bash
curl -X POST -H "X-Seed-Token: $SEED_TOKEN" \
  -H "Host: <a host bound to a tenant>" \
  -H "X-Forwarded-Host: <the same host>" \
  -H "x-proxy-trust: $TENANT_PROXY_SHARED_SECRET" \
  http://localhost:3001/api/setup/seed
```

Leave `SEED_TOKEN` empty to disable the endpoint. The endpoint answers `409` when
`org_units` is not empty. See
[LOCAL_TESTING.md](LOCAL_TESTING.md#the-seed-endpoint-test-fixtures).

---

## A platform with no tenant answers 404, not a setup page

**Symptom:** a freshly started stack answers **HTTP 404** on every host
(`/healthz` answers `200`), and there is no setup page.

**This is expected.** The first-run setup wizard and the default tenant are gone
(TASK-042, TRD-075): a platform with zero customers boots healthy and serves no
tenant on any host. A tenant exists once a `create` request has run, which binds
its host ([runbooks/tenant-lifecycle.md](runbooks/tenant-lifecycle.md),
[runbooks/tenant-edge.md](runbooks/tenant-edge.md)).

---

## A tenant answers 503 "incomplete brand identity"

**Symptom:** a tenant returns a **tenant-scoped HTTP 503**, and the logs show:

```
[fleet-migrations] tenant <slug>: FAILED — tenant "<slug>" config has an INCOMPLETE brand identity ...
```

During boot the fleet runs each active tenant's migrations and then asserts a
**complete** brand identity (`product` / `org_short` / … in the tenant's
`config.json`). A tenant whose stored config lacks it is recorded `failed` and
`resolve.ts` serves a **tenant-scoped** 503 instead of rendering a blank brand.
Other tenants are unaffected.

**Fix:** write a complete config for that tenant:
`pnpm -C gremion-ui exec tsx scripts/tenant-provision.ts materialize-config <slug>`
refuses (exit non-zero, writes nothing) a still-blank brand and otherwise bakes
the merged config back
([runbooks/tenant-lifecycle.md](runbooks/tenant-lifecycle.md), "Materialize
config"). A tenant created by a create request already carries the brand the
request named.

---

## PostgreSQL

`postgres` runs Keycloak's DB, the kernel app DB (`gremion`), and the
**control-plane** DB (`control`, the tenant registry + fleet-migration ledger),
all created on first init by `docker/postgres/init-databases.sh`.

### Connection failed / timeout

```bash
make shell-db                          # psql -U postgres
make ps
make logs SERVICE=postgres
$DS exec postgres pg_isready -U postgres
```

| Cause | Fix |
|---|---|
| Postgres still starting | Wait for the healthcheck (`start_period` 20s); `gremion-ui`'s boot retry waits for it |
| Wrong credentials | Check `.env`: `POSTGRES_PASSWORD`, `GREMION_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD`, `CONTROL_DB_PASSWORD` |
| Disk full | `df -h`; prune Docker (see below) |
| Network missing | `docker network inspect dev_state` (`make dev-networks` creates `dev_state` and `dev_edge`) |

### Restart or rebuild

```bash
$DS restart postgres

# Full reset — DESTROYS the database volumes (dev-state_pg-data and the others)
make down && $DS down -v && make up
```

### Control-plane DB missing (`503` on every request)

If `init-databases.sh` ran on a pre-existing volume the `control` DB may be
absent — `gremion-ui`'s `runControlMigrations()` then dies on boot and all
requests 503. Create it with the one-shot in
[runbooks/tenant-edge.md](runbooks/tenant-edge.md) (step 3). Note
`CONTROL_DATABASE_URL` targets `postgres-<stack>:5432` **directly** and must never
be re-pointed at PgBouncer.

> Changing a DB password in `.env` requires recreating the services that read it
> (`$DS up -d --force-recreate postgres`, `$DA up -d --force-recreate gremion-ui`)
> — a plain `restart` does **not** reload `.env`.

---

## Keycloak & OIDC

The realm is named by the last path segment of `AUTH_KEYCLOAK_ISSUER` (`<realm>`
below), and `.env`'s `KEYCLOAK_REALM` must name that same realm — it is what the
dev/ops scripts hand the Admin API. `make validate-env` fails when the two
disagree (`scripts/check-realm-env.sh`); before that guard existed the mismatch
was silent, and `configure-keycloak-clients.sh` would reset the client secrets
of a realm nobody logs into. The realm carries five clients. The app itself uses two,
**`gremion-ui`** (Auth.js) and **`gremion-admin`** (the admin REST service account);
the base realm also carries `synapse`, `nextcloud` and `gremion-mobile`.
B-01: **no realm is imported at boot.** The realm is COMPOSED from
`docker/keycloak/realm-export.base.json` by `buildTenantRealmDoc` and created
over the Admin API at tenant-create time, with the OIDC client secrets taken
from `.env` at that point.

### Keycloak won't start

```bash
make logs SERVICE=keycloak
$DS exec postgres psql -U postgres -c '\l'   # keycloak DB should exist
```

| Cause | Fix |
|---|---|
| Postgres not healthy | Keycloak `depends_on: postgres (service_healthy)` (same project) — fix Postgres first |
| Wrong DB credentials | Check `.env`: `KEYCLOAK_DB_PASSWORD` |
| Tenant-create fails on the realm | A required OIDC secret is empty — `buildTenantRealmDoc` throws; ensure `GREMION_UI_OIDC_CLIENT_SECRET` and `GREMION_ADMIN_OIDC_CLIENT_SECRET` are set |
| Port 8082 in use | Change the dev mapping in `docker-compose.override.yml` |

```bash
$DS restart keycloak
```

### Can't reach the Keycloak admin console

**URL:** http://localhost:8082/auth/admin

```bash
make ps
curl -I http://localhost:8082/auth/health/ready
grep '^KEYCLOAK_ADMIN' .env            # admin username + password
```

> In production the admin console + Admin REST API are IP-restricted by
> `KC_ADMIN_ALLOWLIST_CIDRS` (default `127.0.0.1/32` = nobody). Use
> `docker compose --env-file /opt/gremion/etc/env/state.env exec keycloak /opt/keycloak/bin/kcadm.sh`
> or a port-forward, or add your bastion/VPN CIDR.

### OIDC client not found / secret mismatch

The composed realm document carries the clients, but their secrets come from
`.env`. To (re)apply them:

```bash
make keycloak-configure                # scripts/configure-keycloak-clients.sh
```

Verify the discovery document is reachable and well-formed:

```bash
curl -s http://localhost:8082/auth/realms/<realm>/.well-known/openid-configuration | jq .
```

### OIDC login redirect loop

Usually a redirect-URI or origin mismatch.

1. Keycloak admin → the tenant's realm → Clients → `gremion-ui` → **Valid Redirect URIs**.
   They must cover the origin the browser logs in from, which is the tenant's host.
   The local stack as shipped offers no browser login on port 3001
   ([below](#every-request-to-port-3001-answers-403-locally)).
2. Confirm the tenant's registry issuer (the per-tenant `issuer` the app reads;
   gremion-ui no longer reads `AUTH_KEYCLOAK_ISSUER`) matches the
   browser-visible issuer (`http://localhost:8082/auth/realms/<realm>` in dev).
3. For the Vite dev server, `make dev-configure` writes `gremion-ui/.env.local`
   and adds its callback (`http://localhost:4001/auth/callback/keycloak`) to the
   client's redirect URIs ([DEVELOPMENT.md](DEVELOPMENT.md#gremion-ui-dev-server-hot-reload)).

> **Dev vs prod TLS:** dev runs Keycloak in `start-dev` over plain HTTP, but
> B-01 removed the `KC_REALM_SSL_REQUIRED` knob together with the boot import,
> and `buildTenantRealmDoc` pins every realm it composes to `sslRequired: all`.
> A dev realm therefore refuses plain-HTTP requests until you either trust the
> internal CA or apply a per-realm delta:
> `$DS exec keycloak /opt/keycloak/bin/kcadm.sh update realms/<realm> -s sslRequired=external`.
> Production runs `start` with the server-to-server hop over internal TLS
> (`https://keycloak:8443`). A login that works in dev but 403s/redirects in
> prod is almost always missing internal-CA trust (`NODE_EXTRA_CA_CERTS`) or an
> `sslRequired` mismatch.

---

## Multi-tenancy & `x-forwarded-host`

The tenant resolver is **fail-closed**: it looks the WHOLE `x-forwarded-host`
up in `tenant_domain`, and any request whose host is absent, malformed or bound
to no active tenant gets a **404** (it cannot select a tenant), logged as one
`tenant.host.rejected` line naming the host and the reason. Once
`TENANT_PROXY_SHARED_SECRET` is set, which the app project requires on a host and
in local dev alike, a request without a matching `x-proxy-trust` gets a **403**
before any lookup; on a host the edge injects the header.

### Every request to port 3001 answers 403 locally

The request carries no `x-proxy-trust`. A browser cannot send it and the local
stack runs no proxy that adds it, so the app on port 3001 is reached with `curl`
and the headers below, not from a browser. `/healthz` is exempt and answers
without headers.

### Every request 404s locally

A request must carry a host that is BOUND to a tenant (`addTenantDomain`). There
is no default tenant (TRD-075); a create request (TASK-043, run by the host
executor) binds the customer's host ([runbooks/tenant-edge.md](runbooks/tenant-edge.md)
STEP 0a), so a stack with no customer answers 404 on every tenant route. The
`gremion-ui` healthcheck probes `/healthz`, which is exempt from resolution. To
test by hand, send the bound host as `X-Forwarded-Host` AND as `Host` (with the
secret set the resolver answers 404 when the two differ, and a plain `curl` to
`localhost:3001` sends `Host: localhost:3001`), plus `x-proxy-trust`:

```bash
SECRET=$(grep '^TENANT_PROXY_SHARED_SECRET=' .env | cut -d= -f2)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Host: <a-bound-host>' -H 'X-Forwarded-Host: <a-bound-host>' \
  -H "x-proxy-trust: ${SECRET}" \
  http://localhost:3001/
```

The answers are tabulated in
[LOCAL_TESTING.md](LOCAL_TESTING.md#probing-gremion-ui-by-hand).

### A tenant host 404s at the edge (production)

There is no wildcard router: each tenant host needs its own `Host(...)`-literal
router and a `tenant_domain` row. A bare Traefik 404 means the router is
missing; an app 404 logs a `tenant.host.rejected` line with the reason. See
[runbooks/tenant-edge.md](runbooks/tenant-edge.md) STEP 0a.

### Cross-tenant data / wrong tenant resolved on a self-call

`INTERNAL_BASE_URL` must stay `http://gremion-ui-<colour>:3000` (this colour's
in-container origin, derived from `COLOUR` in `docker-compose.app.yml`). If it
falls through to the public apex, the hop crosses the edge, which then decides
what `X-Forwarded-Host` (the whole tenant selector) says; historically that aimed
a second tenant's self-call at the **default** tenant. Do not point it at the
public apex.

---

## Migrations

Two migration sets run at boot: **control-plane** migrations
(`gremion-ui/migrations-control/`, against the `control` DB) and per-tenant
**data-plane** migrations (`gremion-ui/migrations/`, for example
`0001_governance_schema`, `0007_protocols`, `0008_public_portal`,
`0009_audit_log`, `0010_org_units`, `0043_audit_log_hash_chain`, …, plus each
enabled module's `app/migrations/` that the module overlay copies in). The
`migrate` one-shot of the app project runs the same two sets.

### Migration failure on boot

```bash
make logs SERVICE=gremion-ui | grep -i 'migration\|fleet-migrations'
```

- A **control** migration failure makes every request 503 — fix the `control`
  DB connection (see PostgreSQL above) and restart `gremion-ui`.
- A **per-tenant** failure is recorded in the fleet-migration ledger and yields
  a tenant-scoped 503; a common one is the brand-identity guard above.

### Realm template out of date after a config change

The per-tenant realm is composed from `docker/keycloak/realm-export.base.json`
(the committed base, which carries five clients: `gremion-ui`, `gremion-admin`,
`synapse`, `nextcloud` and `gremion-mobile`) and the enabled modules'
manifests by `buildTenantRealmDoc` at tenant-create time. `make gen-realm` writes
the module-composed template for a vertical's `config.json` to the gitignored
`docker/keycloak/realm-export.json`, for inspection only; nothing reads it at
boot:

```bash
CONFIG_PATH=/path/to/config.json make gen-realm
```

(With neither `CONFIG_PATH` nor `config/config.json`, `make gen-realm` errors
rather than no-opping.) An existing tenant realm drifts from a changed template
until `gremion-tenant reconcile <slug> --apply --reason <text>`
([runbooks/tenant-lifecycle.md](runbooks/tenant-lifecycle.md), "Reconcile").

---

## Email (Mailpit)

The `dev` profile runs the **Mailpit** catcher (`mailpit:1025`, no auth, TLS
off); what it receives never leaves the host. Read trapped mail at
http://localhost:8026.

```bash
make ps
make logs SERVICE=mailpit
```

No compose default points the app at the catcher. If a feature reports a send
failure and no mail appears in Mailpit, confirm that the tenant's Settings →
E-Mail name `mailpit` and port `1025` and are marked configured, that
`gremion-ui` runs with `SMTP_TEST_ALLOW_PRIVATE=1` (without it the SMTP target
guard refuses that port and a private address), and that Mailpit is healthy. To
switch to a real relay, see [runbooks/email-smtp.md](runbooks/email-smtp.md).

---

## Docker Compose

### Port already in use

```bash
# Find the conflicting listener (loopback dev ports: 3001 3002 5433 8082 8083 8026)
sudo lsof -i :3001            # macOS/Linux

# Change the host-side mapping in docker-compose.override.yml (state services) or
# docker-compose.app.dev.yml (gremion-ui 3001, gremion-public 3002), e.g. 9001:3000
```

### Docker daemon not running

```bash
# macOS:    open -a Docker
# Linux:    sudo systemctl start docker
# Windows:  ensure Docker Desktop / the WSL2 backend is started
```

### Container crashes on startup

```bash
make ps                                    # exit code
make logs SERVICE=<service>                # control-panel and kernel-api: use `$DA logs -f <service>` (make logs looks for them in the state project)
docker inspect <container-name> | grep -A 20 Health
```

### Network issues between containers

The dev stack's two external networks are **`dev_state`** (databases, Keycloak, NATS,
and the app project) and **`dev_edge`**; `make dev-networks` creates them, and
each app colour adds its own project-scoped `app` network.

```bash
docker network inspect dev_state
$DA exec gremion-ui wget -qO- http://postgres-dev:5432 2>&1 | head   # name resolution (postgres-<stack> alias)

make down && docker network prune && make up
```

### Out of disk space

```bash
df -h
docker system df

docker container prune
docker image prune -a --filter "until=240h"
docker volume prune                         # unused anonymous volumes only; named volumes stay unless you add --all
```

> The state project's named volumes are project-scoped (`dev-state_pg-data`,
> `dev-state_mailpit-data`, `dev-state_traefik-logs`,
> `dev-state_vector-processed-logs`, plus one data volume per module database
> server); the shared volumes `dev_config_data`, `dev_tenant_config_data`,
> `dev_nats_accounts`, `dev_nats_secrets` and `dev_traefik_acme` are external, made
> by `make dev-networks`. Pruning **in-use** volumes is safe; `$DS down -v`
> deletes the project-scoped ones and your data.

---

## Backup & restore

The kernel scripts use **restic** (`RESTIC_PASSWORD` in `.env`) via
`scripts/backup.sh` / `scripts/restore.sh`; a distribution host runs them through
`gremion-backup` ([ops/runbook/backup.md](ops/runbook/backup.md)). See
[OPERATIONS.md](OPERATIONS.md) for the full routine.

```bash
# Diagnose a failing backup
bash -x scripts/backup.sh

# A primary cause is a missing/empty RESTIC_PASSWORD or rclone backend config
grep -E '^(RESTIC_PASSWORD|RCLONE_)' .env
```

`service "postgres" is not running` from `backup.sh` or `restore.sh` on the local
stack means the script addressed no running compose project: both call a bare
`docker compose`. Prefix the call with `COMPOSE_PROJECT_NAME=dev-state`
([OPERATIONS.md](OPERATIONS.md#which-compose-project-the-scripts-address)).

---

## Getting help

### Collect a diagnostic bundle

```bash
{
  echo "=== System ==="; uname -a
  echo "=== Docker ==="; docker --version; docker compose version
  echo "=== Containers ==="; make ps
  echo "=== Health ==="; make health
  echo "=== Logs (last 100) ==="; $DS logs --tail=100; $DA logs --tail=100
  echo "=== .env (redacted) ==="; sed 's/=.*$/=REDACTED/' .env
} > debug.txt
```

### When opening an issue, include

1. The exact error message(s)
2. Steps to reproduce
3. Versions: Docker, `docker compose`
4. Logs from the commands above
5. Your **redacted** `.env`

### Resources

- [about-gremion.md](about-gremion.md) — vision, architecture, governance charter
- [Keycloak documentation](https://www.keycloak.org/documentation)
