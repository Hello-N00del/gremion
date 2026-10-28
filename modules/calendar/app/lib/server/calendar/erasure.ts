// TRD-196 / PRD-OPS-005 — the calendar module's erasure hook (contract:
// @gremion/ports/erasure, registered in register.server.ts).
//
// calendar_events.created_by is the only personal datum the in-process calendar
// holds (the author's identity-provider id). It is NOT NULL and event-authz keys
// ownership on it, so it is replaced by a marker that matches no user, not nulled.
// The events themselves are council records and stay.
//
// With CALENDAR_BACKEND=service the calendar leaf owns its own database; the kernel
// holds no connection to it, so this module reports `skipped` rather than claiming
// an erasure it did not perform.
import type { Sql } from '@gremion/db'
import type { ModuleErasureHook } from '@gremion/ports/erasure'

export const CALENDAR_ERASED_MARKER = 'erased'

export const calendarErasureHook: ModuleErasureHook<Sql> = {
  moduleId: 'calendar',
  async erase({ db, subjectId }) {
    if ((process.env.CALENDAR_BACKEND ?? 'inprocess') === 'service') {
      return {
        status: 'skipped',
        reason: 'calendar data lives in the calendar service database; the kernel holds no connection to it',
      }
    }
    if (db === null) return { status: 'skipped', reason: 'no database connection' }
    const res = await db`UPDATE calendar_events SET created_by = ${CALENDAR_ERASED_MARKER} WHERE created_by = ${subjectId}`
    return { status: 'erased', counts: { calendar_events: res.count } }
  },
}
