# Operations Guide

Operating, maintaining, and recovering the Gremion governance kernel in
production and development environments.

Gremion is the open-core governance kernel carved out of the StuRaOS monorepo.
The admin shell app is **gremion-ui** and the read-only public portal is
**gremion-public**. For the kernel's vision,
architecture, and governance charter, see
[docs/about-gremion.md](about-gremion.md). This guide is the operational/technical
layer: how to run, back up, monitor, and recover a deployment.

## Table of Contents

- [Services & Databases](#services--databases)
- [Runbooks](#runbooks)
- [Backup & Restore](#backup--restore)
- [Monitoring & Logs](#monitoring--logs)
- [Maintenance Tasks](#maintenance-tasks)
- [Troubleshooting](#troubleshooting)
- [Performance Tuning](#performance-tuning)
- [Disaster Recovery](#disaster-recovery)
- [Regular Maintenance Schedule](#regular-maintenance-schedule)

---

## Services & Databases

The governance-only stack runs **seven default services** (`docker-compose.yml`):

| Service | Purpose |
|---------|---------|
| `postgres` | PostgreSQL 16 — backs Keycloak, the governance kernel, and the control plane |
| `keycloak` | Identity provider (OIDC/SSO), realm `sturaos` |
| `gremion-ui` | SvelteKit admin shell — governance domain (committees, members, org-unit tree, protocols, resolutions) |
| `gremion-public` | Read-only public portal (no auth, no sessions) served at `public.${DOMAIN}` |
| `legal` | Static legal/Impressum pages (nginx) |
| `vector` | Log pipeline — tails Traefik access logs, pseudonymises IPs, enforces retention |
| `mailpit` | SMTP catcher for staging/local dev |

The **production profile** adds the edge and pooling tier
(`docker compose -f docker-compose.yml -f docker-compose.prod.yml`):
`traefik` + `docker-socket-proxy` (in `docker-compose.yml`, `profiles: [production]`)
and `pgbouncer`, `cloudflared`, `fallback` (in `docker-compose.prod.yml`).

PostgreSQL hosts **three databases**, created once by
`docker/postgres/init-databases.sh` on first init (mirrored in
`k8s/base/postgres/configmap.yaml` for Kubernetes):

| Database | Owner | Contents | Impact if lost |
|----------|-------|----------|----------------|
| `keycloak` | `keycloak` | User accounts, sessions, OIDC config, realm | All users locked out |
| `gremion` | `gremion` | Governance kernel data — committees, members, org-unit tree, protocols, resolutions/Beschlüsse, the hash-chained audit log (INV-1), tenant config | Admin shell + portal data unavailable |
| `control` | `control` | Control-plane registry — tenant registry + fleet-migration ledger (`gremion-ui/migrations-control/`) | Tenant resolution fails; every request 503s |

A read-only login role `gremion_public_reader` is also created (used by
`gremion-public`); it is granted SELECT on app tables by migration 008.

---

## Runbooks

Task-specific operator runbooks live under [`docs/runbooks/`](runbooks/) and
[`docs/ops/`](ops/):

| Runbook | Purpose |
|---------|---------|
| [runbooks/email-smtp.md](runbooks/email-smtp.md) | Outgoing email — the Mailpit staging catcher + how to switch to a real SMTP relay for production |
| [runbooks/tenant-edge.md](runbooks/tenant-edge.md) | Tenant edge routing (`DOMAIN_REGEX`, wildcard Traefik routers, control-DB bootstrap) |
| [runbooks/tenant-lifecycle.md](runbooks/tenant-lifecycle.md) | Provisioning, suspending, and deleting tenants |
| [runbooks/pgbouncer.md](runbooks/pgbouncer.md) | PgBouncer transaction-pooling front (production overlay) — deploy / verify / rollback |
| [ops/restore-runbook.md](ops/restore-runbook.md) | Step-by-step disaster restore from a restic snapshot |
| [ops/setup.md](ops/setup.md) | First-time setup |

---

## Backup & Restore

### What is backed up

The backup system covers the three PostgreSQL databases — `keycloak`, `gremion`,
and `control` — plus, for tenant-scoped backups, each tenant's Keycloak realm
export. The Keycloak DB holds all accounts and sessions; the `gremion` DB holds all
governance data and the audit log; the `control` DB holds the tenant registry and
fleet-migration ledger (without it the stack cannot resolve tenants and every
request 503s).

### Global backup (`scripts/backup.sh`)

`scripts/backup.sh` is a **restic + rclone** pipeline (not a plain `pg_dump`
dropper):

1. `pg_dump` every database into `$BACKUP_DIR/current/`
2. `restic backup` → local **encrypted** repository
3. `restic forget --prune` → local retention
4. `rclone sync` → remote storage (provider-agnostic: S3 / SFTP / B2)
5. `restic check --read-data-subset=N%` → integrity verification
6. write step durations to `$BACKUP_DIR/logs/backup-<date>.json`

```bash
# Manual backup
./scripts/backup.sh

# Read-verify a larger fraction of the repo this run
RESTIC_CHECK_SUBSET=5% ./scripts/backup.sh
```

**Required environment** (from `.env` or a K8s Secret):

| Variable | Purpose |
|----------|---------|
| `POSTGRES_USER` | PostgreSQL superuser (used for `pg_dump`) |
| `RESTIC_PASSWORD` (or `RESTIC_PASSWORD_FILE`) | restic repository encryption passphrase |

**Optional** (defaults in parentheses):
`BACKUP_DIR` (`./backups`), `RESTIC_REPOSITORY` (`$BACKUP_DIR/repo`),
`BACKUP_LOCAL_RETENTION_DAYS` (`30`), `RCLONE_REMOTE` (`backup`),
`RCLONE_BUCKET`, `RCLONE_REMOTE_PATH` (`stura-restic`),
`RESTIC_CHECK_SUBSET` (`10%`). The remote (Phase 4) is **skipped** when
`RCLONE_BUCKET` is unset, so a local-only repo works out of the box. rclone
credentials follow rclone's `RCLONE_CONFIG_<REMOTE>_<KEY>` convention
(e.g. `RCLONE_CONFIG_BACKUP_TYPE=s3`, `RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID=…`).

> `.env.example` ships restic/rclone settings under the **Backup** section:
> `RESTIC_PASSWORD`, `RCLONE_BACKEND_TYPE`, `RCLONE_ENDPOINT`,
> `RCLONE_ACCESS_KEY_ID`, `RCLONE_SECRET_ACCESS_KEY`, `RCLONE_BUCKET`.

**Recommended:** daily automated backups. Schedule with cron:

```bash
crontab -e
# Run the backup pipeline at 02:00 daily:
0 2 * * * cd /path/to/gremion && ./scripts/backup.sh > /var/log/gremion-backup.log 2>&1
```

### Per-tenant backup (`scripts/tenant-backup.sh`)

For multi-tenant deployments, `scripts/tenant-backup.sh <slug>` produces a
**silo-isolated** bundle for exactly one tenant, each artifact encrypted under
that tenant's own backup key (registry `backup_key_ref`) and written under its
`residency_zone`:

```bash
./scripts/tenant-backup.sh acme
# artifacts: <slug>.dump.age (pg_dump -Fc), realm.json.age (KC partial-export)
```

Encryption is `openssl enc -aes-256-cbc -pbkdf2`; the realm is exported via the
Keycloak Admin API `partial-export` endpoint. Because each tenant's key is
separate, a later tenant delete can crypto-shred that one key and instantly
invalidate only that tenant's backups. Requires `CONTROL_DATABASE_URL`,
`POSTGRES_USER`, `KEYCLOAK_ADMIN`, and `KEYCLOAK_ADMIN_PASSWORD`.

### Restore (`scripts/restore.sh`)

> **WARNING:** Restore DROPS and recreates the target database. Always take a
> fresh backup first (unless the running data is what is corrupted).

```bash
# List available restic snapshots
./scripts/restore.sh --list-snapshots

# Restore one database from a restic snapshot
./scripts/restore.sh --snapshot latest gremion
./scripts/restore.sh --snapshot <id> keycloak
./scripts/restore.sh --snapshot <id> control

# Or restore directly from a gzipped dump file
./scripts/restore.sh keycloak backups/current/keycloak.sql.gz
```

For the governance kernel the restore targets are **`keycloak`, `gremion`, and
`control`**. The restore process:

1. (snapshot mode) restores the snapshot to a temp dir and locates the dump
2. prompts for confirmation (type `yes` to proceed)
3. terminates connections, drops and recreates the database with the correct owner
4. restores from the gzipped SQL dump

A full incident walkthrough lives in
[docs/ops/restore-runbook.md](ops/restore-runbook.md).

### Backup retention

restic enforces retention with `restic forget --keep-within
<BACKUP_LOCAL_RETENTION_DAYS>d --prune` (default 30 days) locally; the remote is
a mirror via `rclone sync`. Per-tenant bundles are pruned by
`TENANT_BACKUP_RETENTION_DAYS` (default 30).

---

## Monitoring & Logs

### Container logs (Docker Compose)

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f gremion-ui
docker compose logs -f keycloak
docker compose logs -f postgres

# Last 100 lines / since 5 minutes ago / with timestamps
docker compose logs -n 100 gremion-ui
docker compose logs --since 5m keycloak
docker compose logs -t gremion-ui

# Or via the Makefile (pass SERVICE=…)
make logs SERVICE=gremion-ui
```

### Container logs (Kubernetes)

```bash
kubectl logs -n gremion-system -l app=gremion-ui -f
kubectl logs -n gremion-system <pod-name> --previous   # crashed pod's prior logs
kubectl logs -n gremion-system <pod-name> -f --timestamps=true
```

### The Vector log pipeline

In production, Traefik writes JSON access logs to the `traefik-logs` volume and
the **`vector`** service tails them, pseudonymises client IPs (ipcrypt-nd, key in
the `ipcrypt_key` secret), and enforces retention before writing the processed
stream to `vector-processed-logs` (`/logs/processed/security.log`). Retention is
driven by `LOG_ACCESS_RETENTION_SECONDS` (passed in as `LOG_RETENTION_SECONDS`),
with the policy documented in [docs/log-retention-policy.md](log-retention-policy.md).
GDPR-safe defaults and hard caps live in `.env.example`:

| Variable | Default | Hard cap |
|----------|---------|----------|
| `LOG_ACCESS_RETENTION_SECONDS` | 14 days | 30 days |
| `LOG_APP_RETENTION_SECONDS` | 30 days | 90 days |
| `LOG_SECURITY_RETENTION_SECONDS` | 90 days | 180 days |
| `LOG_SECURITY_NOPII_RETENTION_SECONDS` | 90 days | 365 days |

```bash
docker compose logs -f vector             # pipeline diagnostics
docker compose exec vector ls -lh /logs/processed/   # processed output
```

The pseudonymisation key is rotated with
[`scripts/rotate-ipcrypt-key.sh`](../scripts/rotate-ipcrypt-key.sh).

### Container health

```bash
# Docker Compose
docker compose ps        # or: make ps

# Shows health status, e.g.:
# NAMES        STATUS
# postgres     Up 2 days (healthy)
# keycloak     Up 2 days (healthy)
# gremion-ui     Up 2 days (healthy)
```

Health checks are defined per service in `docker-compose.yml`. The `gremion-ui`
probe deliberately sends an `X-Forwarded-Host: default.${DOMAIN}` header (and the
proxy-trust header when set) because the fail-closed tenant resolver 404s any
request lacking a forwarded host — a bare probe would report a false negative.

### Endpoint checks

`make health` probes the core endpoints:

```bash
make health
# === Endpoint Checks ===
#   gremion-ui  (3001): OK
#   Keycloak  (8082): OK
#   Legal     (8083): OK
```

Manually:

```bash
curl -sf http://localhost:3001/                       # gremion-ui (admin shell)
curl -I  http://localhost:8082/auth/health/ready      # Keycloak readiness
curl -sf http://localhost:8083/impressum              # Legal pages
# Verify the realm is loaded:
curl http://localhost:8082/auth/realms/sturaos/.well-known/openid-configuration
```

### Monitor Kubernetes resources

```bash
kubectl get pods -n gremion-system
kubectl describe pod -n gremion-system <pod-name>
kubectl top pod -n gremion-system
kubectl get events -n gremion-system --sort-by='.lastTimestamp'
```

---

## Maintenance Tasks

### Database maintenance

The kernel's three databases are maintained with standard PostgreSQL tooling.

```bash
# Vacuum (reclaim space, refresh stats)
docker compose exec postgres vacuumdb -U postgres -d gremion
docker compose exec postgres vacuumdb -U postgres -d keycloak
docker compose exec postgres vacuumdb -U postgres -d control

# Reindex
docker compose exec postgres reindexdb -U postgres -d gremion
docker compose exec postgres reindexdb -U postgres -d keycloak

# Kubernetes
kubectl exec -n gremion-system <postgres-pod> -- vacuumdb -U postgres -d gremion
```

### Keycloak realm export

Back up the realm configuration (clients, groups, roles) as JSON. The realm name
is **`sturaos`**:

```bash
docker compose exec keycloak /opt/keycloak/bin/kc.sh export \
  --realm sturaos \
  --file /tmp/realm-export.json

docker compose cp keycloak:/tmp/realm-export.json \
  docker/keycloak/realm-export.json
```

> The realm import template at `docker/keycloak/realm-export.json` is generated
> from the module manifests and the target vertical's config by `make gen-realm`
> (it needs `CONFIG_PATH` or `./config/config.json`). Run it **before**
> `docker compose up` — Keycloak imports the file at boot. Disabled modules
> contribute no groups or roles.

### Update services

Gremion builds **five** first-party images, all from this repository and all
named `ghcr.io/hello-n00del/gremion-<service>`: `gremion-ui`, `gremion-public`,
`gremion-legal`, `gremion-vector`, and — in the production profile —
`gremion-fallback`. Each carries a `build:` section in `docker-compose.yml` or
`docker-compose.prod.yml`, and CI fails the build if one ever loses it. Pulled:
Keycloak, Postgres, Mailpit, PgBouncer, Traefik, the Docker-socket proxy, and
`cloudflared`.

Vector is **not** pulled. `docker/vector/Dockerfile` compiles `libipcrypt2`
into the image for the `ipcrypt-nd` IP pseudonymisation (see `NOTICE`), so a
`docker compose pull vector` gets you nothing — rebuild it like the rest.

Write the registry host out in full whenever you name one of these images. An
unqualified `gremion/<service>` resolves to `docker.io/<that same string>`, a
Docker Hub namespace this project does not own.

```bash
# gremion-ui (admin shell) — database migrations run automatically on startup
docker compose build gremion-ui
docker compose up -d gremion-ui
docker compose logs -f gremion-ui          # watch migrations apply

# Log pipeline (built here — see above)
docker compose build vector
docker compose up -d vector

# Keycloak
docker compose pull keycloak
docker compose up -d keycloak
curl http://localhost:8082/auth/realms/sturaos   # verify realm still loads

# Legal pages (picks up legal/legal.env)
make update-legal                        # Compose
make update-legal-k8s                    # Kubernetes (re-applies the Secret first)
```

> **`.env` changes need a recreate, not a restart.** `docker compose restart`
> does **not** reload `.env`. Use `docker compose up -d --force-recreate <service>`
> (or `make rebuild` for the whole stack) and verify the value inside the
> container before declaring it live.

### Seeding

`make fresh-start` is retired. After `make up`, seed via the one-time endpoint:

```bash
curl -X POST -H "X-Seed-Token: $SEED_TOKEN" http://localhost:3001/api/setup/seed
```

`SEED_TOKEN` gates the endpoint; leave it empty in `.env` to disable seeding.

---

## Troubleshooting

### A service won't start

```bash
docker compose logs <service>
docker compose config | head -50         # surface compose syntax errors
docker compose up <service>              # start in the foreground for verbose output
```

### Database connection issues

```bash
docker compose ps postgres

make shell-db            # psql -U postgres
\l                       # list databases — expect keycloak, gremion, control
\c gremion                 # connect to the governance kernel DB
\dt                      # list governance tables
```

### Every request returns 503

The control plane is unreachable. On boot, `gremion-ui` runs the control-plane
migrations against `CONTROL_DATABASE_URL`; if the `control` database or role is
missing, boot fails and all requests 503. On a fresh volume the database is
created by `init-databases.sh`; on an existing volume run the one-shot in
[runbooks/tenant-edge.md](runbooks/tenant-edge.md) step 3. Note `control` is
always reached **directly** at `postgres:5432` — never through the production
PgBouncer overlay.

### Tenant subdomains 404 (production)

`DOMAIN_REGEX` is unset or empty with a real `DOMAIN`. The wildcard Traefik
routers then render the dead pattern `^[a-z0-9-]+\.$`, which matches no tenant
host (the apex/default host still works and masks the misconfig). Set
`DOMAIN_REGEX` to the regexp-escaped domain (e.g. `council\.example`) before the
recreate. `pnpm -C gremion-ui check` fails the build if a real prod `DOMAIN` is set
with an empty `DOMAIN_REGEX`. See [runbooks/tenant-edge.md](runbooks/tenant-edge.md).

### Keycloak slow authentication

```bash
make shell-db
\c keycloak
SELECT COUNT(*) FROM user_entity;
SELECT COUNT(*) FROM realm;

docker compose exec postgres vacuumdb  -U postgres -d keycloak
docker compose exec postgres reindexdb -U postgres -d keycloak
docker compose restart keycloak
```

### OIDC / SSO authentication failures

```bash
# Confirm OIDC discovery is served
curl http://localhost:8082/auth/realms/sturaos/.well-known/openid-configuration

# In the Keycloak admin console (Clients → gremion-ui):
#  - Valid Redirect URIs match your domain
#  - the client secret matches AUTH_KEYCLOAK_SECRET in .env
```

In production the realm runs with `sslRequired=all` and `gremion-ui` reaches
Keycloak over internal TLS at `https://keycloak:8443` (trust anchor injected via
`NODE_EXTRA_CA_CERTS`). The dev override drops both back to plain HTTP on
`:8080`. A mismatch between these and the realm's `sslRequired` setting is a
common cause of login failures.

### Out of disk space

```bash
df -h
docker volume ls
docker image prune -a --filter "until=240h"
docker volume prune
# Old restic snapshots are pruned by the backup pipeline; force a prune with:
./scripts/backup.sh
```

---

## Performance Tuning

### Container resource limits (Docker Compose)

```yaml
gremion-ui:
  deploy:
    resources:
      limits:
        cpus: '2'
        memory: 2G
      reservations:
        cpus: '1'
        memory: 1G
```

Then `docker compose up -d`.

### Kubernetes resource requests/limits

Configured in `k8s/base/*/deployment.yaml`; customise per environment in
`k8s/overlays/production/`.

### Database connection pooling

`gremion-ui` reaches PostgreSQL through a single lazy connection-pool singleton; the
data plane goes through **PgBouncer** (transaction pooling, `pgbouncer:6432`) in
the production overlay, while dev/CI keep the direct `postgres:5432` URL. The
control plane is deliberately **never** routed through PgBouncer — it is the
direct term in the connection budget (`max_connections=100`, pinned in
`docker-compose.prod.yml`). Deploy/verify/rollback: [runbooks/pgbouncer.md](runbooks/pgbouncer.md).

### PostgreSQL tuning (Kubernetes)

Provide a ConfigMap (`k8s/base/postgres/`) for `postgresql.conf` overrides such
as `shared_buffers`, `effective_cache_size`, `work_mem`, and `max_wal_size`,
sized to the host.

---

## Disaster Recovery

### Full system backup

```bash
# 1. Back up secrets — CAREFULLY, contains live credentials
cp .env backups/.env.backup

# 2. Export the Keycloak realm
docker compose exec keycloak /opt/keycloak/bin/kc.sh export \
  --realm sturaos --file /tmp/realm-export.json
docker compose cp keycloak:/tmp/realm-export.json backups/

# 3. Back up all databases (restic + rclone)
./scripts/backup.sh

# 4. Verify the restic repository
./scripts/restore.sh --list-snapshots
```

### Restore a full system

```bash
# Stop services
docker compose down

# Bring the stack back up (postgres must be healthy before restore)
docker compose up -d postgres

# Restore each database from the latest snapshot
./scripts/restore.sh --snapshot latest keycloak
./scripts/restore.sh --snapshot latest gremion
./scripts/restore.sh --snapshot latest control

# Re-import the Keycloak realm if needed
docker compose cp backups/realm-export.json keycloak:/tmp/
docker compose exec keycloak /opt/keycloak/bin/kc.sh import \
  --realm sturaos --file /tmp/realm-export.json --override true

# Bring up the rest and verify
docker compose up -d
docker compose ps
make health
```

The detailed incident walkthrough is in
[docs/ops/restore-runbook.md](ops/restore-runbook.md).

### Move to a new server

```bash
# On the old host
./scripts/backup.sh                       # ensure a current snapshot exists
tar -czf gremion-migration.tar.gz .env    # plus restic repo or rclone remote

# Transfer
scp gremion-migration.tar.gz user@newhost:/tmp/

# On the new host
cd /path/to/gremion
tar -xzf /tmp/gremion-migration.tar.gz
docker compose up -d postgres
./scripts/restore.sh --snapshot latest keycloak
./scripts/restore.sh --snapshot latest gremion
./scripts/restore.sh --snapshot latest control
docker compose up -d
```

### Disaster recovery checklist

- [ ] Daily backups run (`scripts/backup.sh`)
- [ ] restic integrity check passes (`restic check`, run by the pipeline)
- [ ] Off-site copy present (rclone remote configured: `RCLONE_BUCKET` set)
- [ ] `.env` backed up securely (contains all secrets)
- [ ] Keycloak realm `sturaos` exported
- [ ] Per-tenant backups run for every active tenant (`scripts/tenant-backup.sh`)
- [ ] DNS records and `DOMAIN` / `DOMAIN_REGEX` documented
- [ ] TLS certificate / Cloudflare tunnel renewal verified
- [ ] Restore drill performed (test-restore monthly)

---

## Regular Maintenance Schedule

| Task | Frequency | Command |
|------|-----------|---------|
| Back up all databases | Daily | `./scripts/backup.sh` |
| Per-tenant backups | Daily | `./scripts/tenant-backup.sh <slug>` |
| Verify a restore | Monthly | restore latest snapshot into a scratch DB |
| PostgreSQL vacuum | Weekly | `vacuumdb -d gremion` / `keycloak` / `control` |
| Keycloak realm export | Monthly | `kc.sh export --realm sturaos` |
| Rotate the log pseudonymisation key | Per policy | `scripts/rotate-ipcrypt-key.sh` |
| Security image updates | As released | rebuild/pull service images |
| Capacity planning | Monthly | check disk, CPU, memory |
| Disaster-recovery drill | Quarterly | practice a full restore |

---

## Support & Escalation

- **Logs:** `docker compose logs` (Compose) or `kubectl logs` (K8s); processed
  access logs in the `vector-processed-logs` volume
- **Configuration:** `.env` (keep secure); see [docs/ENVIRONMENT.md](ENVIRONMENT.md)
- **Database shell:** `make shell-db` (`\c gremion` / `keycloak` / `control`)
- **Service health:** `make health` / `make ps` / `kubectl get pods`
- **Upstream:**
  - Keycloak: <https://github.com/keycloak/keycloak/issues>
  - PostgreSQL: <https://www.postgresql.org/docs/>
