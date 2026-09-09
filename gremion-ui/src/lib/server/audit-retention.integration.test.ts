import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from './db'
import { purgeAuditLogsOlderThan } from './audit-db'

// T3.3 (G-024): retention-cutoff purge job for the audit_log table.
//
// We seed two cohorts (one stale at now() - 91 d, one fresh at now()) and
// assert that purgeAuditLogsOlderThan(90) deletes only the stale cohort.
// Cleanup uses TRUNCATE in beforeEach so leaked rows from neighbouring suites
// can't shift the counts.
describe('audit-db: purgeAuditLogsOlderThan', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
  })

  it('deletes only rows older than the cutoff window', async () => {
    const sql = getDb()

    // Stale cohort — 91 days old, must be purged at days=90.
    for (let i = 0; i < 5; i++) {
      await sql`
        INSERT INTO audit_log (created_at, user_id, field, old_value, new_value)
        VALUES (now() - 91 * INTERVAL '1 day', ${'user-stale-' + i}, 'org.name', 'old', 'new')
      `
    }

    // Fresh cohort — created now(), must survive.
    for (let i = 0; i < 5; i++) {
      await sql`
        INSERT INTO audit_log (created_at, user_id, field, old_value, new_value)
        VALUES (now(), ${'user-fresh-' + i}, 'org.name', 'old', 'new')
      `
    }

    const { purged } = await purgeAuditLogsOlderThan(90)
    expect(purged).toBe(5)

    const remaining = await sql<Array<{ count: string }>>`SELECT count(*)::text AS count FROM audit_log`
    expect(Number(remaining[0]!.count)).toBe(5)
  })
})
