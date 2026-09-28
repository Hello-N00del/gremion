// services/content/src/store/audit.ts
//
// Content audit log op on a per-tenant postgres-js Sql pool.
// Mirrors services/newsletter/src/store/audit.ts.

import type { Sql } from '../tenant-store.js'

/**
 * Insert one audit entry for a content action into content.content_audit.
 * The audit table is separate from the transactional NATS outbox — audit
 * entries are NOT relay events and must NOT be inserted into the outbox.
 */
export async function recordContentAudit(
  sql: Sql,
  data: { post_id: string; actor_sub: string; action: string },
): Promise<void> {
  await sql`
    INSERT INTO content.content_audit (post_id, actor_sub, action)
    VALUES (${data.post_id}, ${data.actor_sub}, ${data.action})
  `
}
