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
  registerErasureHook,
} from '$lib/server/modules/runtime-registry'
import { registerNoRetention } from '$lib/server/module-karenz/retained/extractors'
import { calendarErasureHook } from './erasure'
import { startNotificationScheduler } from './notification-scheduler'
import { startCalDavSyncWorker } from './caldav-sync'
import { getCalendarBackend } from './backend'
import { calendarRefsOfOrgUnit } from './org-unit-refs'
import { expandRecurringEvents } from './recurrence-expand'
import { makeLogTracer, noopTracer } from '$lib/server/ports/tracer'
import { platformEnv } from '$lib/server/env/platform-env'
import {
  startCalendarAuditConsumer,
  CALENDAR_AUDIT_WORKER,
} from '$lib/server/events/calendar-audit-consumer'
import { superviseWorker, markWorkerOff } from '$lib/server/events/consumer-state'

// TRD-196 / PRD-OPS-005: the calendar's data-subject erasure step (per-module report).
registerErasureHook(calendarErasureHook)

// Module Karenz (phase 2): calendar events are planning data (RC-CAL-EVENT, the council record of a meeting
// lives in RC-GOV-MEET), so a switch-off seals no copy: the pg_dump export of the blocked database (RC-MOD-EXPORT)
// is the only thing kept, for the 30-day grace. Without this declaration the retained step fails closed on every
// pass and day 30 can never finalize.
registerNoRetention('calendar')

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
  // TASK-042 (Q3, Q4): NATS_URL is deployment-global - read through platformEnv, never through the
  // deleted default-tenant env family.
  const natsUrl = platformEnv('NATS_URL')
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

// The kernel command palette's event search. Events whose title or day (typed DD.MM.YYYY or YYYY-MM-DD, the
// day counted in Europe/Berlin like the calendar page) contains the query, from a window of 90 days
// back to 400 days ahead of today (listEvents has no title filter and the palette does not need history),
// one row per series (its next occurrence), the nearest to today first: what is coming up soonest, then what
// just was. The caller applied the calendar page's role gate and the customer's module switch. A failing
// read is NOT turned into an empty answer here: the caller logs it and degrades the one kind.
const SEARCH_WINDOW_BACK_MS = 90 * 86_400_000
const SEARCH_WINDOW_AHEAD_MS = 400 * 86_400_000
registerDataProvider('calendar:search-events', async ({ query, limit }) => {
  const now = new Date()
  const from = new Date(now.getTime() - SEARCH_WINDOW_BACK_MS)
  const to = new Date(now.getTime() + SEARCH_WINDOW_AHEAD_MS)
  const needle = foldForSearch(query)
  const events = nextOccurrencePerId(expandRecurringEvents(await getCalendarBackend().listEvents({ from, to }), from, to), now)
  const upcoming = events.filter((e) => e.startAt.getTime() >= now.getTime()).sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
  const past = events.filter((e) => e.startAt.getTime() < now.getTime()).sort((a, b) => b.startAt.getTime() - a.startAt.getTime())
  return [...upcoming, ...past]
    .filter((e) => foldForSearch(e.title).includes(needle) || berlinDayTexts(e.startAt).some((d) => d.includes(needle)))
    .slice(0, limit)
    .map((e) => ({ id: e.id, title: e.title, startAt: e.startAt, allDay: e.allDay }))
})

/** The day of an instant in Europe/Berlin, as YYYY-MM-DD and as DD.MM.YYYY: the two ways a person types a date. */
const BERLIN_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
function berlinDayTexts(at: Date): string[] {
  const parts = BERLIN_DAY.formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const [y, m, d] = [get('year'), get('month'), get('day')]
  return [`${y}-${m}-${d}`, `${d}.${m}.${y}`]
}

/** Case- and diacritic-folded text, for comparing a typed query with a title. */
function foldForSearch(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// The question before an org unit is deleted: does it still have calendar events? The kernel's committee
// delete asks this first and refuses while the answer is yes. Unlike the provider above, a failure is NOT
// degraded to an empty answer: the delete refuses on a failure instead of reading it as "no events".
registerDataProvider('calendar:org-unit-refs', calendarRefsOfOrgUnit)

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
