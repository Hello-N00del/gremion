-- services/content/migrations/002_posts_status.sql
--
-- Adds the dispatch-lifecycle columns to content.posts that the store layer
-- needs for claimPostForPublish / resetStuckPublishing / updatePost.
-- These columns mirror the newsletter dispatch state-machine pattern.
--
-- All DDL is idempotent (ADD COLUMN IF NOT EXISTS).

BEGIN;

ALTER TABLE content.posts
  ADD COLUMN IF NOT EXISTS status       TEXT        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error        TEXT;

-- Trigger: bump updated_at on every UPDATE that does NOT itself set updated_at.
-- The WHEN clause mirrors the newsletter leaf pattern (newsletters_updated_at_bump):
-- if the caller explicitly changes updated_at (manual aging in tests, scheduler
-- hygiene) the trigger leaves it alone; otherwise it bumps to now().
CREATE OR REPLACE FUNCTION content.posts_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.updated_at IS NOT DISTINCT FROM NEW.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_content_posts_updated_at'
      AND tgrelid = 'content.posts'::regclass
  ) THEN
    CREATE TRIGGER trg_content_posts_updated_at
      BEFORE UPDATE ON content.posts
      FOR EACH ROW EXECUTE FUNCTION content.posts_set_updated_at();
  END IF;
END;
$$;

COMMIT;
