import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from './db'
import { purgeAuditLogsOlderThan, verifyAuditChain, writeAuditEntry } from './audit-db'

/**
 * Reset the chain to genesis: the rows AND the purge anchor (migration 0059).
 * The anchor table is cleared only where it exists, so on a database without
 * 0059 these tests fail on the defect they pin, not on a missing table.
 */
async function resetAuditChain(): Promise<void> {
  const sql = getDb()
  await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.audit_log_chain_anchor') IS NOT NULL THEN
        DELETE FROM audit_log_chain_anchor;
      END IF;
    END $$`
}

async function ids(): Promise<number[]> {
  const sql = getDb()
  const rows = await sql<{ id: string }[]>`SELECT id::text AS id FROM audit_log ORDER BY audit_log.id`
  return rows.map((r) => Number(r.id))
}

// T3.3 (G-024): retention-cutoff purge job for the audit_log table.
//
// We seed two cohorts (one stale at now() - 91 d, one fresh at now()) and
// assert that purgeAuditLogsOlderThan(90) deletes only the stale cohort.
// Cleanup uses TRUNCATE in beforeEach so leaked rows from neighbouring suites
// can't shift the counts.
describe('audit-db: purgeAuditLogsOlderThan', () => {
  beforeEach(resetAuditChain)

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

  it('refuses a window under one day and deletes nothing (K1#36)', async () => {
    await writeAuditEntry({ userId: 'u1', field: 'a', oldValue: null, newValue: '1' })
    await expect(purgeAuditLogsOlderThan(0)).rejects.toThrow(RangeError)
    expect(await ids()).toEqual([1])
  })
})

// H01 (F1 sweep K1#0, K1#25): the daily retention purge deleted the chain HEAD,
// so the first surviving row's prev_hash pointed at a row no longer there and
// audit_log_verify_chain() reported BROKEN on every 6 h tick from the first
// purge on -- masking any real tampering behind a permanent false alarm.
// Migration 0059 records the removed prefix's last row_hash as the chain's
// anchor in the same transaction as the DELETE; the verifier starts there.
describe('audit_log chain anchor across retention purges (H01, migration 0059)', () => {
  beforeEach(resetAuditChain)

  async function writeFive(): Promise<void> {
    for (let i = 1; i <= 5; i++) {
      await writeAuditEntry({ userId: `u${i}`, field: 'retention.chain', oldValue: null, newValue: String(i) })
    }
  }

  async function backDate(rowIds: number[]): Promise<void> {
    const sql = getDb()
    await sql`UPDATE audit_log SET created_at = now() - INTERVAL '100 days' WHERE id = ANY(${rowIds}::bigint[])`
  }

  it('write 5, back-date 2, purge: the surviving chain verifies intact', async () => {
    await writeFive()
    const [first, second] = await ids()
    await backDate([first!, second!])

    const { purged } = await purgeAuditLogsOlderThan(90)

    expect(purged).toBe(2)
    expect(await ids()).toHaveLength(3)
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })

  it('after a purge, tampering a surviving row is still reported at that row', async () => {
    await writeFive()
    const all = await ids()
    await backDate(all.slice(0, 2))
    await purgeAuditLogsOlderThan(90)

    const sql = getDb()
    await sql`UPDATE audit_log SET new_value = 'TAMPERED' WHERE id = ${all[3]!}`

    expect(await verifyAuditChain()).toEqual({ ok: false, brokenAtId: all[3] })
  })

  it('the anchor does not launder the new head: tampering the first surviving row is reported at it', async () => {
    await writeFive()
    const all = await ids()
    await backDate(all.slice(0, 2))
    await purgeAuditLogsOlderThan(90)

    const sql = getDb()
    await sql`UPDATE audit_log SET user_id = 'someone-else' WHERE id = ${all[2]!}`

    expect(await verifyAuditChain()).toEqual({ ok: false, brokenAtId: all[2] })
  })

  it('deleting the first surviving row behind the purge is reported at its successor', async () => {
    await writeFive()
    const all = await ids()
    await backDate(all.slice(0, 2))
    await purgeAuditLogsOlderThan(90)

    const sql = getDb()
    await sql`DELETE FROM audit_log WHERE id = ${all[2]!}`

    expect(await verifyAuditChain()).toEqual({ ok: false, brokenAtId: all[3] })
  })

  it('two purges in a row keep the chain intact (the anchor advances)', async () => {
    await writeFive()
    const all = await ids()
    await backDate(all.slice(0, 1))
    await purgeAuditLogsOlderThan(90)
    await backDate(all.slice(1, 3))
    await purgeAuditLogsOlderThan(90)

    expect(await ids()).toEqual(all.slice(3))
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })

  it('a purge that removes every row, then a new write: the new row chains from the anchor and verifies', async () => {
    await writeFive()
    const all = await ids()
    await backDate(all)
    expect((await purgeAuditLogsOlderThan(90)).purged).toBe(5)

    await writeAuditEntry({ userId: 'u6', field: 'retention.chain', oldValue: null, newValue: '6' })

    const sql = getDb()
    const [row] = await sql<{ prev_hash: string | null }[]>`SELECT prev_hash FROM audit_log`
    const [anchor] = await sql<{ anchor_hash: string }[]>`SELECT anchor_hash FROM audit_log_chain_anchor`
    expect(row!.prev_hash).toBe(anchor!.anchor_hash)
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })

  it('only a chain PREFIX is purged: an old row behind a newer one waits for it, and nothing is left with a hole', async () => {
    // Written with their timestamps (an UPDATE of created_at would change the
    // hashed payload): rows 1 and 3 are old, row 2 is not, so only row 1 may go.
    const sql = getDb()
    for (const [i, ageDays] of [[1, 100], [2, 0], [3, 100], [4, 0], [5, 0]] as const) {
      await sql`
        INSERT INTO audit_log (created_at, user_id, field, old_value, new_value)
        VALUES (now() - ${ageDays}::int * INTERVAL '1 day', ${'u' + i}, 'retention.chain', NULL, ${String(i)})`
    }
    const all = await ids()

    const { purged } = await purgeAuditLogsOlderThan(90)

    expect(purged).toBe(1)
    expect(await ids()).toEqual(all.slice(1))
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })

  it('the anchor records the removed prefix: its last row_hash, its last id and the running count', async () => {
    await writeFive()
    const all = await ids()
    const sql = getDb()
    const [second] = await sql<{ row_hash: string }[]>`SELECT row_hash FROM audit_log WHERE id = ${all[1]!}`
    await backDate(all.slice(0, 2))
    await purgeAuditLogsOlderThan(90)

    const [anchor] = await sql<{ anchor_hash: string; through_id: string; rows_removed: string; source: string }[]>`
      SELECT anchor_hash, through_id::text AS through_id, rows_removed::text AS rows_removed, source
      FROM audit_log_chain_anchor`
    expect(anchor).toEqual({ anchor_hash: second!.row_hash, through_id: String(all[1]), rows_removed: '2', source: 'purge' })
  })
})
