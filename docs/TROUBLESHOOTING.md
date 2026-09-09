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
- [runbooks/](runbooks/) — `tenant-edge.md`, `tenant-lifecycle.md`, `email-smtp.md`, `pgbouncer.md`

> **Scope.** The kernel ships a **governance-only** stack: identity & auth
> (Keycloak OIDC), multi-tenancy, the governance domain (committees, members,
> org-unit tree, protocols, resolutions/Beschlüsse, the public portal), the
> governance invariant hooks, and the module SDK. It ships exactly two module
> manifests (`core` and `governance`). Finance, files/Nextcloud, messages,
> elections, content, calendar, the mobile app, and the board are **not** part
> of the kernel — each lives in its own repository. If a guide mentions any of
> those services, it does not apply here.

---

## Default services & host ports (local dev)

The base stack brings up seven services. `docker-compose.override.yml` is
auto-loaded in local dev and exposes these on loopback only:

| Service        | Role                                      | Dev URL / port (localhost) |
|----------------|-------------------------------------------|----------------------------|
| `postgres`     | Database (Keycloak + kernel + control)    | `127.0.0.1:5433` → 5432    |
| `keycloak`     | Identity provider (OIDC/SSO)              | http://localhost:8082/auth |
| `gremion-ui`     | Admin shell (governance app)              | http://localhost:3001      |
| `gremion-public` | Read-only public portal                   | http://localhost:3002      |
| `legal`        | Static legal pages (Impressum, GDPR)      | http://localhost:8083      |
| `mailpit`      | SMTP catcher (web UI)                     | http://localhost:8026      |
| `vector`       | Log pipeline (IP pseudonymisation)        | internal only              |

The **production** profile adds `traefik` + `docker-socket-proxy`
(`docker-compose.yml`, `profiles: [production]`) and `pgbouncer` + `cloudflared`
(`docker-compose.prod.yml`). Local dev reaches services directly on the ports
above and does not run Traefik.

> `gremion-ui` and `gremion-public` are the admin shell app and the public
> portal app, respectively.

---

## General diagnostics

### Check overall health

```bash
# All-in-one: container status + endpoint probes
make health

# Raw compose view
docker compose ps
docker compose logs -f            # all services
make logs SERVICE=gremion-ui        # one service
```

`make health` probes `gremion-ui` (3001), Keycloak (8082) and Legal (8083).

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
generates random secrets, mints the internal TLS CA, ensures
`docker/keycloak/realm-export.json` exists, builds images, and starts
`postgres`, `keycloak` and `gremion-ui` — then waits for `gremion-ui` to become
healthy.

### Setup aborts before starting containers

| Symptom (`[setup]` error) | Cause | Fix |
|---|---|---|
| `Docker is not installed` / `Docker Compose (v2) is not installed` | Missing/old Docker | Install Docker with the `compose` plugin |
| `openssl is required to generate secrets` | `openssl` not on PATH | Install OpenSSL |
| `Invalid domain name` | Domain prompt got a bad value | Re-run; press Enter for `localhost`, or enter a valid hostname |
| `Some CHANGE_ME_ placeholders were not replaced` | `sed` incompatibility | Check your `sed`; on macOS the script uses BSD `sed -i ''` automatically |
| `realm-export.json is missing` | Realm export not generated | Ensure `docker/keycloak/realm-export.json` is present (the committed governance realm), or supply a `config/config.json` and re-run |

### `.env` already exists — secrets not regenerated

`setup.sh` skips secret generation if `.env` exists. To start clean:

```bash
rm .env && make setup
```

> `.env` holds the Postgres superuser password, the Keycloak admin password,
> `AUTH_SECRET`, the OIDC client secrets and the restic passphrase. `setup.sh`
> `chmod 600`s it — keep it that way and never commit it.

### `gremion-ui` health check timed out during setup

The wait loop in `setup.sh` polls for ~3 minutes. If it times out:

```bash
make logs SERVICE=gremion-ui
```

