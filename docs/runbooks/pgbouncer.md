# Runbook: PgBouncer + pinned connection budget

PgBouncer is part of the **production profile** of the Gremion governance
kernel. It is defined in `docker-compose.prod.yml` and is not loaded in dev or
CI. This runbook covers deploying, verifying, and rolling it back.

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

The shared `postgres:16-alpine` instance also serves Keycloak **directly**
(Keycloak does not go through PgBouncer). `ADMIN_RESERVE` plus PgBouncer's
`max_db_connections=25` cap keep the app's share bounded.

## How the production profile differs

| Surface | Dev / CI (base file) | Production (prod overlay) |
| --- | --- | --- |
| `postgres` | image-default `max_connections` | explicit `command: ["postgres", "-c", "max_connections=100"]` (pinned — container **recreate** required) |
| `pgbouncer` | not present | `edoburu/pgbouncer` (digest-pinned), `pgbouncer.ini` + `userlist.txt` mounted, listens on `pgbouncer:6432` (no host port) |
| `gremion-ui` `DATABASE_URL` | `…@postgres:5432/gremion` | `…@pgbouncer:6432/gremion` (prod overlay override) |
| `CONTROL_DATABASE_URL` | direct to postgres | **unchanged — direct to postgres** (the control plane must never be routed through PgBouncer; see the prod overlay note) |
| Keycloak | direct to postgres | unchanged (direct) |

Prepared statements: postgres-js runs with `prepare: true` (per-tenant
`conn_profile.prepare`). PgBouncer ≥ 1.21 supports that in transaction mode via
`max_prepared_statements = 200` (set in `pgbouncer.ini`). Do not downgrade the
image below 1.21 without flipping `conn_profile.prepare` to `false` per tenant.

All commands below use the full prod file set (never a partial `-f` list — a
partial set recreates dependencies with the invoked config):

```bash
DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile production"
```

> **One-time setup must precede the first prod-overlay `up -d`.** The
> bind-mounted `docker/pgbouncer/userlist.txt` is gitignored. If it does not
> exist when `gremion-ui` (which points at `pgbouncer:6432`) is brought up,
> Docker materializes a **directory** at that mount path, PgBouncer cannot
> start, and `gremion-ui` has no database. Always run the [Pre-deploy](#pre-deploy-one-time)
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

4. Render the userlist (gitignored) and restrict it:

   ```bash
   sed "s/CHANGE_ME_pgbouncer_auth/<PGBOUNCER_AUTH_PASSWORD>/" \
     docker/pgbouncer/userlist.txt.example > docker/pgbouncer/userlist.txt
   chmod 600 docker/pgbouncer/userlist.txt
   ```

## Deploy

`restart` reloads **neither** `.env` **nor** `command:` — recreate:

```bash
$DC up -d --force-recreate postgres pgbouncer gremion-ui
```

Recreating `postgres` briefly drops every DB consumer (Keycloak and
gremion-public reconnect on their own); schedule accordingly.

## Verify (in this order)

1. **Pin landed** (postgres was actually recreated):

   ```bash
   $DC exec postgres psql -U postgres -tc 'SHOW max_connections;'   # → 100
   ```

2. **Env landed in the container** (verify INSIDE the container, never trust
   the file):

   ```bash
   $DC exec gremion-ui printenv DATABASE_URL   # → …@pgbouncer:6432/gremion
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
   check `$DC logs gremion-ui` for connection errors. Prepared-statement
   failures here mean the PgBouncer version lost `max_prepared_statements`
   support (see above).

## Rollback

`gremion-ui` is the only PgBouncer consumer — rollback is a one-service repoint:

1. Comment out the `DATABASE_URL` override in `docker-compose.prod.yml`
   (gremion-ui falls back to the base file's direct `postgres:5432` URL).
2. `$DC up -d --force-recreate gremion-ui` (recreate, not restart).
3. Re-run verify step 2 (expect `…@postgres:5432/gremion`) + the app smoke.
4. Optional: `$DC stop pgbouncer` (harmless to leave running). The
   `max_connections` pin needs no rollback — it equals the image default.

## Budget reference (what the unit tests assert)

| Constant | Value | Where |
| --- | --- | --- |
| `MAX_CONNECTIONS` (pinned) | 100 | prod overlay `postgres` command + `pool-registry.ts` |
| `ADMIN_RESERVE` (control pool max 3 + KC-admin/migrations/psql) | 16 | `pool-registry.ts` |
| `POOL_REGISTRY_MAX` (live tenant pools) | 16 | `pool-registry.ts` |
| `TENANT_DB_MAX_LIMIT` (write-clamp on `conn_profile.perTenantMax`) | 5 | `pool-registry.ts` + `tenant/conn-profile.ts` |
| Worst-case app client conns: `16 × 5 + 16 = 96 ≤ 100` | ✓ | `pool-registry.test.ts`, `conn-profile.test.ts` |
| PgBouncer server side per DB (`max_db_connections`) | 25 | `docker/pgbouncer/pgbouncer.ini` |

If `POOL_REGISTRY_MAX`, `ADMIN_RESERVE` or the pin ever change, the unit tests
recompute/fail first; change the compose pin and `pool-registry.ts` together.
