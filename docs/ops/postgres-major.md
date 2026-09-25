# Postgres major for release 1 (spike S14)

- Status: accepted
- Date: 2026-09-16
- Authority: spec B §8, posture **P3** ("Postgres major is the newest every
  consumer supports"), unit `B37-postgres-major-pin`.
- **Pinned major**: 18
- Pinned tag: `postgres:18-alpine`
- **Pinned digest**: sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
- Pinned reference (TASK-019, TRD-350): `postgres:18-alpine@<the digest above>`
  on every declaration — compose and workflow `image:` lines, shell
  assignments and defaults, `docker run`, Dockerfiles, `infra/host/bin`. It is
  the multi-arch **index** digest (`docker buildx imagetools inspect
  postgres:18-alpine`, the top `Digest:`, read 2026-09-25: index for 18.6 on
  alpine 3.24), never a per-platform manifest. Prose and comments stay
  major-only. `POSTGRES_IMAGE_DIGEST` in `scripts/check-postgres-major.mjs`
  must equal the line above; the guard asserts both directions.

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
2025-09-25) is the newest major with a **GA** release; 19 has none — it is
still in beta, which is not a candidate for a pin — and
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
messages and votes declare none), the six per-module servers of the kernel
base compose (TASK-019, below), the CI service containers, and the
`pg_dump`/`pg_restore` client. The kernel k8s manifests carry the pinned
**tag** but not the digest: `k8s/**` is frozen (D16) and out of the scan set.

There is **no dedicated backup image** in the kernel at `f7ac826` and none is
planned: the host backup path runs its client **inside the pinned server image**
(`infra/host/bin/gremion-backup:414-415`, `docker compose --env-file "$STATE_ENV"
exec -T <service> pg_dump -U "$POSTGRES_USER" <db>`; `scripts/restore.sh:109,122`,
`docker compose exec -T postgres psql`), so that client major follows this pin.
The only standalone client image is
`k8s/overlays/production/patches/backup-cronjob.yaml:31`; it carries the pinned
tag, and since D16 froze `k8s/**` it is held to the tag only (by
`postgres-major-proof.sh` step 6), not to the digest.

### Per-module servers and the digest (TASK-019, 2026-09-25)

D14 fixed one Postgres **per module** at the rebuild. The kernel base compose
therefore declares, next to its own `postgres` (labelled
`org.gremion.postgres: "kernel"`), one `<id>-postgres` per extraction-source
leaf — board, calendar, content, finance, newsletter, vault — built from one
`x-module-postgres` anchor (the pinned image, restart, logging, network,
`pg_isready` healthcheck), each under `profiles: [<id>]`, labelled
`org.gremion.postgres: "module:<id>"`, mounted at `/var/lib/postgresql`, and
**empty**: the per-(tenant, module) databases (D13) are the provisioner's
(TASK-021). TASK-040 re-sizes them and moves them to the state project.

Their volumes are `gremion_module_<id>_pg_data`. They must **never** be
`gremion_<id>_pg_data`: that is the name the extraction source's running stack
gives each leaf's PG16 volume, so a PG18 server declared on it would mount
live PG16 data. `checkModuleSet` refuses those names and `gremion_pg_data`.

Every declaration carries the digest above (`POSTGRES_IMAGE_REF`). The guard's
four nets read: a plain tag, a shell default `${V:-...}`, an untagged or
digest-only `image:`, and (new) a registry-prefixed reference such as
`docker.io/library/postgres:<tag>`, which was invisible before. A Postgres
service whose `image:` is a variable, a pinned default included, is refused:
the variable is exactly how the default gets overridden.

Files TASK-019 had to touch because control migration `006` moves a count,
each on its count line only: `gremion-ui/scripts/fresh-init-proof.sh` (control
files applied: 5), `gremion-ui/src/lib/modules/migration-manifest-staleness.test.ts`
(5 control files), `gremion-ui/migrations/README.md` and `docs/about-gremion.md`
(5 control migrations; `kernel-hygiene` n1/n2 read those).

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

- `docker-compose.yml`, the kernel `postgres` service and each of the six
  `<id>-postgres` module servers (TASK-019)
- `k8s/base/postgres/statefulset.yaml:42` (init container) and `:79` (server) —
  the two agree today; since D16 froze `k8s/**` they are out of the scan set
- `test/host/integration/restore-proof.sh:81` and `:94`, so the restore fixture
  keeps mirroring the shipped compose

The volume **name** is unchanged (`pg-data` → `gremion_pg_data`): this unit
renamed nothing, and the 18 layout only relocates the cluster to
`18/docker` *inside* the same volume. `RESTORE_VOLUME_SKIP_RE` in
`infra/host/bin/gremion-restore-into:34` keys on the volume NAME and not on
the path, so nothing B37 did can have changed its behaviour.

