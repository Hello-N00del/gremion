-- services/calendar/migrations/003_holiday_unique.sql
--
-- B5: a PARTIAL unique index so a concurrent or re-run holiday sync can never
-- create duplicate (source, external_id) holiday rows. ONLY holiday events are
-- (source, external_id)-unique — other sources (helios, minutes, newsletter)
-- legitimately produce several rows per external_id — hence the PARTIAL
-- predicate (WHERE source = 'holiday').
--
-- Any pre-existing duplicate holiday rows are collapsed FIRST (keeping the
-- earliest per group), otherwise CREATE UNIQUE INDEX would fail on them.
-- store/events.ts createEvent pairs this index with a conflict-tolerant holiday
-- insert (ON CONFLICT DO NOTHING) so a racing sync is a no-op that returns the
-- existing row.
--
-- Idempotent (matches the house migration-runner contract): the de-dup DELETE
-- is a no-op once the set is already unique, and the index uses IF NOT EXISTS —
-- safe to re-run against a DB that already has both.

BEGIN;

-- 1. Collapse pre-existing duplicate holiday rows: keep the earliest ctid per
--    (source, external_id) group, delete the rest, so the unique index below
--    can be created without a violation.
DELETE FROM calendar_events a
USING calendar_events b
WHERE a.source = 'holiday'
  AND b.source = 'holiday'
  AND a.external_id IS NOT NULL
  AND a.external_id = b.external_id
  AND a.ctid > b.ctid;

-- 2. Partial unique index: (source, external_id) is unique for holiday rows only.
CREATE UNIQUE INDEX IF NOT EXISTS calendar_events_holiday_extid_uidx
  ON calendar_events (source, external_id)
  WHERE source = 'holiday';

COMMIT;
