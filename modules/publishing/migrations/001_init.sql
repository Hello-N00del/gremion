-- migrations/001_init.sql
-- Full §D.1 schema: SQLite newsletter tables translated to PostgreSQL.
-- Rules applied (per plan §D.1):
--   INTEGER PRIMARY KEY AUTOINCREMENT → BIGINT GENERATED ALWAYS AS IDENTITY
--   SQLite TEXT datetime('now')       → timestamptz DEFAULT now()
--   updated_at trigger                → PG BEFORE UPDATE trigger function
--   CHECK constraints + UNIQUE/partial-unique indexes carried verbatim
--   INSERT OR IGNORE                  → ON CONFLICT DO NOTHING
--   send_tokens.expires_at default    → now() + interval '7 days'
-- The deliveries + outbox tables are included now (Tasks 6/7 add their
-- application-layer code; DDL here keeps the migration idempotent).

-- ── mailing_lists ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mailing_lists (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── mailing_list_members ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mailing_list_members (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  list_id    BIGINT NOT NULL REFERENCES mailing_lists(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  name       TEXT,
  source     TEXT NOT NULL CHECK(source IN ('csv', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(list_id, email)
);

-- ── newsletters ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS newsletters (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        TEXT NOT NULL,
  odt_path     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK(status IN ('draft', 'scheduled', 'sending', 'sent', 'failed')),
  scheduled_at TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  error        TEXT,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- G-017: stuck-sending detection; kept in sync by the trigger below.
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- G-017: BEFORE UPDATE trigger — bumps updated_at on every UPDATE that does
-- not itself set updated_at (mirrors the SQLite newsletters_updated_at_bump
-- trigger semantics). The WHEN clause prevents infinite recursion: if the
-- caller explicitly sets updated_at the trigger leaves it alone.
CREATE OR REPLACE FUNCTION newsletters_updated_at_bump()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.updated_at IS NOT DISTINCT FROM NEW.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'newsletters_updated_at_bump'
      AND tgrelid = 'newsletters'::regclass
  ) THEN
    CREATE TRIGGER newsletters_updated_at_bump
    BEFORE UPDATE ON newsletters
    FOR EACH ROW EXECUTE FUNCTION newsletters_updated_at_bump();
  END IF;
END $$;

-- ── newsletter_recipients ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS newsletter_recipients (
  newsletter_id     BIGINT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  mailing_list_id   BIGINT REFERENCES mailing_lists(id),
  keycloak_group_id TEXT,
  CHECK((mailing_list_id IS NOT NULL) OR (keycloak_group_id IS NOT NULL)),
  CHECK(NOT (mailing_list_id IS NOT NULL AND keycloak_group_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nr_list
  ON newsletter_recipients(newsletter_id, mailing_list_id)
  WHERE mailing_list_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_nr_group
  ON newsletter_recipients(newsletter_id, keycloak_group_id)
  WHERE keycloak_group_id IS NOT NULL;

-- ── unsubscribes ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unsubscribes (
  email           TEXT PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  unsubscribed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── send_tokens ─────────────────────────────────────────────────────────────
-- G-009: tokens must expire so unsubscribe links can't be replayed forever.
CREATE TABLE IF NOT EXISTS send_tokens (
  token         TEXT PRIMARY KEY,
  newsletter_id BIGINT NOT NULL REFERENCES newsletters(id),
  email         TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  UNIQUE(newsletter_id, email)
);

CREATE INDEX IF NOT EXISTS send_tokens_expires_at_idx ON send_tokens(expires_at);

-- ── newsletter_audit ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS newsletter_audit (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  newsletter_id BIGINT NOT NULL,
  actor_sub     TEXT NOT NULL,
  action        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── deliveries — per-recipient idempotency ledger (SP-2 §3 / Task 6) ────────
-- claim → send → mark-sent so a crash or re-dispatch mid-loop never re-sends
-- an already-sent recipient. status is constrained;
-- (newsletter_id, email) is the claim key.
CREATE TABLE IF NOT EXISTS deliveries (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  newsletter_id   BIGINT NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'claimed' CHECK(status IN ('claimed', 'sent')),
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  smtp_message_id TEXT,
  UNIQUE(newsletter_id, email)
);

-- ── outbox — transactional outbox (P0.3a / Task 7) ──────────────────────────
-- event_type stores the short NewsletterEvent value (e.g. 'send.succeeded'),
-- NOT the full NATS subject (D-P1-7: the full subject is built by
-- newsletterSubject() at relay time to avoid stale-subject drift).
-- Columns are verbatim P0.3a (D-Δ3): uuid pk, backoff fields, terminal fields.
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