> ⚠ **That is not the same as saying the skip rule works, and this record does
> not claim it does.** Its default ERE is
> `(_pg-data|_postgres-data|_pgdata)$`, and `gremion_pg_data` matches none of
> the three alternatives (`_pg_data` is neither `_pg-data` nor `_pgdata`) —
> measured in bash on 2026-09-16: `gremion_pg_data` NOT skipped,
> `gremion-state_pg-data` skipped. `docker-compose.yml` pins fixed volume
> names while `gremion-backup` archives volumes under their real names, so an
> assembled release tree that keeps the kernel's fixed names would have the
> source cluster unpacked into the target volume rather than skipped. This is
> **pre-existing** — it is not a B37 post-condition and B37 neither caused nor
> fixed it — and it belongs to `B26-restore-and-erasure-proof` /
> `B27-backup-host-wiring`, which own that script. Recorded here because this
> is the page those units read the client major from.

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
- `node scripts/check-postgres-major-running.mjs --project <p>` (TASK-019) —
  the running half **across the whole stack**. It finds the project's
  containers by the `org.gremion.postgres` label, runs `SELECT version()` /
  `server_version_num` and `SELECT uuid_extract_version(uuidv7())` inside each
  one, and requires major 18 and UUID version 7. It fails on zero containers,
  on any labelled compose service (profile-gated ones included) with no
  running container, and on empty or failing psql output. Measured 2026-09-25
  on a scratch stack with all six profiles: seven containers, each
  `PostgreSQL 18.6 on x86_64-pc-linux-musl`, each `uuid_version=7`.
- `test/host/integration/postgres-major-proof.sh` — the running half for the
  kernel server, and the only one that can tell a bootable stack from an
  unbootable one. It starts the
  base compose's `postgres` service with its real mounts and init script, then
  reads back `server_version_num`, `data_directory`, `PG_VERSION` on disk, the
  databases `docker/postgres/init-databases.sh` created, and the `pg_dump` /
  `psql` majors inside the running container. Measured 2026-09-16: major 18
  (`server_version_num=180006`), `data_directory=/var/lib/postgresql/18/docker`,
  `keycloak` / `gremion` / `control` created.

Beyond the two guards, the kernel's own SQL has been executed on the pin once,
by hand, because the bump also changed the base distro of the CI service
containers (the old bare `16` Debian image → the pinned alpine/musl one) and GitHub Actions
are administratively disabled on this account, so nothing in CI could say so.
Replicating the `gremion-ui` workflow's migrate step locally on 2026-09-16
against `postgres:18-alpine` 18.6 — `tsx gremion-ui/scripts/run-migrations-verified.mjs`
with `GREMION_DISABLE_SEEDS=true` — ran the control plane and then fleet-migrated
the `default` tenant: `[run-migrations-verified] all tenants migrated + verified
(1 tenant(s))`, last applied `048_resolution_decided_at.sql`. Read back off the
running server afterwards: 3 rows in the control `schema_migrations`, 19 in the
data plane (the 22-file manifest minus the three seed files
`005_dev_seed.sql`, `006_full_seed.sql`, `011_org_units_dev_seed.sql` that
`GREMION_DISABLE_SEEDS` skips, `db.ts:192`), and 22 tables in `public`. This is
a one-off measurement, not a guard: the standing signal remains the workflow,
whenever Actions are re-enabled.

## Still open: the six leaf fragments — re-enter this unit after D6

(TASK-019 added the six per-module servers to the **kernel** base compose. The
module repos' own fragments below are still a separate, later step.)

The post-condition "pinned in **every** leaf Postgres declared by a module
compose fragment" is **not satisfied yet, and cannot be**: no
`gremion-module-*` repo exists on disk, because `D5-remaining-module-repos` and
`D6-leaf-images-and-compose-fragments` have not run. This is a scheduled
dependency, not a skipped step, and it is written down here rather than left to
memory.

What is already done: the mechanism. `node scripts/check-postgres-major.mjs
--tree <dir>` is built and proved against the three committed fixtures
(`tree-clean` green, `tree-stale` RED on both the tag and the mount, `tree-empty`
RED on the vacuity guard), so the moment the fragments exist the check is a
one-liner per repo.

What must still happen, **after D6**:

1. Pin `<id>-postgres` in each of the six carried-forward leaves — board,
   calendar, content, finance, newsletter, vault — and set each leaf's data
   mount to `POSTGRES_DATA_MOUNT`, not the pre-18 path.
2. Run `--tree gremion-module-<id>` per repo, and the stray check from the unit
   file (a fragment with its own Postgres **outside** that inventory is pinned by
   nobody, and a count alone would not notice).
3. `found` must equal `expected` = 6. Zero is a failure, never a pass.

Two plan-side corrections belong with this, and can only be made by whoever may
write the plan: B37's registry row still reads wave 1 / "Depends on —", which
contradicts this unit's own body and the plan's resolved question; and the same
row's "Guards owned: none" is wrong — this unit owns `make lint-postgres-major`
and the `--tree` half.

The C-collation requirement for Synapse's database is `B31-postgres-c-collation`
and is unaffected by the major.
