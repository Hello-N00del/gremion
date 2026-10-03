// gremion-ui/src/lib/server/calendar/backend/index.ts
// Task 4 — factory: selects the calendar backend implementation based on
// the CALENDAR_BACKEND environment variable.
//
//   unset / 'inprocess' → InprocessCalendarClient (byte-identical to current behavior)
//   'service'           → ServiceCalendarClient (HTTP ACL to CALENDAR_SERVICE_URL)
//   anything else       → throws (fail-closed)
//
// The default is 'inprocess' until the deliberate (HELD) cutover at the end of
// Group 6 (D4 — STOP before cutover). Only 'service' routes to the leaf.
//
// Call sites obtain the backend once per request / tick scope:
//   const backend = getCalendarBackend(event.locals.correlationId)
//   const events = await backend.listEvents()

import { InprocessCalendarClient } from './inprocess-client'
import { ServiceCalendarClient } from './service-client'
import { makeLogTracer, noopTracer } from '@gremion/ports/tracer'
import type { CalendarBackendPort } from './port'

export type { CalendarBackendPort } from './port'
export type {
  DbEvent,
  DbEventType,
  DbRecurrence,
  DbCommitteeCalendarSettings,
  DbCalDavQueueEntry,
  CreateEventInput,
  UpdateEventInput,
  ListEventsFilter,
  EventSource,
  RecurrenceFrequency,
  CaldavOperation,
} from './port'

/**
 * Resolve the calendar backend for the current CALENDAR_BACKEND env.
 *
 * Default is 'inprocess': byte-identical to the monolith calendar-db calls.
 * Set CALENDAR_BACKEND=service to route to the calendar leaf service.
 *
 * @param correlationId  Optional per-request correlation id forwarded as
 *   x-correlation-id to the leaf AND used to bind calendar.acl.<op> spans
 *   emitted when TRACE_EXPORTER=log (default 'none' → noopTracer).
 *   Pass event.locals.correlationId from route handlers.
 */
export function getCalendarBackend(correlationId?: string): CalendarBackendPort {
  const backend = process.env.CALENDAR_BACKEND ?? 'inprocess'

  if (backend === 'inprocess') {
    return new InprocessCalendarClient()
  }

  if (backend === 'service') {
    const traceExporter = process.env.TRACE_EXPORTER ?? 'none'
    const tracer =
      traceExporter === 'log' && correlationId ? makeLogTracer(correlationId) : noopTracer
    return new ServiceCalendarClient({ correlationId, tracer })
  }

  throw new Error(
    `[calendar-backend] Unknown CALENDAR_BACKEND value: '${backend}'. ` +
      "Valid values are 'inprocess' (default) or 'service'."
  )
}
