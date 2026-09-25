-- 058_public_reader_grants.sql
-- T07 — close the FRESH-INSTALL grant hole for the anonymous public portal.
--
-- THE BUG THIS CLOSES
-- -------------------
-- docker/postgres/init-databases.sh creates the read-only role literally named
-- `gremion_public_reader`. Migrations 008_public_portal.sql (008:20) and
-- 055_resolution_challenges.sql (055:68) guard their GRANTs with
-- `IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'gremion_public_reader')`
-- and take a bare `RAISE NOTICE` ELSE branch when that test is false: both
-- migrations grant NOTHING and the migration run still EXITS GREEN. On any
-- install where the role has not been provisioned yet, the anonymous public
-- portal is then permanently broken (`permission denied for table protocols`)
-- with no failing check anywhere.
-- The tree this file was ported from never showed the bug: a one-off data-layer
-- rename had already renamed the role in place there, so its databases INHERITED
-- the grants instead of being granted them. That rename is not part of the
-- kernel and a fresh install runs no equivalent -- named as a mechanism and not
-- as a path on purpose, because a remediation that points at a file this repo
-- does not ship is the same dead end as an env var it does not define.
--
-- WHY A NEW MIGRATION INSTEAD OF FIXING 008/055 IN PLACE
-- -----------------------------------------------------
-- Every migration's bytes are pinned by the SHA-256 manifest
-- (migrations/manifest.json, G-012). db.ts verifies each file against it BEFORE
-- executing it, and already-applied files are never re-run. Editing 008 or 055
-- would therefore (a) not re-grant anything on an existing database — they are
-- recorded in schema_migrations — and (b) change their manifest hashes, which
-- is a tamper signal. 008 and 055 stay byte-identical; this file is the fix.
--
-- WHY IT FAILS LOUD
-- -----------------
-- The whole defect is a guard that stayed silent. A missing role now ABORTS the
-- migration (and therefore the tenant's readiness) instead of logging a notice
-- nobody reads. Provision the role first — docker/postgres/init-databases.sh or
-- k8s/base/postgres/configmap.yaml, both of which need PUBLIC_DB_PASSWORD set —
-- then re-run.
--
-- Idempotent: re-running only re-issues GRANTs/REVOKEs that are already in
-- place.

-- WHY THE REQUIRED SET IS UNCONDITIONAL, AND WHY NEWS_POSTS IS NOT HERE
-- ----------------------------------------------------------------------
-- The first draft wrapped each GRANT in `IF EXISTS (information_schema.tables)`
-- and justified it with the P0.2 module skip. That justification is FALSE for
-- both tables below: each is produced by a KERNEL migration
-- (007_protocols.sql, 010_org_units.sql), so an absent one always means a
-- broken replay. The per-table ELSE branch was also the very silent-skip shape
-- this migration exists to delete. Every table in `portal_tables` is required,
-- and a missing one aborts.
--
-- news_posts is DELIBERATELY ABSENT (B4a-news-posts-ownership). The kernel's
-- 008_public_portal.sql:4-6 records that it moved out with the calendar/news
-- modules during the carve, so the kernel creates it nowhere and requiring it
-- here aborted every content-OFF kernel-only fresh init. The table AND its
-- public-reader GRANT now live in the content module's own creation migration
-- 1200_content_news_posts.sql. Kernel grants what the kernel guarantees;
-- content grants what content creates.
--
-- WHY THE GRANT SET NARROWED TO TWO TABLES (R-E13)
-- --------------------------------------------------
-- An earlier version of this file granted every table the KERNEL chain
-- produces that the portal's data model touches at all: calendar_events,
-- event_recurrence, org_units, protocols, protocol_resolutions and
-- resolution_challenges. That is broader than least privilege actually
-- requires — gremion-public/src/lib/server/public-db.ts:51,82,105 reads only
-- `protocols` and `org_units`; nothing in the anonymous portal ever queries
-- the other four. Granting them anonymously exposed person data over the
-- internet with no application code standing in the way:
-- `resolution_challenges.raised_by` / `grounds` (who contested a resolution
-- and on what grounds) and `calendar_events.created_by`. `portal_tables`
-- below is therefore exactly the two tables the portal reads, and the four
-- tables that used to be in it move to `revoked_tables` — REVOKE, not merely
-- omission. `protocol_resolutions` and `resolution_challenges` are granted
-- directly to gremion_public_reader by kernel 008_public_portal.sql and
-- 055_resolution_challenges.sql on every install, fresh included, so the
-- REVOKE is load-bearing there too, not only on a database that ran an
-- earlier six-table version of this file (see the DECLARE block below for
-- the full accounting, including why no such database can exist that this
-- edit would need to converge).

DO $$
DECLARE
  -- LEAST PRIVILEGE: exactly the tables the anonymous public portal reads,
  -- verified against gremion-public/src/lib/server/public-db.ts:51,82,105
  -- (R-E13). `protocol_attendance` and `protocol_action_items` were in the
  -- first draft and were already GONE before R-E13 — no gremion-public query
  -- touches either, and attendance is personal data (who sat in which
  -- meeting) that must not be reachable by an anonymous, internet-facing
  -- role. `committees` is absent because 010_org_units.sql renamed it to
  -- org_units. `calendar_events`, `event_recurrence`, `protocol_resolutions`
  -- and `resolution_challenges` are absent as of R-E13: the portal's own
  -- queries never read them (see the header block above); they are now in
  -- `revoked_tables`. `news_posts` is absent because it is content-owned (see
  -- the header block); content's 1200_content_news_posts.sql grants it.
  portal_tables CONSTANT text[] := ARRAY[
    'org_units',
    'protocols'
  ];
  -- Tables this migration actively takes SELECT back from the reader role.
  -- `protocol_attendance`, `protocol_action_items` and `protocol_resolutions`
  -- are granted directly to gremion_public_reader by 008_public_portal.sql
  -- (008:23-29); `resolution_challenges` by 055_resolution_challenges.sql
  -- (055:69). Both migrations run BEFORE this file on every install, so these
  -- four REVOKEs are load-bearing on a fresh install too, not only on a
  -- database that happened to run an earlier version of 058 (see the REVOKE
  -- loop at the bottom for why editing 058 in place cannot converge such a
  -- database, and why none exists to converge). `calendar_events` and
  -- `event_recurrence` are not granted by any kernel migration today; their
  -- REVOKE here is defensive, matching the exact-set assertion in
  -- fresh-init-proof.sh rather than undoing an existing grant.
  revoked_tables CONSTANT text[] := ARRAY[
    'protocol_attendance',
    'protocol_action_items',
    'calendar_events',
    'event_recurrence',
    'protocol_resolutions',
    'resolution_challenges'
  ];
  t text;
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gremion_public_reader') THEN
    -- The remediation has to work on the deployment the operator ACTUALLY has.
    -- init-databases.sh runs from /docker-entrypoint-initdb.d, i.e. only on a
    -- FRESH volume; an operator hitting this abort has a running stack with
    -- data, which is exactly the case where mounting a fresh volume is not an
    -- option. So the direct psql command comes first and the init scripts are
    -- named second, for the fresh-install case they do cover.
    RAISE EXCEPTION
      'role gremion_public_reader does not exist — the anonymous public portal '
      'cannot read anything without it. Create it BEFORE migrating. On a '
      'RUNNING deployment (init-databases.sh only runs on a fresh volume), as '
      'the postgres superuser: '
      'CREATE ROLE gremion_public_reader LOGIN PASSWORD ''<PUBLIC_DB_PASSWORD>''; '
      'GRANT CONNECT ON DATABASE % TO gremion_public_reader; '
      'GRANT USAGE ON SCHEMA public TO gremion_public_reader; '
      '— then re-run the migrations (this file issues the per-table GRANTs). '
      'Use the SAME password GREMION_PUBLIC_DB_URL carries, or the portal will '
      'fail authentication instead of authorization. On a FRESH install set '
      'PUBLIC_DB_PASSWORD and let docker/postgres/init-databases.sh (Docker) or '
      'the postgres-init-scripts ConfigMap (K8s) create it. '
      'This migration deliberately aborts instead of skipping: a silent skip is '
      'precisely the defect it exists to close (008/055 silently skip their '
      'GRANTs and report success when this role is missing).',
      current_database();
  END IF;

  -- 008 hardcoded `GRANT CONNECT ON DATABASE stura`, a database name that no
  -- longer exists (STURA_DB_NAME defaults to `gremion`). Bind to whatever
  -- database this migration is actually running in.
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO gremion_public_reader',
    current_database()
  );
  GRANT USAGE ON SCHEMA public TO gremion_public_reader;

  -- Collect EVERY missing table before failing, so one run names the whole gap
  -- instead of one table per re-run.
  FOREACH t IN ARRAY portal_tables LOOP
    IF NOT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      missing := missing || t;
    END IF;
  END LOOP;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'the anonymous public portal reads table(s) that do not exist: %. '
      'These are KERNEL tables (007_protocols.sql, 010_org_units.sql), not '
      'module-gated ones, so a missing table means the migration replay is '
      'broken. news_posts is deliberately not in this list: the content '
      'module migration 1200_content_news_posts.sql creates and grants it, '
      'so a content-OFF install completes green with a working portal. '
      'This migration refuses to grant a partial set and report success.',
      array_to_string(missing, ', ');
  END IF;

  -- Unconditional: the set above is the complete, reviewed least-privilege set,
  -- and every member is known to exist by the check immediately above.
  FOREACH t IN ARRAY portal_tables LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO gremion_public_reader', t);
  END LOOP;

  -- REVOKE, not merely "absent from the list above".
  --
  -- protocol_attendance, protocol_action_items and protocol_resolutions are
  -- granted directly to gremion_public_reader by 008_public_portal.sql
  -- (008:23-29), and resolution_challenges by 055_resolution_challenges.sql
  -- (055:69) — both run BEFORE this file on every install, fresh included.
  -- Dropping a table from `portal_tables` above only stops 058 itself
  -- granting it; without the REVOKE here, gremion_public_reader would still
  -- end up holding SELECT on all four via 008/055 alone, even on a brand-new
  -- database. This REVOKE is therefore load-bearing on every install, not
  -- only on one that happened to run an earlier version of this file.
  -- calendar_events and event_recurrence are not granted by any kernel
  -- migration today; revoking them here is defensive, matching the
  -- exact-set assertion in fresh-init-proof.sh rather than undoing an
  -- existing grant.
  --
  -- This REVOKE does NOT converge a database that already applied an
  -- earlier, six-table version of 058 under this same filename: kernel
  -- db.ts's runMigrations skips any filename already recorded in
  -- schema_migrations before it re-checks the file's hash, so editing 058 in
  -- place never re-runs there. No such database exists — kernel 058 has
  -- never shipped on `main` or `origin/main` (git ls-tree confirms it absent
  -- on both) — and one that did surface would need a fresh re-init, not a
  -- patch to this file.
  --
  -- Existence-guarded because a database restored from before the table's own
  -- creating migration has no such table, and idempotent because REVOKE on a
  -- privilege that was never granted is a no-op.
  FOREACH t IN ARRAY revoked_tables LOOP
    IF EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('REVOKE SELECT ON public.%I FROM gremion_public_reader', t);
    END IF;
  END LOOP;

  RAISE NOTICE 'gremion_public_reader granted SELECT on: %',
    array_to_string(portal_tables, ', ');
  RAISE NOTICE 'gremion_public_reader REVOKED SELECT on: %',
    array_to_string(revoked_tables, ', ');
END
$$;
