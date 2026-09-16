# Postgres major for release 1 (spike S14)

- Status: accepted
- Date: 2026-09-16
- Authority: spec B §8, posture **P3** ("Postgres major is the newest every
  consumer supports"), unit `B37-postgres-major-pin`.
- **Pinned major**: 18
- Pinned tag: `postgres:18-alpine`

## S14 evidence

One hour, per consumer, from the consumer's own published support matrix.

| Consumer | Version checked | Newest Postgres major supported | Source | Read on |
|---|---|---|---|---|
| keycloak | 26.7 | 18 — supported-databases table reads "18.x, 17.x, 16.x, 15.x, 14.x", tested against 18 | https://www.keycloak.org/server/db | 2026-09-16 |
| nextcloud | 34 | 18 — "PostgreSQL 14 / 15 / 16 / 17 / 18 (recommended)" | https://docs.nextcloud.com/server/34/admin_manual/installation/system_requirements.html | 2026-09-16 |
| synapse | 1.160 | 18 — no ceiling of its own; it follows the upstream support life cycle, and 18 is the newest supported upstream major | https://element-hq.github.io/synapse/latest/deprecation_policy.html | 2026-09-16 |
| pgbouncer | 1.25 | 18 — 1.25.x documents PostgreSQL 18 server behaviour (`track_extra_parameters` / `search_path`) | https://www.pgbouncer.org/changelog.html | 2026-09-16 |
| pg_dump / pg_restore client | 18 | 18 — the client shipped by the pinned server image; `docker run --rm postgres:18-alpine postgres --version` reported `postgres (PostgreSQL) 18.6` on 2026-09-16 | https://www.postgresql.org/docs/18/app-pgdump.html | 2026-09-16 |

Upstream boundary, checked the same day: PostgreSQL 18 (18.6, released
2025-09-25) is the newest major with a release; 19 has none, and
the Docker official-images registry has no `19-alpine` tag (`docker manifest inspect` on it fails) —
https://www.postgresql.org/support/versioning/ , read 2026-09-16.

The pin is the **minimum** of that column, and that minimum is 18.

**The evidence disagreed with P3's expectation, and the evidence won.** P3 stated
an expectation of 17; every one of the five consumers supports 18, and 18 is the
newest upstream major, so "the newest every consumer supports" is 18. The plan
unit says in as many words that the spike, not the plan, sets the number and that
the engineer substitutes whatever the evidence produced. That is what happened
here. Nothing in the tree carries 17.

## Where the pin lands

The `postgres` service of the kernel base compose (`docker-compose.yml:20`),
every leaf Postgres declared by a module compose fragment
(`gremion-module-<id>/compose/<id>.yml`, service `<id>-postgres`, **six** today:
board, calendar, content, finance, newsletter, vault — measured on the frozen
extraction source StuRaOS `f276af59`, whose seventh `postgres:` image occurrence,
`docker-compose.yml:21`, is the shared kernel server and not a leaf; files,
messages and votes declare none), the kernel k8s manifests, the CI service
containers, and the `pg_dump`/`pg_restore` client.

There is **no dedicated backup image** in the kernel at `f7ac826` and none is
planned: the host backup path runs its client **inside the pinned server image**
(`infra/host/bin/gremion-backup:414-415`, `docker compose --env-file "$STATE_ENV"
exec -T <service> pg_dump -U "$POSTGRES_USER" <db>`; `scripts/restore.sh:109,122`,
`docker compose exec -T postgres psql`), so that client major follows this pin.
The only standalone client image is
`k8s/overlays/production/patches/backup-cronjob.yaml:31`, and it is pinned here
too.

## The 18+ data-directory contract — read this before wiping anything

**Crossing into 18 is not only a tag change.** At major 18 the Docker official
images moved the data directory and the mount point
([docker-library/postgres PR 1259](https://github.com/docker-library/postgres/pull/1259)).
Measured on this box against the real images, 2026-09-16:

| image | `PGDATA` | declared `VOLUME` |
|---|---|---|
| 16-alpine | `/var/lib/postgresql/data` | `/var/lib/postgresql/data` |
| 18-alpine | `/var/lib/postgresql/18/docker` | `/var/lib/postgresql` |

The 18+ entrypoint **refuses to start against any mount at
`/var/lib/postgresql/data`** — including a brand-new, provably empty volume. It
exits 1 before `initdb` with `there appears to be PostgreSQL data in:
/var/lib/postgresql/data (unused mount/volume)`, and under
`restart: unless-stopped` that becomes an endless restart loop rather than a
visible stop.

So **the kernel mounts its data volume at `/var/lib/postgresql`**, the layout
the image now documents and the one that keeps `pg_upgrade --link` usable. The
data then lives in the major-versioned subdirectory the image chooses
(`/var/lib/postgresql/18/docker`), which is why the mount is the *parent* and
never that subdirectory: mounting the versioned path works today and breaks at
the next bump.

Where that mount is declared, all of it guarded by
`node scripts/check-postgres-major.mjs` (`POSTGRES_DATA_MOUNT`,
`checkDataMounts`), which runs inside `make lint`:

- `docker-compose.yml:47`
- `k8s/base/postgres/statefulset.yaml:42` (init container) and `:79` (server) —
  the two must agree
- `test/host/integration/restore-proof.sh:81` and `:94`, so the restore fixture
  keeps mirroring the shipped compose

The volume **name** is unchanged (`pg-data` → `gremion_pg_data`), so
`RESTORE_VOLUME_SKIP_RE` in `infra/host/bin/gremion-restore-into:34`, which keys
on the name and not the path, is unaffected.

## Fresh initdb, and the rule for any later bump

A major change means a fresh `initdb`: a `pg-data` volume written by major 16
will not start under 18. Release 1 needs **no `pg_upgrade` path** because the box
is wiped at cutover (P1/P3, decision P3).

**A wipe alone is not sufficient, and this is the part that is easy to get
wrong.** An empty volume at the old mount point is refused just as firmly as a
populated one — the mount *path* has to be right as well. A cutover that wipes
the box but keeps a `/var/lib/postgresql/data` mount produces a crash loop with
no stale data anywhere to explain it.

**Rule for every later major bump:** it is a **dump/restore with a measured RTO**
— `gremion-backup` on the old major, `gremion-restore-into` on the new one, the
elapsed time recorded in the restore runbook — never an in-place `pg_upgrade` and
never a volume carried across majors. **And before the tag moves, re-read the new
major's image for a changed `PGDATA` or `VOLUME`** (`docker image inspect
postgres:<major>-alpine`): 18 moved both, and a future major may move them again.
`POSTGRES_DATA_MOUNT` in `scripts/check-postgres-major.mjs` is where that answer
is recorded, and `test/host/integration/postgres-major-proof.sh` is what proves
it by starting the server rather than reading a file.

## How the pin is proved

Two guards, both watched RED before they were trusted:

- `make lint-postgres-major` — the text half. Every `postgres:` reference in the
  tree is the pinned tag, every Postgres data mount is `POSTGRES_DATA_MOUNT`,
  this record and the code agree on the number, and an empty match set FAILS
  instead of passing.
- `test/host/integration/postgres-major-proof.sh` — the running half, and the
  only one that can tell a bootable stack from an unbootable one. It starts the
  base compose's `postgres` service with its real mounts and init script, then
  reads back `server_version_num`, `data_directory`, `PG_VERSION` on disk, the
  databases `docker/postgres/init-databases.sh` created, and the `pg_dump` /
  `psql` majors inside the running container. Measured 2026-09-16: major 18
  (`server_version_num=180006`), `data_directory=/var/lib/postgresql/18/docker`,
  `keycloak` / `gremion` / `control` created.

The C-collation requirement for Synapse's database is `B31-postgres-c-collation`
and is unaffected by the major.
