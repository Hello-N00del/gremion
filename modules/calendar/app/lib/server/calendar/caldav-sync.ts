// CalDAV push-only sync worker — Stream B1.
//
// Drains caldav_sync_queue: for each pending entry, PUT/DELETE the ICS body
// to the Nextcloud shared calendar. Designed to be run on a cron schedule
// (every 30 s by default per the design doc). After a successful create/update
// the owning event's `caldav_synced_at` is updated. Failures increment an
// attempt counter; once attempts >= MAX_ATTEMPTS the entry is considered
// permanently failed and surfaces via the `listFailedCaldavSync` helper in
// calendar-db for the admin UI.
//
// The DB is ALWAYS the source of truth. CalDAV is treated as an external
// cache for clients that speak iCal — a failed push never rolls back the
// underlying event write.

import cron from 'node-cron'
import { forEachActiveTenant } from '$lib/server/tenant/worker-fleet'
import {
  listPendingCaldavSync,
  removeCaldavSyncEntry,
  recordCaldavSyncFailure,
  markCaldavSynced,
  getEvent,
  type DbCalDavQueueEntry,
} from './calendar-db'
import {
  createCalDavPusher,
  dbEventToIcs,
  type CalDavPusher,
} from './caldav-client'

export const MAX_ATTEMPTS = 3
const DEFAULT_BATCH = 50

/**
 * Drain one batch of queue entries. Safe to invoke directly from tests or
 * admin tooling; not dependent on the cron schedule.
 *
 * Injectable pusher for tests — if omitted, falls back to the env-backed
 * shared-calendar pusher.
 */
export async function drainCaldavQueue(
  pusher: CalDavPusher = createCalDavPusher(),
  maxAttempts: number = MAX_ATTEMPTS,
  limit: number = DEFAULT_BATCH,
): Promise<{ succeeded: number; failed: number }> {
  const pending = await listPendingCaldavSync(maxAttempts, limit)
  let succeeded = 0
  let failed = 0

  for (const entry of pending) {
    try {
      await processEntry(entry, pusher)
      await removeCaldavSyncEntry(entry.id)
      succeeded++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await recordCaldavSyncFailure(entry.id, msg)
      failed++
    }
  }

  return { succeeded, failed }
}

async function processEntry(
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
  const event = await getEvent(entry.eventId)
  if (!event) {
    throw new Error(`event ${entry.eventId} vanished before sync`)
  }

  const ics = dbEventToIcs(event)
  if (entry.operation === 'create') {
    await pusher.pushCreate(ics)
  } else {
    await pusher.pushUpdate(ics)
  }
  await markCaldavSynced(event.id)
}

// ─── Cron wrapper ─────────────────────────────────────────────────────────────

let _started = false

/**
 * Start the every-30-second cron drain. Idempotent — safe to call from
 * hooks.server.ts boot regardless of hot reloads.
 */
export function startCalDavSyncWorker(): void {
  if (_started) return
  _started = true
  // node-cron supports seconds-precision with 6 fields; "*/30 * * * * *"
  // = every 30 seconds.
  // P2.1b T4: every tick drains the queue per ACTIVE tenant inside that
  // tenant's explicit runWithTenant scope — forEachActiveTenant provides the
  // per-(worker, tenant) single-flight, per-tenant try/catch + structured log.
  cron.schedule('*/30 * * * * *', () =>
    forEachActiveTenant('caldav-sync', () => drainCaldavQueue()),
  )
}
