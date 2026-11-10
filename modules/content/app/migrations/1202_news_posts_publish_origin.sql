-- gremion:phase expand
-- 1202_news_posts_publish_origin.sql
-- Content module, block 1200-1299. Owner: gremion-module-content.
-- A FORWARD migration: 1200 and 1201 are never edited (their bytes are pinned).
--
-- WHAT IT ADDS. The idempotency anchor of the content-service portal-publish
-- callback (modules/content/app/lib/server/news/portal-callback.ts): the
-- callback looks a news post up by `content_origin_post_id` before it inserts
-- one, and news-db.ts writes the column on insert. The column is non-null only
-- for news_posts rows that the content leaf published through the callback, so
-- a retried publish finds its row instead of creating a second one. Without the
-- column every portal publish fails at the first SELECT.
--
-- WHY THIS NAME. The same DDL exists in the StuRa tree as migration 047, whose
-- slug the register lists as StuRa-only (scripts/migrations/stura-only-slugs.json).
-- The kernel's content app code needs the column, so the kernel chain carries
-- its own file under its own slug. Both are idempotent (IF NOT EXISTS), so a
-- database that has applied the StuRa file converges to the same schema.
--
-- The public-reader role is not granted the column: 1201 narrowed its SELECT to
-- seven columns and the portal never reads this one.

ALTER TABLE news_posts ADD COLUMN IF NOT EXISTS content_origin_post_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_news_posts_content_origin
  ON news_posts (content_origin_post_id)
  WHERE content_origin_post_id IS NOT NULL;
