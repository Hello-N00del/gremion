# Runbook: PgBouncer + pinned connection budget

PgBouncer is part of the **production profile** of the Gremion governance
kernel. It is defined in `docker-compose.prod.yml` (the state project) and is not
loaded in dev or CI. This runbook covers deploying, verifying, and rolling it
back.

For the kernel's overall architecture and the multi-tenancy model, see
[about-gremion.md](../about-gremion.md). This document is the operational layer.

## What this is

The tenancy design bounds Postgres connections **twice**:

1. **In-process** — a draining LRU of per-tenant pools sized
   `POOL_REGISTRY_MAX (16) × dbMax`, with each tenant's persisted
   `conn_profile.perTenantMax` clamped at registry-write to
   `TENANT_DB_MAX_LIMIT` (= `⌊(MAX_CONNECTIONS − ADMIN_RESERVE) / POOL_REGISTRY_MAX⌋`
   = `⌊(100 − 16) / 16⌋` = **5**). See
   `gremion-ui/src/lib/server/db/pool-registry.ts` and
   `gremion-ui/src/lib/server/tenant/conn-profile.ts`, both unit-tested.
2. **At the socket** — PgBouncer in **transaction mode** fronts the app's
   data-plane connections in production, and Postgres is started with an
   explicit `-c max_connections=100` pin so the asserted budget is runtime
   reality, not an image default.

The shared `postgres:18-alpine` instance also serves Keycloak **directly**
(Keycloak does not go through PgBouncer). `ADMIN_RESERVE` plus PgBouncer's
`max_db_connections=25` cap keep the app's share bounded.

## How the production profile differs

| Surface | Dev / CI (base file) | Production (prod overlay) |
| --- | --- | --- |
| `postgres` | image-default `max_connections` | explicit `command: ["postgres", "-c", "max_connections=100"]` (pinned — container **recreate** required) |
| `pgbouncer` | not present | `edoburu/pgbouncer` (digest-pinned), `pgbouncer.ini` + `userlist.txt` mounted, listens on `pgbouncer-<stack>:6432` on the state network (no host port) |
| `gremion-ui` `DATABASE_URL` | `…@postgres-<stack>:5432/gremion` (`docker-compose.app.dev.yml`) | `…@pgbouncer-<stack>:6432/gremion` (`docker-compose.app.yml`, which has no prod overlay) |
| `CONTROL_DATABASE_URL` | direct to postgres | **unchanged — direct to postgres** (the control plane must never be routed through PgBouncer; see the prod overlay note) |
| Keycloak | direct to postgres | unchanged (direct) |

Prepared statements: postgres-js runs with `prepare: true` (per-tenant
`conn_profile.prepare`). PgBouncer ≥ 1.21 supports that in transaction mode via
`max_prepared_statements = 200` (set in `pgbouncer.ini`). Do not downgrade the
image below 1.21 without flipping `conn_profile.prepare` to `false` per tenant.

All commands below run from the release tree and name the project's env file,
which carries its compose files, project name and profiles (never a partial `-f`
list — a partial set recreates dependencies with the invoked config). `$DC` is
the state project (Postgres, PgBouncer); `$DA` is the serving colour of the app
project (`gremion-ui`):

```bash
DC="docker compose --env-file /opt/gremion/etc/env/state.env"
DA="docker compose --env-file /opt/gremion/etc/env/app-blue.env"   # the serving colour
```

