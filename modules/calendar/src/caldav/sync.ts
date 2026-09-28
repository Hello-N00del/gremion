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
import { createCalDavPusher, type CalDavPusher } from './pusher.js'

export const MAX_ATTEMPTS = 3
const DEFAULT_BATCH = 50

/**
 * Drain one batch of a tenant's caldav_sync_queue entries.
 *
 * Injectable pusher for tests — if omitted, falls back to the env-backed
 * shared-calendar pusher (createCalDavPusher() with no args).
 */
export async function drainCaldavQueue(
  sql: Sql,
  pusher: CalDavPusher = createCalDavPusher(),
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

  // create/update require the current event body.
  if (!entry.eventId) {
    throw new Error('create/update queue entry has no event_id (event deleted?)')
  }
  const event = await getEvent(sql, entry.eventId)
  if (!event) {
    throw new Error(`event ${entry.eventId} vanished before sync`)
  }

  const ics = dbEventToIcs(event)
  if (entry.operation === 'create') {
    await pusher.pushCreate(ics)
  } else {
    await pusher.pushUpdate(ics)
  }
  await markCaldavSynced(sql, event.id)
}
