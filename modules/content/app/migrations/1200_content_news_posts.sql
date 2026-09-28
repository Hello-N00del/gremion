-- 1200_content_news_posts.sql
-- Content module, block 1200–1299 (B-04; ranges.json schema is D2's, its content
-- is B7's). Owner: gremion-module-content.
--
-- STAGING NOTE. This file is written into the kernel repo by
-- B4a-news-posts-ownership and moved — bytes unchanged — into
-- gremion-module-content/app/migrations/ by D5-remaining-module-repos. It is
-- written directly at its final four-digit number, so B7's renumber does not
-- touch it. It is deliberately OUTSIDE gremion-ui/migrations/: the kernel
-- registry carries only the core and governance manifests, so
-- disabledModuleMigrationFiles has no content manifest to gate it with and a
-- content-OFF kernel-only fresh init would create this table.
--
-- ORDER. 1204_news_posts_content_origin.sql (StuRa 047) does
-- `ALTER TABLE news_posts ADD COLUMN IF NOT EXISTS content_origin_post_id`, so
-- 1200 must stay first inside the block (D-04 folds news into content).
--
-- WHY THIS FILE EXISTS. The kernel's 008_public_portal.sql:4-6 records that
-- news_posts "moved out with the calendar/news modules during the Civitas kernel
-- carve", so the kernel creates it nowhere — while the StuRa
-- 058_public_reader_grants.sql required it and would abort the chain. B4 drops
-- the entry from 058's portal_tables and B4a moved the table and its
-- public-reader GRANT here: the kernel grants what the kernel guarantees,
-- content grants what content creates.
--
-- The DDL below is lifted VERBATIM from
-- StuRaOS/gremion-ui/migrations/008_public_portal.sql:14-27 at the frozen
-- extraction source f276af5925abacdcfd05f6613fc11afff2d804c5 (B00). It is
-- self-contained: no foreign keys. Do NOT reformat it — the lift is pinned by
-- gremion-ui/src/lib/server/content-news-posts-migration.test.ts.

CREATE TABLE IF NOT EXISTS news_posts (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  body_html    TEXT NOT NULL DEFAULT '',
  author_id    TEXT NOT NULL,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_news_posts_published
  ON news_posts (published_at DESC)
  WHERE published_at IS NOT NULL;

-- The public-reader GRANT that 058_public_reader_grants.sql (0058 after the B-04
-- renumber) no longer issues. Same loud shape as 058: a missing role ABORTS
-- rather than logging a notice nobody reads — a silent skip is the exact defect
-- 058 exists to close. Idempotent: re-running re-issues a GRANT already in place.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gremion_public_reader') THEN
    RAISE EXCEPTION
      'role gremion_public_reader does not exist — the anonymous public portal '
      'cannot read news_posts without it. The kernel grant migration '
      '058_public_reader_grants.sql aborts on this same condition and runs '
      'BEFORE this file, so reaching this point in database % means the kernel '
      'chain was not applied. Apply the kernel chain first, then re-run.',
      current_database();
  END IF;

  GRANT SELECT ON public.news_posts TO gremion_public_reader;

  RAISE NOTICE 'gremion_public_reader granted SELECT on: news_posts (content module)';
END
$$;
