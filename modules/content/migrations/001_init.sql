-- services/content/migrations/001_init.sql
-- Squash of kernel migrations 044 + 045 + 046, plus the leaf-local outbox
-- and event_consumption idempotency tables.  Produces the complete `content`
-- schema in each per-tenant content_<slug> DB created by tenant-store.ts.
--
-- Sources squashed:
--   044_content_schema.sql      — content.posts, post_media, post_channels
--   045_content_publish.sql     — mailing_lists, mailing_list_members,
--                                 post_recipients, unsubscribes, send_tokens,
--                                 deliveries, publications
--   046_content_publish_ops.sql — publish_ops (IG carousel outbox)
--
-- Leaf-local tables (not in the kernel):
--   outbox           — transactional NATS outbox (mirrors newsletter leaf pattern)
--   event_consumption — per-consumer, per-event idempotency ledger
--
-- All DDL is idempotent (IF NOT EXISTS / CREATE OR REPLACE).
-- Never edit this file after it ships — add a new migration instead
-- (append-only + hash-locked via manifest.json).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- § 044: content schema + core authoring tables
-- ────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS content;

-- A post = a single authored piece of content, fanned out across channels.
-- body_html is sanitized rich HTML (sanitizeRichHtml at the write boundary);
-- <h2> delimits the sections the channel renderers segment on.
CREATE TABLE IF NOT EXISTS content.posts (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT        NOT NULL UNIQUE,
  title      TEXT        NOT NULL DEFAULT '',
  body_html  TEXT        NOT NULL DEFAULT '',
  created_by TEXT        NOT NULL,                 -- Keycloak user id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_posts_created_idx
  ON content.posts (created_at DESC);

-- Media attached to a post. role: hero (the lead/cover image), slide (an IG
-- carousel slide image), inline (within the body). position orders within role.
CREATE TABLE IF NOT EXISTS content.post_media (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id  UUID NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
  url      TEXT NOT NULL,
  role     TEXT NOT NULL CHECK (role IN ('hero', 'slide', 'inline')),
  position INT  NOT NULL DEFAULT 0,
  alt      TEXT
);

-- Per-channel publishing state for a post. enabled = the author opted this
-- channel in; status tracks the publish lifecycle; overrides holds per-channel
-- hand-tightened edits (subject line, slide reorders, …).
CREATE TABLE IF NOT EXISTS content.post_channels (
  post_id      UUID    NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
  channel      TEXT    NOT NULL CHECK (channel IN ('email', 'portal', 'instagram')),
  enabled      BOOLEAN NOT NULL DEFAULT false,
  status       TEXT    NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'scheduled', 'sent', 'published', 'failed')),
  scheduled_at TIMESTAMPTZ,
  overrides    JSONB   NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (post_id, channel)
);

-- ────────────────────────────────────────────────────────────────────────────
-- § 045: email + portal publish tables
-- ────────────────────────────────────────────────────────────────────────────

-- Recipients the operator manages directly. A mailing list is a named bucket
-- of email/name members.
CREATE TABLE IF NOT EXISTS content.mailing_lists (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content.mailing_list_members (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mailing_list_id UUID        NOT NULL REFERENCES content.mailing_lists(id) ON DELETE CASCADE,
  email           TEXT        NOT NULL,
  name            TEXT,
  source          TEXT        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailing_list_id, email)
);

-- What a post's email channel sends to: EITHER a content mailing list OR a KC
-- group (exactly one of the two, enforced by the XOR CHECK).
CREATE TABLE IF NOT EXISTS content.post_recipients (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id           UUID NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
  mailing_list_id   UUID REFERENCES content.mailing_lists(id) ON DELETE CASCADE,
  keycloak_group_id TEXT,
  CHECK ((mailing_list_id IS NOT NULL) <> (keycloak_group_id IS NOT NULL))
);

-- Suppression list — an email here is never sent to (deduped at resolve time).
CREATE TABLE IF NOT EXISTS content.unsubscribes (
  email      TEXT        PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-(post,email) unsubscribe token minted into the email footer link. The
-- UNIQUE(post_id, email) lets a re-send reuse the same persisted token.
CREATE TABLE IF NOT EXISTS content.send_tokens (
  token      TEXT        PRIMARY KEY,
  post_id    UUID        NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
  email      TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  UNIQUE (post_id, email)
);

-- Per-recipient idempotency / double-send gate (email channel). The
-- UNIQUE(post_id, email) plus a claim->send->mark-sent transition (with a
-- 15-min stale-claim takeover) make sends restart-safe.
CREATE TABLE IF NOT EXISTS content.deliveries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         UUID        NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
  email           TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'claimed'
                  CHECK (status IN ('claimed', 'sent', 'failed')),
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  smtp_message_id TEXT,
  error_message   TEXT,
  UNIQUE (post_id, email)
);

-- Portal idempotency linkage: which news_posts row a post's portal channel owns,
-- so a re-publish updates the SAME row instead of creating a duplicate.
CREATE TABLE IF NOT EXISTS content.publications (
  post_id      UUID        NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
  channel      TEXT        NOT NULL CHECK (channel IN ('email', 'portal', 'instagram')),
  external_ref TEXT,                 -- portal: news_posts.id::text
  published_at TIMESTAMPTZ,
  PRIMARY KEY (post_id, channel)
);

-- ────────────────────────────────────────────────────────────────────────────
-- § 046: Instagram publish outbox (publish_ops)
-- ────────────────────────────────────────────────────────────────────────────

-- One row per (post, op) is the durable IG-publish intent.
-- instagramRenderer.publish() enqueues it; a per-minute per-tenant drain
-- reconciles due rows via the Meta Graph carousel adapter.
-- Shipped DISABLED-BY-DEFAULT (capability ungranted + credentials null) —
-- the table + machinery exist; activation is separately ticketed.
CREATE TABLE IF NOT EXISTS content.publish_ops (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         uuid NOT NULL REFERENCES content.posts(id) ON DELETE CASCADE,
  channel         text NOT NULL DEFAULT 'instagram' CHECK (channel = 'instagram'),
  op              text NOT NULL DEFAULT 'publish' CHECK (op = 'publish'),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed')),
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  first_failed_at timestamptz,
  last_error      text,
  external_ref    text,                     -- the published Meta media id, on success
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(post_id, op)
);

CREATE INDEX IF NOT EXISTS content_publish_ops_due_idx
  ON content.publish_ops (created_at) WHERE status <> 'ok';

-- ────────────────────────────────────────────────────────────────────────────
-- § Leaf-local: transactional NATS outbox
-- ────────────────────────────────────────────────────────────────────────────

-- event_type stores the short ContentEvent value (e.g. 'publish.succeeded'),
-- NOT the full NATS subject — the full subject is built by contentSubject()
-- at relay time to avoid stale-subject drift (mirrors newsletter leaf pattern).
-- Columns are verbatim outbox pattern: uuid pk, backoff fields, terminal fields.
CREATE TABLE IF NOT EXISTS outbox (
  id               UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  correlation_id   TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'ok', 'failed')),
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  first_failed_at  TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- § Leaf-local: event_consumption idempotency ledger
-- ────────────────────────────────────────────────────────────────────────────

-- Per-consumer, per-event deduplication for any NATS consumers that run
-- inside the content leaf. PRIMARY KEY (consumer, event_id) makes
-- INSERT … ON CONFLICT DO NOTHING a true idempotency gate.
CREATE TABLE IF NOT EXISTS event_consumption (
  consumer    TEXT        NOT NULL,
  event_id    UUID        NOT NULL,
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

COMMIT;