> **One-time setup must precede the first prod-overlay `up -d`.** The
> bind-mounted `docker/pgbouncer/userlist.txt` is gitignored. If it does not
> exist when the state project (which holds PgBouncer) is brought up,
> Docker materializes a **directory** at that mount path, PgBouncer cannot
> start, and `gremion-ui` (which points at `pgbouncer-<stack>:6432`) has no
> database. Always run the [Pre-deploy](#pre-deploy-one-time)
> steps first.

## Pre-deploy (one-time)

1. Set `PGBOUNCER_AUTH_PASSWORD` in `.env` (`openssl rand -hex 32`).
2. Create the auth role (once per cluster) — password = the `.env` value:

   ```bash
   $DC exec postgres psql -U postgres -c \
     "CREATE ROLE pgbouncer_auth LOGIN PASSWORD '<PGBOUNCER_AUTH_PASSWORD>'"
   ```

3. Install the `auth_query` lookup in **every** database PgBouncer routes to
   (today: `gremion`; later: each per-tenant DB on this instance):

   ```bash
   $DC exec -T postgres psql -U postgres -d gremion \
     -f - < docker/pgbouncer/pgbouncer-auth.sql
   ```

   **Existing deployments:** the lookup now carries `AND NOT usesuper` (a
   superuser's verifier is never returned). `CREATE OR REPLACE` is idempotent:
   re-run the command above in every routed database once after upgrading,
   otherwise the old definition keeps serving superuser hashes. Per-tenant kernel
   databases get the new definition the next time `ensureKernelDatabase` runs.

4. Render the userlist (never committed) and check it is in place. The
   PgBouncer container reads the bind-mounted file as uid/gid 70, so on a Linux
   host the file must be readable by gid 70 and by nobody else: mode 0640,
   group 70. `gremion-render` sets both; do not fix the mode by hand. (Docker
   Desktop ignores bind-mount modes, so a pass there says nothing about this.)
   Which renderer to run:

   - a Linux host that runs the prod overlay from a single checkout: pass
     `--container-group`, which writes 0640, hands the file to gid 70 (or
     `GREMION_PGBOUNCER_GID`) before publishing it, and fails when it cannot;
   - Docker Desktop and the plain dev flow: the default, 0600 (no PgBouncer
     container reads the file there; `make setup` runs this form);
   - a distribution host: `gremion-render` (deploy step 4;
     [docs/ops/runbook/install.md](../ops/runbook/install.md) and
     [upgrade.md](../ops/runbook/upgrade.md) carry the observation).

   ```bash
   # Linux single checkout, prod overlay: renders from .env, mode 0640 group 70
   bash scripts/render-pgbouncer-userlist.sh --container-group
   # dev / Docker Desktop: renders from .env, mode 0600 (make setup already does this)
   bash scripts/render-pgbouncer-userlist.sh
   # production hosts: gremion-render, mode 0640 group 70 (deploy step 4)
   stat -c '%a %g %n' docker/pgbouncer/userlist.txt   # 640 70 on a Linux render
   bash scripts/check-bind-sources.sh --all   # fails naming any missing bind source
   ```

## Deploy

`restart` reloads **neither** the env file **nor** `command:` — recreate:

```bash
$DC up -d --force-recreate postgres pgbouncer
$DA up -d --force-recreate gremion-ui
```

Recreating `postgres` briefly drops every DB consumer (Keycloak and
gremion-public reconnect on their own); schedule accordingly. A release deploy
(`gremion-deploy`) recreates the app colour for you.

## Verify (in this order)

1. **Pin landed** (postgres was actually recreated):

   ```bash
   $DC exec postgres psql -U postgres -tc 'SHOW max_connections;'   # → 100
   ```

2. **Env landed in the container** (verify INSIDE the container, never trust
   the file):

   ```bash
   $DA exec gremion-ui printenv DATABASE_URL   # → …@pgbouncer-<stack>:6432/gremion
   ```

3. **PgBouncer routes and authenticates** (psql lives in the postgres
   container; this exercises auth_query end-to-end):

   ```bash
   $DC exec postgres psql \
     "postgresql://gremion:<GREMION_DB_PASSWORD>@pgbouncer:6432/gremion" -tc 'SELECT 1;'
   ```

4. **Pool visibility** (PgBouncer admin console):

   ```bash
   $DC exec postgres psql \
     "postgresql://pgbouncer_auth:<PGBOUNCER_AUTH_PASSWORD>@pgbouncer:6432/pgbouncer" \
     -c 'SHOW POOLS;'
   ```

5. **App smoke:** log in, open a governance page that reads and writes the
   data plane — e.g. create a committee or record a protocol/resolution — then
   check `$DA logs gremion-ui` for connection errors. Prepared-statement
   failures here mean the PgBouncer version lost `max_prepared_statements`
   support (see above).

## Rollback

PgBouncer is not a one-service switch any more. The app tier's `DATABASE_URL`
(`gremion-ui` and the `tenant-create` one-shot in `docker-compose.app.yml`) names
`pgbouncer-<stack>:6432`, and `gremion-tenant`'s create writes each customer's
runtime database URL (`tenant_<slug>_db`, a secret file under `TENANT_SECRETS_DIR`)
from the scheme and host:port of that `DATABASE_URL`
(`authorityOf` in `gremion-ui/src/lib/server/tenant/provisioner/customer-adapters.ts`),
so a customer created while PgBouncer was in front carries the pooler address in
its own file. To take PgBouncer out of the path:

1. Repoint the `DATABASE_URL` of the app tier at `postgres-<stack>:5432`, as
   `docker-compose.app.dev.yml` does for dev, in a release that is then deployed
   with `gremion-deploy`, and rewrite the `tenant_<slug>_db` files of existing
   customers to the direct address.
2. Re-run verify step 2 (expect `…@postgres-<stack>:5432/gremion`) and the app
   smoke.
3. Optional: `$DC stop pgbouncer` (harmless to leave running). The
   `max_connections` pin needs no rollback — it equals the image default.

## Budget reference (what the unit tests assert)

| Constant | Value | Where |
| --- | --- | --- |
| `MAX_CONNECTIONS` (pinned) | 100 | `docker-compose.prod.yml` `postgres` command + `pool-registry.ts` |
| `ADMIN_RESERVE` (control pool max 3 + KC-admin/migrations/psql) | 16 | `pool-registry.ts` |
| `POOL_REGISTRY_MAX` (live tenant pools) | 16 | `pool-registry.ts` |
| `TENANT_DB_MAX_LIMIT` (write-clamp on `conn_profile.perTenantMax`) | 5 | `pool-registry.ts` + `tenant/conn-profile.ts` |
| Worst-case app client conns: `16 × 5 + 16 = 96 ≤ 100` | ✓ | `pool-registry.test.ts`, `conn-profile.test.ts` |
| PgBouncer server side per DB (`max_db_connections`) | 25 | `docker/pgbouncer/pgbouncer.ini` |

If `POOL_REGISTRY_MAX`, `ADMIN_RESERVE` or the pin ever change, the unit tests
recompute/fail first; change the compose pin and `pool-registry.ts` together.
