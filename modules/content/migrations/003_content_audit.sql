-- services/content/migrations/003_content_audit.sql
--
-- Adds the content.content_audit table for recording content action audit
-- entries. Mirrors the newsletter leaf's newsletter_audit table pattern.
-- The audit log is separate from the transactional NATS outbox — audit entries
-- are NOT relay events and must NOT be inserted into the outbox table.
--
-- All DDL is idempotent (CREATE TABLE IF NOT EXISTS).

BEGIN;

CREATE TABLE IF NOT EXISTS content.content_audit (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id    UUID        NOT NULL,
  actor_sub  TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
