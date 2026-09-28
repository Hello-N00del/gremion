-- Calendar schema — Stream B1
-- Tables: event_types, calendar_events, event_recurrence, event_committees,
-- committee_calendar_settings, caldav_sync_queue, imported_calendars.
-- Relies on: committees (from 001_governance_schema.sql).

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

-- ── Many-to-many: event ↔ committee ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_committees (
  event_id     UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  committee_id UUID NOT NULL REFERENCES committees(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, committee_id)
);

CREATE INDEX IF NOT EXISTS idx_event_committees_committee ON event_committees (committee_id);

-- ── Per-committee calendar colour (admin-configurable) ───────────────────────
CREATE TABLE IF NOT EXISTS committee_calendar_settings (
  committee_id UUID PRIMARY KEY REFERENCES committees(id) ON DELETE CASCADE,
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

-- ── External iCal sources (German holidays, future imports) ───────────────────
CREATE TABLE IF NOT EXISTS imported_calendars (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  source_url          TEXT NOT NULL,
  event_type_id       UUID REFERENCES event_types(id),
  last_synced_at      TIMESTAMPTZ,
  sync_interval_hours INT NOT NULL DEFAULT 24
);

-- Seed German holidays source (idempotent: matched by name)
INSERT INTO imported_calendars (name, source_url, sync_interval_hours, event_type_id)
SELECT
  'Deutsche Feiertage',
  'https://openholidaysapi.org/PublicHolidays',
  24,
  (SELECT id FROM event_types WHERE name = 'Feiertag' AND is_system = true LIMIT 1)
WHERE NOT EXISTS (
  SELECT 1 FROM imported_calendars WHERE name = 'Deutsche Feiertage'
);
