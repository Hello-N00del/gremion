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

The stack is two kinds of compose project, the **state** project (databases,
Keycloak, NATS, legal, vector and, in production, the edge) and one **app** project
per colour (`gremion-ui`, `gremion-public`, `control-panel`, `kernel-api`, the
enabled leaf services and the `migrate` / `tenant-create` one-shots). The service
tables, images and compose profiles are in
[deployment.md](deployment.md#what-gets-deployed); the placement and limits are in
[ops/pooled-stack-layout.md](ops/pooled-stack-layout.md).

**Local dev.** `make up` runs both projects with `STACK=dev` (state project
`dev-state`, app project `dev-app-blue`), so a bare `docker compose` in the
repository addresses neither. This guide writes the two command prefixes once:

```bash
DS="env STACK=dev IMAGE_TAG=dev docker compose -p dev-state"
DA="env STACK=dev COLOUR=blue IMAGE_TAG=dev docker compose -f docker-compose.app.yml -f docker-compose.app.dev.yml -p dev-app-blue"
```

`$DS` is the Makefile's `DEV_STATE` and `$DA` its `DEV_APP`; `make ps`,
`make logs`, `make shell-db`, `make shell-kc`, `make health` and `make rebuild`
already use them. **On a distribution host** every command is
`docker compose --env-file /opt/gremion/etc/env/<project>.env <verb>` run from the
release tree, and the operating procedures are
[ops/runbook/](ops/runbook/README.md).

PostgreSQL 18 (`postgres:18-alpine`) hosts **three databases** from the init
script, created once by `docker/postgres/init-databases.sh` on first init
(mirrored in `k8s/base/postgres/configmap.yaml` for Kubernetes):

| Database | Owner | Contents | Impact if lost |
|----------|-------|----------|----------------|
| `keycloak` | `keycloak` | User accounts, sessions, OIDC config, realm | All users locked out |
| `gremion` | `gremion` | Governance kernel data in the pre-pooled layout — committees, members, org-unit tree, protocols, resolutions/Beschlüsse, the hash-chained audit log (INV-1); a customer's own kernel database is `t_<tenant id hex>__kernel` | Admin shell + portal data unavailable |
| `control` | `control` | Control-plane registry — tenant registry + fleet-migration ledger (`gremion-ui/migrations-control/`) | Tenant resolution fails; every request 503s |

Besides these, the same server holds `gremion_platform` (the platform schema,
created by `gremion-tenant init`) and every customer's kernel database. Each
enabled module has its own PostgreSQL server (`<id>-postgres`) and the governance
databases live on `governance-postgres`. A read-only login role
`gremion_public_reader` is also created by the init script (used by
`gremion-public`); it is granted SELECT on app tables by migration 0058.

---

## Runbooks

Task-specific operator runbooks live under [`docs/runbooks/`](runbooks/) and
[`docs/ops/`](ops/):

| Runbook | Purpose |
|---------|---------|
| [runbooks/email-smtp.md](runbooks/email-smtp.md) | Outgoing email — the Mailpit staging catcher + how to switch to a real SMTP relay for production |
| [runbooks/tenant-edge.md](runbooks/tenant-edge.md) | Tenant edge routing (whole-host resolution, per-host Traefik routers, control-DB bootstrap) |
| [runbooks/tenant-lifecycle.md](runbooks/tenant-lifecycle.md) | Provisioning, suspending, and deleting tenants |
| [runbooks/pgbouncer.md](runbooks/pgbouncer.md) | PgBouncer transaction-pooling front (production overlay) — deploy / verify / rollback |
| [runbooks/dead-letter.md](runbooks/dead-letter.md) | Dead letters: find, replay, requeue, rebuild after a JetStream loss |
| [ops/runbook/README.md](ops/runbook/README.md) | The four-procedure operations runbook: install, upgrade, backup and restore (supersedes ops/restore-runbook.md) |
| [ops/host-tooling.md](ops/host-tooling.md) | The `gremion-*` host programs and the `/opt/gremion` layout |
| [ops/setup.md](ops/setup.md) | First-time setup |

---

## Backup & Restore

### What is backed up

The kernel scripts below cover the three init-script databases — `keycloak`,
`gremion`, and `control` — plus, for tenant-scoped backups, each tenant's
Keycloak realm export. The Keycloak DB holds all accounts and sessions; the
`gremion` DB holds the kernel-level governance data and the audit log; the
`control` DB holds the tenant registry and fleet-migration ledger (without it the
stack cannot resolve tenants and every request 503s).

**On a distribution host the whole-system backup is `gremion-backup`**
(`infra/host/bin/gremion-backup`, run by `gremion-backup.timer`), which enumerates
the artefact set from the running system: every PostgreSQL server of the state
project (listed in `BACKUP_POSTGRES_SERVICES`; a running server missing from the
list refuses the run), the state volumes and `/opt/gremion/etc` without the
per-tenant backup keys, into one restic snapshot that it mirrors off-site and
reads back. It runs this repository's `scripts/backup.sh` for the kernel zone
(`keycloak`, `gremion`, `control`). The pilot posture is "installed, verified
once, then off": see [ops/runbook/backup.md](ops/runbook/backup.md) and
[ops/runbook/restore.md](ops/runbook/restore.md).

### Kernel backup (`scripts/backup.sh`)

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
`RCLONE_BUCKET`, `RCLONE_REMOTE_PATH` (`gremion-restic`), `BACKUP_TAG` (`gremion`),
`RESTIC_CHECK_SUBSET` (`10%`). The remote (Phase 4) is **skipped** when
`RCLONE_BUCKET` is unset, so a local-only repo works out of the box. rclone
credentials follow rclone's `RCLONE_CONFIG_<REMOTE>_<KEY>` convention
(e.g. `RCLONE_CONFIG_BACKUP_TYPE=s3`, `RCLONE_CONFIG_BACKUP_ACCESS_KEY_ID=…`).

> `.env.example` ships restic/rclone settings under the **Backup** section:
> `RESTIC_PASSWORD`, `RCLONE_BACKEND_TYPE`, `RCLONE_ENDPOINT`,
> `RCLONE_ACCESS_KEY_ID`, `RCLONE_SECRET_ACCESS_KEY`, `RCLONE_BUCKET`. The host
> template `state.env` carries `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`,
> `RCLONE_REMOTE`, `RCLONE_BUCKET`, `RCLONE_REMOTE_PATH` and the
> `RCLONE_CONFIG_BACKUP_*` keys instead.

**Recommended:** daily automated backups. On a host the schedule is
`gremion-backup.timer` (`infra/host/templates/systemd/`), installed disabled for the
pilot posture and enabled with `systemctl enable --now gremion-backup.timer`
([ops/runbook/backup.md](ops/runbook/backup.md), "Turning it back on"). A
standalone checkout can schedule the kernel script with cron:

```bash
crontab -e
# Run the backup pipeline at 02:00 daily:
0 2 * * * cd /path/to/gremion && ./scripts/backup.sh > /var/log/gremion-backup.log 2>&1
```

The script runs `docker compose exec -T postgres` from the repository, so it needs
a compose project that resolves to the running state project (on a host,
`gremion-backup` provides it).

### Per-tenant backup (`scripts/tenant-backup.sh`)

For multi-tenant deployments, `scripts/tenant-backup.sh <slug>` produces a
**silo-isolated** bundle for exactly one tenant, each artifact encrypted under
that tenant's own backup key (registry `backup_key_ref`) and written under its
`residency_zone`:

```bash
./scripts/tenant-backup.sh acme
# artifacts: <slug>.dump.age (pg_dump -Fc), realm.json.age (KC partial-export)
# layout:    backups/tenants/<zone>/<slug>/<YYYYmmdd-HHMMSS-pid>/  (one generation per run)
```

Each run is published atomically as its own dated generation (a failed run leaves
earlier generations untouched); `.last-backup` names the newest. Retention
(`TENANT_BACKUP_RETENTION_DAYS`) never prunes the newest
`TENANT_BACKUP_KEEP_GENERATIONS` (default 2).

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

The current restore procedures (the provider host backup, the platform restore
into a non-production stack, the reboot measurement) are in
[ops/runbook/restore.md](ops/runbook/restore.md); the older walkthrough in
[ops/restore-runbook.md](ops/restore-runbook.md) is superseded and kept as a
historical reference.

### Backup retention

restic enforces retention with `restic forget --keep-within
<BACKUP_LOCAL_RETENTION_DAYS>d --prune` (default 30 days) locally; the remote is
a mirror via `rclone sync`. Per-tenant bundles are pruned by
`TENANT_BACKUP_RETENTION_DAYS` (default 30).

---

## Monitoring & Logs

### Container logs (Docker Compose)

```bash
# All services of both projects, or one service
make logs
make logs SERVICE=gremion-ui          # app project: gremion-ui, gremion-public, migrate, tenant-create
make logs SERVICE=keycloak            # any other service: the state project
make logs SERVICE=postgres

# Last 100 lines / since 5 minutes ago / with timestamps (state project; use $DA for the app colour)
$DS logs -n 100 keycloak
$DS logs --since 5m keycloak
$DA logs -t gremion-ui
```

(`$DS` and `$DA` are defined under [Services & Databases](#services--databases).)

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
stream to `vector-processed-logs` (`/logs/processed/security.log`); both volumes
are project-scoped (`${STACK}-state_traefik-logs`,
`${STACK}-state_vector-processed-logs`). Retention is
driven by `LOG_ACCESS_RETENTION_SECONDS` (passed in as `LOG_RETENTION_SECONDS`),
with the policy documented in [docs/log-retention-policy.md](log-retention-policy.md).
GDPR-safe defaults and hard caps live in `.env.example`:

| Variable | Default | Hard cap |
|----------|---------|----------|
| `LOG_ACCESS_RETENTION_SECONDS` | 14 days | 29 days |
| `LOG_APP_RETENTION_SECONDS` | 28 days | 29 days |
| `LOG_SECURITY_RETENTION_SECONDS` | 27 days | 29 days |
| `LOG_SECURITY_NOPII_RETENTION_SECONDS` | 27 days | 30 days |

Operator ceiling 30 d [D R29-I6]: these are the defaults and caps of the gremion-ui
retention tiers (`gremion-ui/src/lib/retention-tiers.ts`); only
`LOG_ACCESS_RETENTION_SECONDS` is read by compose, the other three document the
tier defaults, and the application tiers without a purge consumer change with
TASK-033. The edge files, Traefik's own log (`/logs/traefik/traefik.log`, read it
through the vector container) and Keycloak's event store already obey the ceiling;
see the "Upper bound" section of the policy.

```bash
make logs SERVICE=vector                  # pipeline diagnostics
$DS exec vector ls -lh /logs/processed/   # processed output
```

The pseudonymisation key is rotated with
[`scripts/rotate-ipcrypt-key.sh`](../scripts/rotate-ipcrypt-key.sh).

### Container health

```bash
# Docker Compose (both projects)
make ps

# Shows health status, e.g.:
# NAMES                       STATUS
# dev-state-postgres-1        Up 2 days (healthy)
# dev-state-keycloak-1        Up 2 days (healthy)
# dev-app-blue-gremion-ui-1   Up 2 days (healthy)
```

Health checks are defined per service in `docker-compose.yml` and
`docker-compose.app.yml`. The `gremion-ui` and `control-panel` probes call
`/healthz`, which is exempt from tenant resolution and answers `200` as soon as
the process listens, even while it is still booting; `/api/health` is the boot
probe (`200` only once boot completed), see
[deployment-architecture.md](deployment-architecture.md#healthz-and-the-boot-and-resolve-exemption).

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
curl http://localhost:8082/auth/realms/<realm>/.well-known/openid-configuration
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
# Vacuum (reclaim space, refresh stats); add -d gremion_platform and each
# customer's t_<hex>__kernel database on a pooled stack
$DS exec postgres vacuumdb -U postgres -d gremion
$DS exec postgres vacuumdb -U postgres -d keycloak
$DS exec postgres vacuumdb -U postgres -d control

# Reindex
$DS exec postgres reindexdb -U postgres -d gremion
$DS exec postgres reindexdb -U postgres -d keycloak

# Kubernetes
kubectl exec -n gremion-system <postgres-pod> -- vacuumdb -U postgres -d gremion
```

### Keycloak realm export

Back up a tenant's realm configuration (clients, groups, roles) as JSON.
`<realm>` is the tenant's realm name (the slug); a per-tenant realm backup is also
part of `scripts/tenant-backup.sh`. Do not copy the export over
`docker/keycloak/realm-export.json`: that file is the gitignored generator output
below, not a backup:

```bash
$DS exec keycloak /opt/keycloak/bin/kc.sh export \
  --realm "<realm>" \
  --file /tmp/realm-export.json

$DS cp keycloak:/tmp/realm-export.json \
  backups/realm-<realm>.json
```

> B-01: **no realm is imported at boot.** `docker/keycloak/realm-export.json` is
> a gitignored GENERATOR OUTPUT: `make gen-realm` writes the module-composed
> realm template there (it needs `CONFIG_PATH` or `./config/config.json`), and
> nothing mounts or reads it at container start. The realm a tenant actually
> gets is composed from `docker/keycloak/realm-export.base.json` by
> `buildTenantRealmDoc` at tenant-create time. Disabled modules contribute no
> groups or roles either way.

### Update services

Gremion builds its first-party images from this repository, all named
`ghcr.io/hello-n00del/gremion-<service>`: `gremion-ui`, `gremion-public`,
`gremion-control-panel`, `gremion-migrate`, `gremion-kernel-api`,
`gremion-calendar`, `gremion-content`, `gremion-newsletter`, `gremion-legal`,
`gremion-vector`, `gremion-fallback`, `gremion-synapse`, `gremion-nextcloud`,
`gremion-collabora` and `gremion-element-call`. Each carries a `build:` section in
`docker-compose.yml`, `docker-compose.app.yml` or `docker-compose.prod.yml`;
`.github/workflows/release-images.yml` builds and pushes them for a release.
Pulled: Keycloak, Postgres, NATS, Mailpit, PgBouncer, Traefik, the Docker-socket
proxy, Redis, LiveKit. A host never builds: `gremion-deploy` pulls the digests
pinned by the release layers ([ops/runbook/upgrade.md](ops/runbook/upgrade.md)).
The commands below are the local-stack forms.

Vector is **not** pulled. `docker/vector/Dockerfile` compiles `libipcrypt2`
into the image for the `ipcrypt-nd` IP pseudonymisation (see `NOTICE`), so a
`docker compose pull vector` gets you nothing — rebuild it like the rest.

Write the registry host out in full whenever you name one of these images. An
unqualified `gremion/<service>` resolves to `docker.io/<that same string>`, a
Docker Hub namespace this project does not own.

```bash
# gremion-ui (admin shell) — control-plane and fleet migrations run on startup
$DA build gremion-ui
$DA up -d gremion-ui
make logs SERVICE=gremion-ui               # watch migrations apply

# Log pipeline (built here — see above)
$DS build vector
$DS up -d vector

# Keycloak
$DS pull keycloak
$DS up -d keycloak
curl http://localhost:8082/auth/realms/<tenant realm>   # verify the realm still loads

# Legal pages (picks up legal/legal.env)
make update-legal                        # Compose
make update-legal-k8s                    # Kubernetes (re-applies the Secret first)
```

> **`.env` changes need a recreate, not a restart.** `docker compose restart`
> does **not** reload `.env` (or a host's env file). Use
> `… up -d --force-recreate <service>` (or `make rebuild` for the whole local
> stack) and verify the value inside the container before declaring it live.

### Seeding

`make fresh-start` is retired. After `make up`, seed through the one-time endpoint
with a host that is bound to a provisioned tenant (the seed runs in that tenant's
context; there is no first-run setup wizard and no default tenant):

```bash
curl -X POST -H "X-Seed-Token: $SEED_TOKEN" -H "X-Forwarded-Host: <bound host>" \
  http://localhost:3001/api/setup/seed
```

`SEED_TOKEN` gates the endpoint; leave it empty in `.env` to disable seeding.

---

## Troubleshooting

### A service won't start

```bash
make logs SERVICE=<service>
$DS config | head -50                    # surface compose syntax errors ($DA for the app project)
$DS up <service>                         # start in the foreground for verbose output
```

### Database connection issues

```bash
make ps

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
always reached **directly** at `postgres-<stack>:5432` — never through the
production PgBouncer. A non-transient boot failure makes the container exit and
restart, so a wrong password shows as a rising restart count
([deployment-architecture.md](deployment-architecture.md#boot-determinism)).

### A tenant host 404s (production)

A bare Traefik 404 means no `Host(...)` router exists for that host; an app 404
logs one `tenant.host.rejected` line in the gremion-ui log whose `reason` is
`unbound` (no `tenant_domain` row), `inactive`, `forged` (Host and
X-Forwarded-Host disagreed) or `unparseable`. The apex binds no tenant and 404s
by design. See [runbooks/tenant-edge.md](runbooks/tenant-edge.md).

### Keycloak slow authentication

```bash
make shell-db
\c keycloak
SELECT COUNT(*) FROM user_entity;
SELECT COUNT(*) FROM realm;

$DS exec postgres vacuumdb  -U postgres -d keycloak
$DS exec postgres reindexdb -U postgres -d keycloak
$DS restart keycloak
```

### OIDC / SSO authentication failures

```bash
# Confirm OIDC discovery is served
curl http://localhost:8082/auth/realms/<tenant realm>/.well-known/openid-configuration

# In the Keycloak admin console (Clients → gremion-ui):
#  - Valid Redirect URIs match the tenant's host
#  - the client secret matches AUTH_KEYCLOAK_SECRET in .env
```

Every realm the provisioner composes is pinned to `sslRequired=all`, and in
production `gremion-ui` reaches Keycloak over internal TLS at
`https://keycloak:8443` (trust anchor injected via `NODE_EXTRA_CA_CERTS`). The
dev layers (`docker-compose.override.yml`, `docker-compose.app.dev.yml`) drop the
transport back to plain HTTP on `:8080`. A mismatch between these and the realm's
`sslRequired` setting is a common cause of login failures
([TROUBLESHOOTING.md](TROUBLESHOOTING.md#keycloak--oidc)).

### Out of disk space

```bash
df -h
docker volume ls
docker image prune -a --filter "until=240h"
docker volume prune
# Old restic snapshots are pruned by the backup pipeline; force a prune with:
./scripts/backup.sh
```

`docker volume prune` removes only volumes no container references; the stack's
named volumes are project-scoped (`${STACK}-state_pg-data` and the like), and the
external ones (`${STACK}_traefik_acme`, `${STACK}_config_data`,
`${STACK}_tenant_config_data`, `${STACK}_nats_accounts`) are created outside
compose so a `down -v` never takes them. On a host, `docker system prune --volumes`
is not a cleanup step.

---

## Performance Tuning

### Container resource limits (Docker Compose)

Every container declares `deploy.resources.limits` (sizes `s`, `m`, `l` and
Keycloak's own, see [ops/pooled-stack-layout.md](ops/pooled-stack-layout.md)),
which compose applies outside swarm. A limit is changed in the compose file (the
anchors at the top of `docker-compose.yml` and `docker-compose.app.yml`), not by
a local override, and `make lint-pooled-stack` fails when a service loses its
limits. `gremion-ui`, for example, is `l` (1G, 1 CPU).

### Kubernetes resource requests/limits

Configured in `k8s/base/*/deployment.yaml`; customise per environment in
`k8s/overlays/production/`.

### Database connection pooling

`gremion-ui` keeps a draining LRU of per-tenant pools; the data plane goes through
**PgBouncer** (transaction pooling, `pgbouncer-<stack>:6432`) on a host, while dev/CI
keep the direct `postgres-<stack>:5432` URL. The control plane is deliberately
**never** routed through PgBouncer — it is the direct term in the connection
budget (`max_connections=100`, pinned in `docker-compose.prod.yml`).
Deploy/verify/rollback: [runbooks/pgbouncer.md](runbooks/pgbouncer.md).

### PostgreSQL tuning (Kubernetes)

Provide a ConfigMap (`k8s/base/postgres/`) for `postgresql.conf` overrides such
as `shared_buffers`, `effective_cache_size`, `work_mem`, and `max_wal_size`,
sized to the host.

---

## Disaster Recovery

### Full system backup

On a distribution host the full-system backup and its restore are
`gremion-backup` and `gremion-restore-into`, and the procedures are
[ops/runbook/backup.md](ops/runbook/backup.md) and
[ops/runbook/restore.md](ops/runbook/restore.md). For a local stack:

```bash
# 1. Back up secrets — CAREFULLY, contains live credentials
cp .env backups/.env.backup

# 2. Export each tenant realm (see "Keycloak realm export")
$DS exec keycloak /opt/keycloak/bin/kc.sh export \
  --realm "<realm>" --file /tmp/realm-export.json
$DS cp keycloak:/tmp/realm-export.json backups/

# 3. Back up the kernel databases (restic + rclone), then every tenant
./scripts/backup.sh
./scripts/tenant-backup.sh <slug>

# 4. Verify the restic repository
./scripts/restore.sh --list-snapshots
```

### Restore a full system

```bash
# Stop the app colour, keep the state project (postgres must be healthy before restore)
$DA down
$DS up -d postgres

# Restore each database from the latest snapshot
./scripts/restore.sh --snapshot latest keycloak
./scripts/restore.sh --snapshot latest gremion
./scripts/restore.sh --snapshot latest control

# Re-import a tenant realm if needed
$DS cp backups/realm-export.json keycloak:/tmp/
$DS exec keycloak /opt/keycloak/bin/kc.sh import \
  --realm "<realm>" --file /tmp/realm-export.json --override true

# Bring up the rest and verify
$DS up -d
$DA up -d
make ps
make health
```

The three kernel databases are what `scripts/restore.sh` restores; a pooled stack
also needs `gremion_platform`, each customer's kernel and governance database and
each module's database, which only `gremion-backup` stages
([ops/runbook/restore.md](ops/runbook/restore.md)).

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
make dev-networks
$DS up -d postgres
./scripts/restore.sh --snapshot latest keycloak
./scripts/restore.sh --snapshot latest gremion
./scripts/restore.sh --snapshot latest control
make up
```

### Disaster recovery checklist

- [ ] Daily backups run (`scripts/backup.sh`)
- [ ] restic integrity check passes (`restic check`, run by the pipeline)
- [ ] Off-site copy present (rclone remote configured: `RCLONE_BUCKET` set)
- [ ] `.env` backed up securely (contains all secrets)
- [ ] Keycloak realm exported
- [ ] Per-tenant backups run for every active tenant (`scripts/tenant-backup.sh`)
- [ ] DNS records, `DOMAIN` and every bound tenant host documented
- [ ] TLS certificates renewing (`gremion-verify`'s certificate check, `CERT_MIN_DAYS`)
- [ ] Restore drill performed (test-restore monthly)

---

## Regular Maintenance Schedule

| Task | Frequency | Command |
|------|-----------|---------|
| Back up all databases | Daily | `./scripts/backup.sh` |
| Per-tenant backups | Daily | `./scripts/tenant-backup.sh <slug>` |
| Verify a restore | Monthly | restore latest snapshot into a scratch DB |
| PostgreSQL vacuum | Weekly | `vacuumdb -d gremion` / `keycloak` / `control` |
| Keycloak realm export | Monthly | `kc.sh export --realm "<realm>"` |
| Rotate the log pseudonymisation key | Per policy | `scripts/rotate-ipcrypt-key.sh` |
| Security image updates | As released | a new release through `gremion-deploy` (or rebuild the local images) |
| Capacity planning | Monthly | check disk, CPU, memory |
| Disaster-recovery drill | Quarterly | practice a full restore |

---

## Support & Escalation

- **Logs:** `make logs` (Compose) or `kubectl logs` (K8s); processed
  access logs in the `vector-processed-logs` volume
- **Configuration:** `.env` (keep secure); see [docs/ENVIRONMENT.md](ENVIRONMENT.md)
- **Database shell:** `make shell-db` (`\c gremion` / `keycloak` / `control`)
- **Service health:** `make health` / `make ps` / `kubectl get pods`
- **Upstream:**
  - Keycloak: <https://github.com/keycloak/keycloak/issues>
  - PostgreSQL: <https://www.postgresql.org/docs/>
