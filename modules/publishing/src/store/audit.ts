// services/newsletter/src/store/audit.ts
//
// Newsletter audit log op on a per-tenant postgres-js Sql pool.
// Ported from gremion-ui/src/lib/server/newsletter/newsletter-db.ts.

import type { Sql } from '../tenant-store.js'

/**
 * Insert one audit entry for a newsletter action.
 * Mirrors recordNewsletterAudit() in the SQLite implementation.
 */
export async function recordNewsletterAudit(
  sql: Sql,
  newsletterId: number,
  actorSub: string,
  action: string,
): Promise<void> {
  await sql`
    INSERT INTO newsletter_audit (newsletter_id, actor_sub, action)
    VALUES (${newsletterId}, ${actorSub}, ${action})
  `
}
