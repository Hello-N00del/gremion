-- 1205_news_posts_public_reader_columns.sql
-- Content module, block 1200-1299. Owner: gremion-module-content.
-- A FORWARD migration (TASK-200, Q9): 1200_content_news_posts.sql is never
-- edited — its bytes are pinned, and a database that applied it never re-runs
-- it, so narrowing its grant in place would converge nothing.
--
-- WHAT 1200 LEFT OPEN. It grants whole-table SELECT on news_posts to
-- gremion_public_reader, the anonymous portal's own database role: author_id
-- and every unpublished or future-dated row were readable over that
-- connection; only the portal's WHERE clauses kept them out of its responses.
--
-- WHAT THE PORTAL READS. gremion-public's public-db.ts selects exactly
-- id, title, slug, body_html, published_at, created_at, updated_at, and only
-- rows WHERE published_at IS NOT NULL AND published_at <= now() (plus a
-- COUNT(*) over the same predicate). This file grants exactly that:
--   - REVOKE ALL on the table from the reader (which also revokes any column
--     privileges), then GRANT SELECT on the seven columns — author_id is not
--     among them;
--   - ROW LEVEL SECURITY with one SELECT policy for gremion_public_reader
--     carrying the portal's own predicate.
-- RLS applies to non-owner roles only (no FORCE): the owning role that runs
-- migrations and serves the app keeps seeing every row. Any OTHER non-owner
-- role now sees no rows until a policy names it — fail closed, on purpose.
--
-- NUMBER. The next free number in the content app chain: 1200 is taken and
-- 1201-1204 are allocated to the renumbered StuRa 044-047 (spec B section 4;
-- content highWater 1204). Checked against the kernel chain
-- (gremion-ui/migrations, 0xx) and every modules/**/migrations directory:
-- no collision (scripts/check-module-migration-names.mjs guards basenames).
--
-- PROOF. modules/content/app/scripts/news-posts-public-grant-proof.sh runs this
-- chain on a throwaway postgres:18-alpine and asserts the grant as the reader.
-- Idempotent: re-running re-issues the same REVOKE/GRANT and recreates the policy.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gremion_public_reader') THEN
    RAISE EXCEPTION
      'role gremion_public_reader does not exist — 1200_content_news_posts.sql '
      'aborts on this same condition and runs before this file, so reaching '
      'this point in database % means the chain was not applied in order.',
      current_database();
  END IF;

  REVOKE ALL ON public.news_posts FROM gremion_public_reader;
  GRANT SELECT (id, title, slug, body_html, published_at, created_at, updated_at)
    ON public.news_posts TO gremion_public_reader;

  ALTER TABLE public.news_posts ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS news_posts_public_reader_published ON public.news_posts;
  CREATE POLICY news_posts_public_reader_published ON public.news_posts
    FOR SELECT TO gremion_public_reader
    USING (published_at IS NOT NULL AND published_at <= now());

  RAISE NOTICE 'gremion_public_reader: news_posts narrowed to 7 columns of published rows (content module)';
END
$$;