`gremion-ui` `depends_on` Postgres and Keycloak being **healthy**, so a timeout
usually means one of those is not up — check `docker compose ps` and the logs
for `postgres` / `keycloak` first.

### Seeding a starter organisation

`fresh-start` is retired; seed via the one-time endpoint after the stack is up:

```bash
curl -X POST -H "X-Seed-Token: $SEED_TOKEN" \
  http://localhost:3001/api/setup/seed
```

`SEED_TOKEN` lives in `.env`. Leave it empty to disable the endpoint. See
[LOCAL_TESTING.md](LOCAL_TESTING.md).

---

## Fresh-kernel "incomplete brand identity" 503

**Symptom:** A freshly started kernel returns **HTTP 503** for a tenant, and the
logs show:

```
[fleet-migrations] tenant <slug>: FAILED — tenant "<slug>" config has an INCOMPLETE brand identity ...
```

**This is expected for an un-provisioned tenant.** During boot the fleet runs
each active tenant's migrations and then asserts a **complete** brand identity
(`product` / `org_short` / … in the tenant's `config.json`). An un-materialized
tenant resolves these to empty values, so the fleet records that tenant
`failed` and `resolve.ts` serves a **tenant-scoped** 503 instead of rendering a
blank brand. Other tenants are unaffected.

**Fix:** complete the tenant's setup so a real `config.json` is written. Run the
seed endpoint above (which provisions the default tenant with real brand
values), or finish the Setup flow / provision the tenant
([runbooks/tenant-lifecycle.md](runbooks/tenant-lifecycle.md)). Once the tenant
config carries a complete brand identity it passes the guard and serves
normally.

---

## PostgreSQL

`postgres` runs Keycloak's DB, the kernel app DB (`gremion`), and the
**control-plane** DB (`control`, the tenant registry + fleet-migration ledger),
all created on first init by `docker/postgres/init-databases.sh`.

### Connection failed / timeout

```bash
make shell-db                          # psql -U postgres
docker compose ps postgres
docker compose logs postgres
docker compose exec postgres pg_isready -U postgres
```

| Cause | Fix |
|---|---|
| Postgres still starting | Wait for the healthcheck (`start_period` 20s); it gates `gremion-ui` |
| Wrong credentials | Check `.env`: `POSTGRES_PASSWORD`, `GREMION_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD`, `CONTROL_DB_PASSWORD` |
| Disk full | `df -h`; prune Docker (see below) |
| Network missing | `docker network inspect gremion_net` |

### Restart or rebuild

```bash
docker compose restart postgres

# Full reset — DESTROYS the database volume (gremion_pg_data)
docker compose down -v && make setup
```

### Control-plane DB missing (`503` on every request)

If `init-databases.sh` ran on a pre-existing volume the `control` DB may be
absent — `gremion-ui`'s `runControlMigrations()` then dies on boot and all
requests 503. Create it with the one-shot in
[runbooks/tenant-edge.md](runbooks/tenant-edge.md) (step 3). Note
`CONTROL_DATABASE_URL` targets `postgres:5432` **directly** and must never be
re-pointed at PgBouncer.

> Changing a DB password in `.env` requires `docker compose up -d
> --force-recreate gremion-ui postgres` — a plain `restart` does **not** reload
> `.env`.

---

## Keycloak & OIDC

The realm is **`sturaos`** with two clients: **`gremion-ui`** (the app, Auth.js)
and **`gremion-admin`** (the admin REST service account). The realm is imported
from `docker/keycloak/realm-export.json` at container start; OIDC client secrets
are substituted in from `.env` by `substitute-realm-secrets.sh`.

### Keycloak won't start

```bash
make logs SERVICE=keycloak
make shell-db -c '\l'                  # keycloak DB should exist
```

| Cause | Fix |
|---|---|
| Postgres not healthy | Keycloak `depends_on: postgres (service_healthy)` — fix Postgres first |
| Wrong DB credentials | Check `.env`: `KEYCLOAK_DB_PASSWORD` |
| Realm import fails | A required OIDC secret is empty — `substitute-realm-secrets.sh` fails fast; ensure `GREMION_UI_OIDC_CLIENT_SECRET` and `GREMION_ADMIN_OIDC_CLIENT_SECRET` are set |
| Port 8082 in use | Change the dev mapping in `docker-compose.override.yml` |

```bash
docker compose restart keycloak
```

### Can't reach the Keycloak admin console

**URL:** http://localhost:8082/auth/admin

```bash
docker compose ps keycloak
curl -I http://localhost:8082/auth/health/ready
grep '^KEYCLOAK_ADMIN' .env            # admin username + password
```

> In production the admin console + Admin REST API are IP-restricted by
> `KC_ADMIN_ALLOWLIST_CIDRS` (default `127.0.0.1/32` = nobody). Use
> `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh` or a port-forward,
> or add your bastion/VPN CIDR.

### OIDC client not found / secret mismatch

The realm export ships the clients, but their secrets come from `.env`. To
(re)apply them:

```bash
make keycloak-configure                # scripts/configure-keycloak-clients.sh
```

Verify the discovery document is reachable and well-formed:

```bash
curl -s http://localhost:8082/auth/realms/sturaos/.well-known/openid-configuration | jq .
```

### OIDC login redirect loop

Usually a redirect-URI or origin mismatch.

1. Keycloak admin → realm `sturaos` → Clients → `gremion-ui` → **Valid Redirect URIs**.
   For local dev these must cover `http://localhost:3001/*`.
2. Confirm `AUTH_KEYCLOAK_ISSUER` matches the browser-visible issuer
   (`http://localhost:8082/auth/realms/sturaos` in dev).
3. For local dev, `make dev-configure` patches `gremion-ui/.env.local` and the
   Keycloak redirect URIs for you.

> **Dev vs prod TLS:** dev runs Keycloak in `start-dev` over plain HTTP with the
> realm at `sslRequired: external` (`KC_REALM_SSL_REQUIRED=external` in the
> override). Production runs `start` with `sslRequired: all` and the
> server-to-server hop over internal TLS (`https://keycloak:8443`). A login that
> works in dev but 403s/redirects in prod is almost always missing internal-CA
> trust (`NODE_EXTRA_CA_CERTS`) or an `sslRequired` mismatch.

---

## Multi-tenancy & `x-forwarded-host`

The tenant resolver is **fail-closed**: any request that arrives **without** an
`x-forwarded-host` header gets a **404** (it cannot select a tenant). In
production a missing edge-injected `x-proxy-trust` (once
`TENANT_PROXY_SHARED_SECRET` is set) gets a **403**.

### Every request 404s locally

The dev probe must carry the tenant host. The `gremion-ui` healthcheck sends
`X-Forwarded-Host: default.${DOMAIN}` itself for exactly this reason. To test by
hand:

```bash
curl -s -H 'X-Forwarded-Host: default.localhost' http://localhost:3001/
```

### A non-default tenant 404s at the edge (production)

A real `DOMAIN` requires `DOMAIN_REGEX` (the regexp-escaped domain, e.g.
`council\.example`) for the Traefik wildcard routers. If it is empty, **every**
tenant subdomain 404s while the apex/default host still works (a silent
misconfig). `pnpm -C gremion-ui check` catches this; see
[runbooks/tenant-edge.md](runbooks/tenant-edge.md) step 0a.

### Cross-tenant data / wrong tenant resolved on a self-call

`INTERNAL_BASE_URL` must stay `http://gremion-ui:3000` (the in-container origin).
If it falls through to the public apex, the apex middleware overwrites the
per-tenant `X-Forwarded-Host` with `default.<DOMAIN>` and a second tenant's
self-call executes against the **default** tenant. Do not point it at the public
apex.

---

## Migrations

Two migration sets run at boot: **control-plane** migrations
(`gremion-ui/migrations-control/`, against the `control` DB) and per-tenant
**data-plane** migrations (`gremion-ui/migrations/`, governance-only:
`001_governance_schema`, `004_committee_elections`, `007_protocols`,
`008_public_portal`, `009_audit_log`, `010_org_units`, `043_audit_log_hash_chain`,
…).

### Migration failure on boot

```bash
make logs SERVICE=gremion-ui | grep -i 'migration\|fleet-migrations'
```

- A **control** migration failure makes every request 503 — fix the `control`
  DB connection (see PostgreSQL above) and restart `gremion-ui`.
- A **per-tenant** failure is recorded in the fleet-migration ledger and yields
  a tenant-scoped 503; the most common one for a fresh kernel is the brand-identity
  guard above.

### Realm export out of date after a config change

The realm export is generated from the enabled module manifests gated by a
vertical's `config.json`. The committed `realm-export.json` is the
governance-only base (`gremion-ui` + `gremion-admin` clients). Regenerate before
`docker compose up`:

```bash
CONFIG_PATH=/path/to/config.json make gen-realm
```

(With neither `CONFIG_PATH` nor `config/config.json`, `make gen-realm` errors
rather than no-opping.)

---

## Email (Mailpit)

By default all mail goes to the **Mailpit** catcher (`host=mailpit port=1025`,
no auth, TLS off) — nothing leaves the host. Read trapped mail at
http://localhost:8026.

```bash
docker compose ps mailpit
docker compose logs mailpit
```

If a feature reports a send failure but no mail appears in Mailpit, confirm the
producer is pointed at `mailpit:1025` (the compose default) and that Mailpit is
healthy. To switch to a real relay, see
[runbooks/email-smtp.md](runbooks/email-smtp.md) — it is a pure `.env` change.

---

## Docker Compose

### Port already in use

```bash
# Find the conflicting listener (loopback dev ports: 3001 3002 5433 8082 8083 8026)
sudo lsof -i :3001            # macOS/Linux

# Change the host-side mapping in docker-compose.override.yml, e.g. 9001:3000
```

### Docker daemon not running

```bash
# macOS:    open -a Docker
# Linux:    sudo systemctl start docker
# Windows:  ensure Docker Desktop / the WSL2 backend is started
```

### Container crashes on startup

```bash
docker compose ps                          # exit code
docker compose logs <service>
docker inspect <container-name> | grep -A 20 Health
```

### Network issues between containers

The compose network is **`gremion_net`**.

```bash
docker network inspect gremion_net
docker compose exec gremion-ui wget -qO- http://postgres:5432 2>&1 | head   # name resolution

docker compose down && docker network prune && docker compose up -d
```

### Out of disk space

```bash
df -h
docker system df

docker container prune
docker image prune -a --filter "until=240h"
docker volume prune                         # keeps named gremion_* volumes in use
```

> The kernel's named volumes are `gremion_pg_data`, `gremion_config_data`,
> `gremion_tenant_config_data`, `gremion_mailpit_data`, `gremion_traefik_logs`,
> `gremion_vector_processed_logs`. Pruning **in-use** volumes is safe; a full
> `docker compose down -v` deletes them and your data.

---

## Backup & restore

The kernel uses **restic** (`RESTIC_PASSWORD` in `.env`) via `scripts/backup.sh`
/ `scripts/restore.sh`. See [OPERATIONS.md](OPERATIONS.md) for the full routine.

```bash
# Diagnose a failing backup
bash -x scripts/backup.sh

# A primary cause is a missing/empty RESTIC_PASSWORD or rclone backend config
grep -E '^(RESTIC_PASSWORD|RCLONE_)' .env
```

---

## Getting help

### Collect a diagnostic bundle

```bash
{
  echo "=== System ==="; uname -a
  echo "=== Docker ==="; docker --version; docker compose version
  echo "=== Containers ==="; docker compose ps
  echo "=== Health ==="; make health
  echo "=== Logs (last 100) ==="; docker compose logs --tail=100
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
