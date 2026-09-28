// services/calendar/src/store/audit.ts
//
// Calendar audit log op on a per-tenant postgres-js Sql pool.
// Mirrors services/newsletter/src/store/audit.ts, adapted to the leaf-local
// calendar_audit table (id/event_id/actor_sub/action/created_at) defined in
// migrations/001_init.sql. This is distinct from the kernel's
// event_consumption idempotency table used by calendar-audit-consumer.ts —
// two different tables in two different databases.

import type { Sql } from '../tenant-store.js'

/**
 * Insert one audit entry for a calendar event action.
 */
export async function recordCalendarAudit(
  sql: Sql,
  eventId: string,
  actorSub: string,
  action: string,
): Promise<void> {
  await sql`
    INSERT INTO calendar_audit (event_id, actor_sub, action)
    VALUES (${eventId}, ${actorSub}, ${action})
  `
}
