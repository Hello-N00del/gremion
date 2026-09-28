-- migrations/001_init.sql
-- Full leaf schema: squashes gremion-ui/migrations/003_calendar_schema.sql into
-- the calendar_<slug> per-tenant database (Task 12, calendar-service
-- extraction). DDL — table names, columns, CHECKs, indexes — is lifted
-- verbatim from 003_calendar_schema.sql.
--
-- Cross-domain FKs dropped: 003_calendar_schema.sql's event_committees and
-- committee_calendar_settings reference committees(id), a governance table
-- that does not exist in this leaf's database (D6 — thin leaf, no
-- governance-shaped imports/tables). committee_id is kept as a plain
-- (unconstrained) UUID column; the kernel is the source of truth for
-- committee existence and is responsible for referential integrity across
-- the leaf boundary.
--
-- imported_calendars is dropped from the squash: dead inbound (no live
-- reader found in gremion-ui/src at squash time) — push-only calendar, no code
-- ever queries this table besides calendar-db.ts's own now-removed helpers.
--
-- The leaf-local outbox + calendar_audit tables are appended, copied from
-- the newsletter leaf's 001_init.sql pattern (outbox = transactional outbox
-- for NATS egress per P0.3a; calendar_audit = leaf-local audit trail mirror
-- of newsletter_audit).

BEGIN;

-- ── Event types (predefined + admin-extendable) ───────────────────────────────
CREATE TABLE IF NOT EXISTS event_types (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  is_system  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed system types (idempotent: matched by name+is_system)
INSERT INTO event_types (name, color, is_system)
SELECT v.name, v.color, true
FROM (VALUES
  ('Treffen',  '#3b82f6'),
  ('Frist',    '#ef4444'),
  ('Wahl',     '#8b5cf6'),
  ('Soziales', '#22c55e'),
  ('Feiertag', '#f59e0b')
) AS v(name, color)
WHERE NOT EXISTS (
  SELECT 1 FROM event_types e WHERE e.name = v.name AND e.is_system = true
);

-- ── Core events ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title              TEXT NOT NULL,
  description        TEXT,
  location           TEXT,
  start_at           TIMESTAMPTZ NOT NULL,
  end_at             TIMESTAMPTZ NOT NULL,
  all_day            BOOLEAN NOT NULL DEFAULT false,
  event_type_id      UUID REFERENCES event_types(id),
  is_multi_committee BOOLEAN NOT NULL DEFAULT false,
  created_by         TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual','helios','minutes','holiday','newsletter')),
  external_id        TEXT,
  caldav_uid         TEXT UNIQUE,
  caldav_synced_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_start_at  ON calendar_events (start_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_end_at    ON calendar_events (end_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_source    ON calendar_events (source);
CREATE INDEX IF NOT EXISTS idx_calendar_events_extid     ON calendar_events (source, external_id);

-- ── Recurring event rules (one row per recurring event) ───────────────────────
CREATE TABLE IF NOT EXISTS event_recurrence (
  event_id   UUID PRIMARY KEY REFERENCES calendar_events(id) ON DELETE CASCADE,
  frequency  TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','yearly')),
  interval   INT NOT NULL DEFAULT 1,
  until      DATE,
  count      INT,
  byday      TEXT[],
  exceptions DATE[]
);

-- ── Many-to-many: event ↔ committee (committee_id NOT FK'd — governance
--    table lives in the kernel DB, not this leaf; D6 thin-leaf boundary) ──────
CREATE TABLE IF NOT EXISTS event_committees (
  event_id     UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  committee_id UUID NOT NULL,
  PRIMARY KEY (event_id, committee_id)
);

CREATE INDEX IF NOT EXISTS idx_event_committees_committee ON event_committees (committee_id);

-- ── Per-committee calendar colour (admin-configurable; committee_id NOT
--    FK'd for the same reason as event_committees above) ─────────────────────
CREATE TABLE IF NOT EXISTS committee_calendar_settings (
  committee_id UUID PRIMARY KEY,
  color        TEXT NOT NULL DEFAULT '#6366f1',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── CalDAV push retry queue ───────────────────────────────────────────────────
-- caldav_uid stored directly so delete operations survive event row removal.
CREATE TABLE IF NOT EXISTS caldav_sync_queue (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID REFERENCES calendar_events(id) ON DELETE SET NULL,
  caldav_uid  TEXT NOT NULL,
  operation   TEXT NOT NULL CHECK (operation IN ('create','update','delete')),
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_caldav_sync_queue_pending ON caldav_sync_queue (attempts, created_at);

-- ── calendar_audit — leaf-local audit trail (mirrors newsletter_audit) ───────
CREATE TABLE IF NOT EXISTS calendar_audit (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id   UUID NOT NULL,
  actor_sub  TEXT NOT NULL,
  action     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── outbox — transactional outbox (mirrors newsletter's outbox table) ───────
-- event_type stores the short CalendarEvent value (e.g. 'event.created'),
-- NOT the full NATS subject — the full subject is built by calendarSubject()
-- at relay time (@gremion/ports/broker) to avoid stale-subject drift.
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

COMMIT;
