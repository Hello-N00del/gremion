-- 057_fk_hot_filter_indexes.sql
--
-- Review 2026-07-28 (database dimension). Five FOREIGN-KEY columns are used as
-- the WHERE predicate on hot read paths but carry no index. Postgres indexes the
-- REFERENCED side of an FK automatically (it is a PRIMARY KEY); it never indexes
-- the REFERENCING column, so each of these degrades to a sequential scan and, on
-- the ON DELETE CASCADE / RESTRICT tables, makes every parent delete scan the
-- whole child table:
--
--   org_units.parent_id                -- self-referencing; the Gremien tree walk
--                                         hits it on every committee page load
--   role_assignments.role_id           -- the core "who holds this role" query
--   content.post_media.post_id         -- a post's media fan-out (content leaf)
--   content.post_recipients.post_id    -- a post's recipient fan-out (content leaf)
--   content.post_recipients.mailing_list_id
--                                      -- "which posts target this list", and the
--                                         ON DELETE CASCADE from content.mailing_lists
--
-- Verified missing on the live staging fleet (2026-07-28) — `gremion` (default),
-- `t_demo` and `t_musterstadt` each carried ONLY the primary-key index on all
-- four tables.
--
-- The `content` schema belongs to the TOGGLEABLE content module (044/045/046 are
-- listed in its manifest), so a tenant that initialised with the module OFF has
-- no `content` schema at all. This migration is NOT module-owned — it runs for
-- every tenant — so the three content indexes are guarded on table existence via
-- to_regclass() (which returns NULL, and does not raise, for an absent schema).
-- Consequence to know about: a tenant that later flips content OFF→ON replays
-- 044/045/046 (which do not contain these indexes) and will not pick them up —
-- a performance gap only, never a correctness one; give it its own migration if
-- that tenant ever appears.
--
-- Purely additive (README "Expand/contract" — expand step): new indexes only,
-- no table/column/constraint is touched and no deployed code changes meaning.
-- All DDL is IF NOT EXISTS, so re-running is a no-op.
-- No BEGIN/COMMIT (README house rule 3): the verified runner already wraps this
-- file AND its schema_migrations INSERT in ONE transaction (G-078).
--
-- Rollback (manual):
--   DROP INDEX IF EXISTS org_units_parent_id_idx;
--   DROP INDEX IF EXISTS role_assignments_role_id_idx;
--   DROP INDEX IF EXISTS content.content_post_media_post_id_idx;
--   DROP INDEX IF EXISTS content.content_post_recipients_post_id_idx;
--   DROP INDEX IF EXISTS content.content_post_recipients_mailing_list_id_idx;

-- ── kernel (always present) ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS org_units_parent_id_idx
  ON org_units (parent_id);

CREATE INDEX IF NOT EXISTS role_assignments_role_id_idx
  ON role_assignments (role_id);

-- ── content module (present only when the module is enabled for the tenant) ──

DO $$
BEGIN
  IF to_regclass('content.post_media') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS content_post_media_post_id_idx
      ON content.post_media (post_id);
  END IF;

  IF to_regclass('content.post_recipients') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS content_post_recipients_post_id_idx
      ON content.post_recipients (post_id);

    CREATE INDEX IF NOT EXISTS content_post_recipients_mailing_list_id_idx
      ON content.post_recipients (mailing_list_id);
  END IF;
END
$$;
