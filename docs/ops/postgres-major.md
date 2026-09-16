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
`docker manifest inspect postgres:19-alpine` finds no such image —
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

## Fresh initdb, and the rule for any later bump

A major change means a fresh `initdb`: a `pg-data` volume written by major 16
will not start under 18. Release 1 needs **no `pg_upgrade` path** because the box
is wiped at cutover (P1/P3, decision P3).

**Rule for every later major bump:** it is a **dump/restore with a measured RTO**
— `gremion-backup` on the old major, `gremion-restore-into` on the new one, the
elapsed time recorded in the restore runbook — never an in-place `pg_upgrade` and
never a volume carried across majors.

The C-collation requirement for Synapse's database is `B31-postgres-c-collation`
and is unaffected by the major.
