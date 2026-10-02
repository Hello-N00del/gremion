// CalDAV push-only sync worker — Stream B1.
//
// Drains caldav_sync_queue: for each pending entry, PUT/DELETE the ICS body
// to the tenant's Nextcloud calendar. Designed to be run on a cron schedule
// (every 30 s by default per the design doc). After a successful create/update
// the owning event's `caldav_synced_at` is updated. Failures increment an
// attempt counter; once attempts >= MAX_ATTEMPTS the entry is considered
// permanently failed and surfaces via the `listFailedCaldavSync` helper in
// calendar-db for the admin UI.
//
// The DB is ALWAYS the source of truth. CalDAV is treated as an external
// cache for clients that speak iCal — a failed push never rolls back the
// underlying event write.
//
// F1-FIX-08 (in-process twin of services/calendar/src/caldav/sync.ts):
// - H06: each tenant drains into ITS OWN collection (caldav-target.ts); an
//   unconfigured tenant is refused. No env-global default pusher any more.
// - D-2 (R29-I15, NEVER PUSH NON-PUBLIC): an is_public=false event is never
//   PUT; its update entry DELETEs any copy an earlier push left there.
// - K4#6: a create/update whose event is gone completes instead of failing.

import cron from 'node-cron'
import { forEachActiveTenant } from '$lib/server/tenant/worker-fleet'
import {
  listPendingCaldavSync,
  removeCaldavSyncEntry,
  recordCaldavSyncFailure,
  markCaldavSynced,
  markCaldavUnsynced,
  getEvent,
  getEventPublicFlag,
  enqueuePrivateCaldavCleanup,
  type DbCalDavQueueEntry,
} from './calendar-db'
import {
  createCalDavPusher,
  dbEventToIcs,
  type CalDavPusher,
} from './caldav-client'
import { resolveCaldavTarget, serviceCaldavVars, type CaldavTarget } from './caldav-target'

export const MAX_ATTEMPTS = 3
const DEFAULT_BATCH = 50

/**
 * Drain one batch of queue entries into `pusher` (the tenant's own collection).
 * Safe to invoke directly from tests or admin tooling.
 */
export async function drainCaldavQueue(
  pusher: CalDavPusher,
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

export interface TenantDrainDeps {
  env?: Record<string, string | undefined>
  makePusher?: (target: CaldavTarget) => CalDavPusher
  log?: (message: string) => void
}

/**
 * Drain the CURRENT tenant (the caller's runWithTenant scope) into its own
 * collection. A tenant without a configured, unshared target is refused:
 * its queue is not read and no attempt is burnt.
 */
export async function drainTenantCaldav(
  tenant: { readonly slug: string },
  deps: TenantDrainDeps = {},
): Promise<{ succeeded: number; failed: number; refused?: string }> {
  const resolved = resolveCaldavTarget(tenant, deps.env ?? serviceCaldavVars())
  if (!resolved.ok) {
    ;(deps.log ?? ((m: string) => console.warn(m)))(`[caldav-sync] drain refused: ${resolved.reason}`)
    return { succeeded: 0, failed: 0, refused: resolved.reason }
  }
  const makePusher = deps.makePusher ?? ((t: CaldavTarget) => createCalDavPusher(t))
  // D-2 cleanup (round 2, twin of leaf migration 004): queue the removal of
  // private events an earlier push left in the shared calendar. Idempotent.
  const queued = await enqueuePrivateCaldavCleanup()
  if (queued > 0) {
    ;(deps.log ?? ((m: string) => console.warn(m)))(
      `[caldav-sync] queued CalDAV removal of ${queued} non-public event(s) left by earlier pushes (D-2)`,
    )
  }
  return drainCaldavQueue(makePusher(resolved.target))
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

  // create/update for an event that no longer exists is obsolete: the delete
  // entry queued by deleteEvent removes any CalDAV copy (K4#6).
  if (!entry.eventId) return
  const event = await getEvent(entry.eventId)
  if (!event) return

  // D-2: NEVER PUSH NON-PUBLIC. A create pushes nothing; an update removes any
  // copy left by an earlier push (the event may have been public before).
  const isPublic = await getEventPublicFlag(event.id)
  if (isPublic !== true) {
    if (entry.operation === 'update') {
      const removed = await pusher.pushDelete(entry.caldavUid)
      // A 404 is normal for a never-synced private event. For one that WAS
      // pushed, the copy most likely sits in a former collection (the
      // env-wide shared calendar before the per-tenant switch, H06): the row
      // completes, but never silently (round 2, leaf twin).
      if (removed === false && event.caldavSyncedAt) {
        console.warn(
          `[caldav-sync] cleanup: ${entry.caldavUid} was synced at ${new Date(event.caldavSyncedAt).toISOString()} ` +
            `but is not in ${pusher.calPath}; a copy may remain in a former collection`,
        )
      }
      await markCaldavUnsynced(event.id)
    }
    return
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
  // F1-FIX-08 (H06): each tenant into its own collection.
  cron.schedule('*/30 * * * * *', () =>
    forEachActiveTenant('caldav-sync', (ctx) => drainTenantCaldav(ctx)),
  )
}
