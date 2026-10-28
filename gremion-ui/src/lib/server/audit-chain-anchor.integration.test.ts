// TASK-033-a: nothing in the application purges audit_log any more (it is a governance
// record, RC-GOV-CHAIN; the in-process tick and purgeAuditLogsOlderThan are gone). Migration
// 0059's SQL function audit_log_purge_before and the verifier that walks from the chain anchor
// are still shipped DDL (the operator-acknowledged adopt path writes the same anchor), so the
// verifier-from-anchor behaviour stays pinned here, driving the SQL function directly as the
// database owner. Ported from the removed audit-retention.integration.test.ts.
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from './db'
import { verifyAuditChain, writeAuditEntry } from './audit-db'
import { actor } from './audit-test-actor'

/**
 * Reset the chain to genesis: the rows AND the purge anchor (migration 0059).
 */
async function resetAuditChain(): Promise<void> {
  const sql = getDb()
  await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
  await sql`DELETE FROM audit_log_chain_anchor`
}

/** The shipped aged-prefix function, called directly (no application code calls it). */
async function purgeBefore90(): Promise<{ purged: number }> {
  const sql = getDb()
  const rows = await sql<{ purged: string }[]>`SELECT audit_log_purge_before(now() - 90::int * INTERVAL '1 day')::text AS purged`
  return { purged: Number(rows[0]?.purged ?? 0) }
}

async function ids(): Promise<number[]> {
  const sql = getDb()
  const rows = await sql<{ id: string }[]>`SELECT id::text AS id FROM audit_log ORDER BY audit_log.id`
  return rows.map((r) => Number(r.id))
}

describe('audit_log chain anchor: the verifier walks from an anchor (migration 0059; the shipped SQL function, no application caller)', () => {
  beforeEach(resetAuditChain)

  async function writeFive(): Promise<void> {
    for (let i = 1; i <= 5; i++) {
      await writeAuditEntry({ userId: actor(`u${i}`), field: 'retention.chain', oldValue: null, newValue: String(i) })
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

    const { purged } = await purgeBefore90()

    expect(purged).toBe(2)
    expect(await ids()).toHaveLength(3)
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })

  it('after a purge, tampering a surviving row is still reported at that row', async () => {
    await writeFive()
    const all = await ids()
    await backDate(all.slice(0, 2))
    await purgeBefore90()

    const sql = getDb()
    await sql`UPDATE audit_log SET new_value = 'TAMPERED' WHERE id = ${all[3]!}`

    expect(await verifyAuditChain()).toEqual({ ok: false, brokenAtId: all[3] })
  })

  it('the anchor does not launder the new head: tampering the first surviving row is reported at it', async () => {
    await writeFive()
    const all = await ids()
    await backDate(all.slice(0, 2))
    await purgeBefore90()

    const sql = getDb()
    await sql`UPDATE audit_log SET user_id = ${actor('someone-else')} WHERE id = ${all[2]!}`

    expect(await verifyAuditChain()).toEqual({ ok: false, brokenAtId: all[2] })
  })

  it('deleting the first surviving row behind the purge is reported at its successor', async () => {
    await writeFive()
    const all = await ids()
    await backDate(all.slice(0, 2))
    await purgeBefore90()

    const sql = getDb()
    await sql`DELETE FROM audit_log WHERE id = ${all[2]!}`

    expect(await verifyAuditChain()).toEqual({ ok: false, brokenAtId: all[3] })
  })

  it('two purges in a row keep the chain intact (the anchor advances)', async () => {
    await writeFive()
    const all = await ids()
    await backDate(all.slice(0, 1))
    await purgeBefore90()
    await backDate(all.slice(1, 3))
    await purgeBefore90()

    expect(await ids()).toEqual(all.slice(3))
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })

  it('a purge that removes every row, then a new write: the new row chains from the anchor and verifies', async () => {
    await writeFive()
    const all = await ids()
    await backDate(all)
    expect((await purgeBefore90()).purged).toBe(5)

    await writeAuditEntry({ userId: actor('u6'), field: 'retention.chain', oldValue: null, newValue: '6' })

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
        VALUES (now() - ${ageDays}::int * INTERVAL '1 day', ${actor('u' + i)}, 'retention.chain', NULL, ${String(i)})`
    }
    const all = await ids()

    const { purged } = await purgeBefore90()

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
    await purgeBefore90()

    const [anchor] = await sql<{ anchor_hash: string; through_id: string; rows_removed: string; source: string }[]>`
      SELECT anchor_hash, through_id::text AS through_id, rows_removed::text AS rows_removed, source
      FROM audit_log_chain_anchor`
    expect(anchor).toEqual({ anchor_hash: second!.row_hash, through_id: String(all[1]), rows_removed: '2', source: 'purge' })
  })
})
