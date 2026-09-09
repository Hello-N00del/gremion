# Restore Runbook — Gremion

**Target audience:** administrator responding to data loss or corruption of a Gremion
governance-kernel deployment.
**Prerequisites:** shell access to the host running Gremion, the `.env` file with
credentials, and the restic repository accessible (locally or via the rclone remote).

For the kernel's architecture and what the governance kernel includes, see
[About Gremion](../about-gremion.md). This runbook is the operational layer.

---

## 0. What Gets Backed Up

The governance kernel runs PostgreSQL with exactly three databases, created on first
boot by `docker/postgres/init-databases.sh`:

| Database | Role / owner | Contents |
|---|---|---|
| `keycloak` | `keycloak` | Identity provider — realms, clients, users, roles, OTP credentials |
| `gremion` | `gremion` | Governance domain (committees, members, org-unit tree, protocols, resolutions/Beschlüsse), sessions, and the hash-chained audit log (INV-1) |
| `control` | `control` | Control plane — tenant registry and the fleet-migration ledger |

`scripts/backup.sh` dumps each database and stores the dumps in an encrypted restic
repository, then optionally mirrors that repository to a remote object store via
rclone. There are no module databases in the kernel — finance, files, voting,
messaging, content, and calendar live in separate module services with their own
backups.

---

## 1. Before You Start

1. **Do not panic.** restic keeps full snapshots; any snapshot can be restored.
2. Note the **incident time** — you will need it to choose the right snapshot.
3. If the system is still running and the data is not corrupted, take a fresh backup first:
   ```bash
   ./scripts/backup.sh
   ```
4. Decide what needs restoring (one database or all three).

---

## 2. List Available Snapshots

```bash
./scripts/restore.sh --list-snapshots
```

Output shows snapshot IDs, dates, and tags. Note the snapshot ID closest to (but
before) the incident.

To inspect snapshots held only on the remote (rclone backend), first sync the remote
into a local directory and point restic at it — see [Section 5](#5-restore-from-remote-storage).

---

## 3. Restore a Single Database

> **Warning:** restoring a database **destroys and recreates** it. The script prompts
> for an explicit `yes` before dropping anything. Always have a fresh backup first.

### From a restic snapshot

```bash
# Restore the governance database from the latest snapshot
./scripts/restore.sh --snapshot latest gremion

# Restore Keycloak from a specific snapshot
./scripts/restore.sh --snapshot abc12345 keycloak

# Restore the control-plane registry
./scripts/restore.sh --snapshot latest control
```

The script will:
1. Extract the snapshot to a temp directory.
2. Ask for confirmation before destroying the current database.
3. Terminate active connections, then drop and recreate the database with its owning role.
4. Restore the gzipped SQL dump.

### From a dump file directly

If you already have the dump file on disk:

```bash
./scripts/restore.sh gremion backups/current/gremion.sql.gz
```

---

## 4. Restore All Databases

Restore in dependency order — **Keycloak first** (authentication), then the
control-plane registry, then the governance database:

```bash
SNAPSHOT=latest

./scripts/restore.sh --snapshot $SNAPSHOT keycloak
./scripts/restore.sh --snapshot $SNAPSHOT control
./scripts/restore.sh --snapshot $SNAPSHOT gremion
```

All governance data — committees, members, the org-unit tree, protocols, resolutions,
and the hash-chained audit log — lives in the `gremion` database. The `control` database
holds the tenant registry and fleet-migration ledger; restore it whenever you restore
`gremion` so the two stay consistent.

---

## 5. Restore from Remote Storage

If the local restic repository is lost, rebuild it from the rclone remote:

```bash
# 1. Create an empty local repo directory
mkdir -p /path/to/new-repo

# 2. Sync from remote (RCLONE_* env vars must be set in .env)
source .env
rclone sync \
  "${RCLONE_REMOTE:-backup}:${RCLONE_BUCKET}/${RCLONE_REMOTE_PATH:-stura-restic}" \
  /path/to/new-repo

# 3. Point restic at the restored repo
export RESTIC_REPOSITORY=/path/to/new-repo

# 4. Verify the repo is intact
restic check

# 5. List and restore snapshots as above
./scripts/restore.sh --list-snapshots
./scripts/restore.sh --snapshot latest gremion
```

rclone remote credentials are read from the `RCLONE_*` variables in `.env`
(`RCLONE_BACKEND_TYPE`, `RCLONE_ENDPOINT`, `RCLONE_ACCESS_KEY_ID`,
`RCLONE_SECRET_ACCESS_KEY`, `RCLONE_BUCKET`).

---

## 6. Verify the Restore

After restoring each database:

### Keycloak
- Log into the Keycloak admin console at `/auth/admin`.
- Verify the realm, clients, and user counts match expectations.

### Governance database (`gremion`)
```bash
docker compose exec postgres psql -U "${POSTGRES_USER:-postgres}" gremion \
  -c "SELECT COUNT(*) FROM committees;"
docker compose exec postgres psql -U "${POSTGRES_USER:-postgres}" gremion \
  -c "SELECT COUNT(*) FROM sessions;"
```

### Control-plane registry (`control`)
```bash
docker compose exec postgres psql -U "${POSTGRES_USER:-postgres}" control \
  -c "SELECT COUNT(*) FROM tenant;"
```

---

## 7. Post-Restore Checklist

- [ ] All services responding (`docker compose ps`)
- [ ] Users can log in via Keycloak
- [ ] Admin shell accessible to an administrator account
- [ ] Governance data present (committees, members, protocols, resolutions)
- [ ] Tenant registry resolves the expected tenants (control plane)
- [ ] Run a fresh backup to establish a clean baseline: `./scripts/backup.sh`
- [ ] Record the incident in the governance audit log (INV-1)

---

## 8. ipcrypt Key Loss

The `vector` service pseudonymises client IPs in access logs using an ipcrypt key.
If the key is lost, **historical log pseudonymisation cannot be reversed** — existing
pseudonymised entries can no longer be re-linked to IP addresses (this is the intended
privacy property). No database restore is needed for log files.

To generate a fresh key and restart the log pipeline:

```bash
make -C infra/hardening generate-ipcrypt-key
docker compose restart vector
```

---

## 9. Emergency Contacts

| Role | Responsible |
|---|---|
| System administrator | (your deployment's operator) |
| Data Protection Officer | (per your organisation) |
| Hosting provider | (check your contract) |

---

*Operational hardening runbook for the Gremion governance kernel.*
