// src/lib/server/calendar/register.server.ts
// Civitas Session-A inversion A1/A3a: the calendar module self-registers its two
// boot workers into the runtime-registry server-init seam (so hooks.server.ts
// never imports calendar internals) AND its dashboard upcoming-events read into
// the data-provider seam (so the kernel dashboard route never imports
// calendar-db). Loaded for its side effects by the generated server-init barrel;
// runServerInitHooks() invokes the boot hooks at cold start.
import {
  registerServerInitHook,
  registerDataProvider,
} from '$lib/server/modules/runtime-registry'
import { startNotificationScheduler } from './notification-scheduler'
import { startCalDavSyncWorker } from './caldav-sync'
import { getCalendarBackend } from './backend'
import { expandRecurringEvents } from './recurrence-expand'
import { makeLogTracer, noopTracer } from '$lib/server/ports/tracer'
import { defaultTenantEnv } from '$lib/server/tenant/default-env'
import {
  startCalendarAuditConsumer,
  CALENDAR_AUDIT_WORKER,
} from '$lib/server/events/calendar-audit-consumer'
import { superviseWorker, markWorkerOff } from '$lib/server/events/consumer-state'

// SP-2 §2.5: the scheduler resolves the sender PER TENANT at tick time via the
// mail seam (getTenantMailContext), so every active tenant sends from its own
// configured SMTP and an unconfigured tenant is skipped per tick.
registerServerInitHook(() => {
  startNotificationScheduler()
})

// Stream B1: drain caldav_sync_queue every 30 s so Nextcloud CalDAV stays in
// sync with the stura DB. Pure push-only — failures surface in admin UI.
// Non-fatal: a worker that won't start shouldn't block the whole app.
//
// Cutover guard: when CALENDAR_BACKEND=service the calendar leaf owns the CalDAV
// drain (its own scheduler drains its own caldav_sync_queue), so the in-kernel
// worker MUST NOT run — it would drain the now-unused kernel queue and double-own
// the CalDAV push. Read the flag at cold start (before any tenant ALS scope). The
// notification-scheduler + audit consumer stay in-kernel regardless.
if ((process.env.CALENDAR_BACKEND ?? 'inprocess') !== 'service') {
  registerServerInitHook(() => {
    try {
      startCalDavSyncWorker()
    } catch (err) {
      console.error('[boot] CalDAV sync worker failed to start:', err)
    }
  })
}

// Task 10: calendar-event → audit_log consumer. Env-gated on NATS_URL — absent
// → consumer stays off (staging-safe). Non-fatal: a consumer that won't start
// must not block the whole app.
registerServerInitHook(async () => {
  const natsUrl = defaultTenantEnv('NATS_URL')
  if (!natsUrl) {
    console.info('[calendar-audit-consumer] NATS_URL not set — consumer off')
    markWorkerOff(CALENDAR_AUDIT_WORKER, 'NATS_URL not set')
    return
  }
  const auditTraceExporter = process.env.TRACE_EXPORTER ?? 'none'
  const auditTracer = auditTraceExporter === 'log' ? makeLogTracer('monolith:calendar-audit') : noopTracer
  // Still non-fatal, no longer silent: retried on a bounded schedule and, if it
  // never comes up, reported as degraded by /api/health.
  await superviseWorker({
    name: CALENDAR_AUDIT_WORKER,
    start: () => startCalendarAuditConsumer(natsUrl, auditTracer),
  })
})

// Dashboard upcoming-events read (Task 3.6): the kernel dashboard loadCommon
// invokes this provider for events in [from, to). We project the DbEvent down to
// the kernel-owned UpcomingEventRow (the fields the dashboard's mine/hue mapping
// reads). The caller try/catches a DB outage → empty list (its empty state).
registerDataProvider('calendar:upcoming-events', async (range) => {
  try {
    const backend = getCalendarBackend()
    // F1-FIX-08 (S1c#12): expand recurring series into the dashboard window,
    // then keep ONE row per event id: the series' next occurrence. Every
    // occurrence carries the series id and the dashboard keys its list by id,
    // so two occurrences of a weekly series threw each_key_duplicate (round 2).
    const events = nextOccurrencePerId(
      expandRecurringEvents(
        await backend.listEvents({ from: range.from, to: range.to }),
        range.from,
        range.to,
      ),
      range.from,
    )
    return events.map((e) => ({
      id: e.id,
      startAt: e.startAt,
      title: e.title,
      location: e.location,
      committeeIds: e.committeeIds,
    }))
  } catch (err) {
    console.error('[calendar] upcoming-events provider degraded to empty:', err)
    return []
  }
})

/**
 * One event per id from a start-sorted expansion: the first occurrence that
 * starts at or after `from` (the "upcoming" one); an occurrence that is
 * already running only stands in when the series has no later one in range.
 */
function nextOccurrencePerId<T extends { id: string; startAt: Date }>(sorted: readonly T[], from: Date): T[] {
  const picked = new Map<string, T>()
  for (const e of sorted) {
    const current = picked.get(e.id)
    if (!current) picked.set(e.id, e)
    else if (current.startAt.getTime() < from.getTime() && e.startAt.getTime() >= from.getTime()) picked.set(e.id, e)
  }
  return sorted.filter((e) => picked.get(e.id) === e)
}
