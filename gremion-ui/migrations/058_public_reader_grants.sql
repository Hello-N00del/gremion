-- 058_public_reader_grants.sql
-- T07 — close the FRESH-INSTALL grant hole for the anonymous public portal.
--
-- THE BUG THIS CLOSES
-- -------------------
-- docker/postgres/init-databases.sh creates the read-only role literally named
-- `gremion_public_reader`. Migrations 008_public_portal.sql and
-- 055_resolution_challenges.sql guard their GRANTs with
-- `IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'stura_public_reader')` —
-- the RETIRED name. On any fresh install that test is false, both migrations
-- take a bare `RAISE NOTICE` ELSE branch, grant NOTHING, and the migration run
-- still EXITS GREEN. The anonymous public portal is then permanently broken
-- (`permission denied for table news_posts`) with no failing check anywhere.
-- Staging never showed it because it inherited the grants through
-- scripts/rename-data-layer.sh (`ALTER ROLE stura_public_reader RENAME TO
-- gremion_public_reader`), which a fresh install never runs.
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
-- Idempotent: re-running only re-issues GRANTs that are already in place.

-- WHY EVERY TABLE IS UNCONDITIONAL
-- --------------------------------
-- The first draft wrapped each GRANT in `IF EXISTS (information_schema.tables)`
-- and justified it with the P0.2 module skip. That justification is FALSE: none
-- of these seven tables belongs to a toggleable module (grep the module
-- manifests — 003_calendar_schema.sql and 007_protocols.sql are kernel
-- migrations, unlike the finance set), so an absent one always means a broken
-- replay. Worse, the per-table ELSE branch was the very silent-skip shape this
-- migration exists to delete: with only news_posts hard-required, 058 could
-- report success having granted one table out of seven and the portal would
-- still be broken. Every table is now required, and a missing one aborts.

DO $$
DECLARE
  -- LEAST PRIVILEGE: exactly the tables gremion-public queries, verified against
  -- gremion-public/src/lib/server/public-db.ts. `protocol_attendance` and
  -- `protocol_action_items` were in the first draft and are deliberately GONE —
  -- no gremion-public query touches either, and attendance is personal data
  -- (who sat in which meeting) that must not be reachable by an anonymous,
  -- internet-facing role. `committees` is absent because 010_org_units.sql
  -- renamed it to org_units.
  portal_tables CONSTANT text[] := ARRAY[
    'calendar_events',
    'event_recurrence',
    'org_units',
    'protocols',
    'protocol_resolutions',
    'resolution_challenges'
  ];
  -- The two tables 008 granted and this migration takes BACK. Kept as an
  -- explicit array rather than an implicit absence so the removal is executable
  -- and auditable, not merely documented (see the REVOKE loop at the bottom).
  revoked_tables CONSTANT text[] := ARRAY[
    'protocol_attendance',
    'protocol_action_items'
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
      'precisely the defect it exists to close (008/055 tested for a RETIRED '
      'reader-role name and granted nothing while reporting success).',
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
      'These are kernel tables (008_public_portal.sql, 003_calendar_schema.sql, '
      '007_protocols.sql, 010_org_units.sql, 055_resolution_challenges.sql), not '
      'module-gated ones, so a missing table means the migration replay is broken. '
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
  -- Dropping the two tables from portal_tables only changes what a FRESH
  -- install converges on. Every database that ever ran 008_public_portal.sql
  -- while the role still carried its old name already HOLDS those grants:
  -- 008:40-48 granted SELECT on protocol_attendance and protocol_action_items
  -- to stura_public_reader, and scripts/rename-data-layer.sh:145 does
  -- `ALTER ROLE stura_public_reader RENAME TO gremion_public_reader` — Postgres
  -- keys privileges to the role OID, so the rename carried every grant across.
  -- Staging holds all nine tables today. Without these REVOKEs a fresh install
  -- would have seven and every real deployment nine: permanent, invisible
  -- configuration drift, which is the same defect class this migration exists
  -- to close, merely inverted.
  --
  -- Existence-guarded because a database restored from before 007_protocols.sql
  -- has no such tables, and idempotent because REVOKE on a privilege that was
  -- never granted is a no-op.
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
