-- migrations/002_add_is_public.sql
--
-- Adds the is_public flag to calendar_events, mirroring
-- gremion-ui/migrations/008_public_portal.sql's B5 addition. This column was
-- out of scope for the 003_calendar_schema.sql squash in 001_init.sql (Task
-- 12), but CalendarBackendPort's CreateEventInput/UpdateEventInput both carry
-- isPublic, and calendar-db.ts's createEvent/updateEvent read/write it — the
-- leaf's store/events.ts (Task 14) ports that SQL verbatim, so the column
-- must exist here too.
--
-- IF NOT EXISTS keeps this idempotent (matches the house migration-runner
-- pattern — safe to re-run against a DB that already has the column).

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;
