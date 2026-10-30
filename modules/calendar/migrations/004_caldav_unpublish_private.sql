-- 004_caldav_unpublish_private.sql
-- F1-FIX-08, operator decision D-2 (R29-I15): NEVER PUSH NON-PUBLIC.
--
-- Before this unit the CalDAV drain pushed every event, is_public=false
-- included, into the shared Nextcloud calendar. The drain now refuses to push
-- non-public events, and an 'update' entry for one DELETEs its CalDAV copy.
-- This migration queues exactly that cleanup for every non-public event that an
-- earlier push left in the shared calendar (caldav_synced_at IS NOT NULL).
--
-- Re-run safety: the leaf runner executes every migration on each first
-- contact. Once the drain removes a copy it clears caldav_synced_at, so the
-- event no longer matches; the NOT EXISTS guard stops duplicates while a
-- cleanup row is still pending (for example while the tenant's CalDAV target is
-- not configured yet).
INSERT INTO caldav_sync_queue (event_id, caldav_uid, operation)
SELECT e.id, e.caldav_uid, 'update'
FROM calendar_events e
WHERE e.is_public = false
  AND e.caldav_uid IS NOT NULL
  AND e.caldav_synced_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM caldav_sync_queue q
    WHERE q.event_id = e.id
      AND q.operation = 'update'
      AND q.attempts < 3
  );
