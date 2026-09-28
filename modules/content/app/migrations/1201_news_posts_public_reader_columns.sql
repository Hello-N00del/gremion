-- 1201_news_posts_public_reader_columns.sql
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
-- WHAT THE PORTAL READS. The StuRa tree's gremion-public public-db.ts (at the
-- extraction tags extraction-source-f1 and -f2, unchanged between them; the
-- kernel's portal has no news query yet) selects exactly
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
-- NUMBER. 1201, the content app chain's next free number after 1200 (R24-6),
-- decided by the operator (R26-25) over the earlier draft number 1205. Any
-- StuRa migration the content app half (TASK-205) brings into this chain takes
-- a number after it. Checked against the kernel chain (gremion-ui/migrations,
-- 0xx) and every modules/**/migrations directory: no collision
-- (scripts/check-module-migration-names.mjs refuses a shared basename, a number
-- used twice in one chain, and an app-chain number the kernel or another app
-- chain already uses).
--
-- PROOF. modules/content/app/scripts/news-posts-public-grant-proof.sh runs this
-- chain on a throwaway postgres:18-alpine and asserts the grant as the reader.
-- Idempotent: re-running re-issues the same REVOKE/GRANT and recreates the policy.
-- Re-running 1200 ALONE after this file re-issues its whole-table GRANT and
-- re-opens author_id; the runner never re-runs an applied file, and a manual
-- replay must replay this file after it.
--
-- CHECKED, NOT ASSUMED. The REVOKE reaches only grants made to the reader
-- itself; a grant through PUBLIC or a role it belongs to would survive it. So
-- the file ends by asking the catalog what the reader can EFFECTIVELY do and
-- aborts unless: no author_id, no table-level SELECT, no write privilege, and
-- no BYPASSRLS.

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

  IF has_column_privilege('gremion_public_reader', 'public.news_posts', 'author_id', 'SELECT')
     OR has_table_privilege('gremion_public_reader', 'public.news_posts', 'SELECT')
     OR has_table_privilege('gremion_public_reader', 'public.news_posts', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'gremion_public_reader') THEN
    RAISE EXCEPTION
      'gremion_public_reader can still reach more of news_posts than the seven '
      'portal columns of published rows (author_id, a table-level SELECT, a write '
      'privilege, or BYPASSRLS) in database % — through PUBLIC or an inherited '
      'role, which the REVOKE above cannot reach. Remove that grant, then re-run.',
      current_database();
  END IF;

  RAISE NOTICE 'gremion_public_reader: news_posts narrowed to 7 columns of published rows (content module)';
END
$$;
