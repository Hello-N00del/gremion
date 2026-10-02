// services/calendar/src/caldav/sync.ts
//
// Task 19: leaf-local CalDAV drain orchestration — ports
// gremion-ui/src/lib/server/calendar/caldav-sync.ts's drainCaldavQueue() to
// operate on a per-tenant Sql (DI, no kernel getDb()) using the leaf's own
// store/index.ts drain ops + caldav/client.ts ICS builder + caldav/pusher.ts
// WebDAV pusher.
//
// The DB is ALWAYS the source of truth. CalDAV is treated as an external
// cache for clients that speak iCal — a failed push never rolls back the
// underlying event write.
//
// This is the drainCaldav callback the scheduler (src/scheduler.ts) invokes
// per tenant per tick.

import type { Sql } from '../tenant-store.js'
import {
  listPendingCaldavSync,
  removeCaldavSyncEntry,
  recordCaldavSyncFailure,
  markCaldavSynced,
  getEvent,
  type DbCalDavQueueEntry,
} from '../store/index.js'
import { dbEventToIcs } from './client.js'
import type { CalDavPusher } from './pusher.js'

export const MAX_ATTEMPTS = 3
const DEFAULT_BATCH = 50

/**
 * Drain one batch of a tenant's caldav_sync_queue entries.
 *
 * The pusher is REQUIRED (H06): there is deliberately no env-backed default,
 * because the old default pushed every tenant into one shared collection. The
 * production caller is tenant-drain.ts, which resolves the per-tenant target.
 */
export async function drainCaldavQueue(
  sql: Sql,
  pusher: CalDavPusher,
  maxAttempts: number = MAX_ATTEMPTS,
  limit: number = DEFAULT_BATCH,
): Promise<{ succeeded: number; failed: number }> {
  const pending = await listPendingCaldavSync(sql, maxAttempts, limit)
  let succeeded = 0
  let failed = 0

  for (const entry of pending) {
    try {
      await processEntry(sql, entry, pusher)
      await removeCaldavSyncEntry(sql, entry.id)
      succeeded++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await recordCaldavSyncFailure(sql, entry.id, msg)
      failed++
    }
  }

  return { succeeded, failed }
}

async function processEntry(
  sql: Sql,
  entry: DbCalDavQueueEntry,
  pusher: CalDavPusher,
): Promise<void> {
  if (entry.operation === 'delete') {
    // For delete, the event row may already be gone — use the stored uid only.
    await pusher.pushDelete(entry.caldavUid)
    return
  }

  // create/update require the current event body. K4#6: when the event is gone
  // (event_id is NULLed by ON DELETE SET NULL, or the row no longer resolves)
  // there is nothing left to push; the delete entry queued by deleteEvent
  // carries the removal. Retire this entry rather than failing it forever.
  if (!entry.eventId) return
  const event = await getEvent(sql, entry.eventId)
  if (!event) return

  // D-2 (R29-I15, H06): NEVER PUSH NON-PUBLIC. The shared Nextcloud calendar is
  // readable by people who must not see a committee-internal event, so only an
  // explicitly public event may be written to it. This is the single choke point
  // for every push, so it fails CLOSED: anything but isPublic === true is
  // non-public. A non-public create is a no-op (the row is retired by the
  // caller). A non-public UPDATE means the event may have been public earlier
  // and already sit in the calendar, so it is RETRACTED (DELETE is idempotent:
  // 404/410 is success) rather than refreshed.
  if (event.isPublic !== true) {
    if (entry.operation === 'update') {
      await pusher.pushDelete(entry.caldavUid)
    }
    return
  }

  const ics = dbEventToIcs(event)
  if (entry.operation === 'create') {
    await pusher.pushCreate(ics)
  } else {
    await pusher.pushUpdate(ics)
  }
  await markCaldavSynced(sql, event.id)
}
