// G-103 — audit-db DB-backed integration tests.
//
// `audit-db.test.ts` exists but it mocks the `postgres` template literal
// entirely (assertions are "the mock was called once") so it can't catch
// real schema drift, NULL handling, ORDER BY contract, or index usage.
// This file is the DB-backed companion that exercises the actual SQL
// against the integration-test Postgres.
//
// Cluster note: T2.2 acceptance #4 — assert the composite index (field,
// created_at DESC) is used for the field+date pattern — depends on
// migration `0024_audit_log_composite_index.sql` (Cluster 1, G-076).
// That migration is now on master at HEAD; the EXPLAIN assertion lands
// inline here per the brief's "use option (a)" instruction.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TransactionSql } from 'postgres'
import { getDb } from './db'
import { writeAuditEntry, readAuditLog, verifyAuditChain } from './audit-db'
import { actor } from './audit-test-actor'

describe('G-103 audit-db integration', () => {
  beforeEach(async () => {
    const sql = getDb()
    // Same isolation pattern as the other audit integration specs — wipe
    // the table at the start of each test so neighbouring suites' leaked
    // rows don't shift the assertions.
    await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
  })

  describe('writeAuditEntry → readAuditLog round-trip', () => {
    it('round-trips a complete audit entry (all fields populated)', async () => {
      await writeAuditEntry({
        userId: actor('user-roundtrip'),
        field: 'org.name',
        oldValue: 'StuRa Beispieluni',
        newValue: 'StuRa Test',
      })
      const rows = await readAuditLog('org.name')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: actor('user-roundtrip'),
        field: 'org.name',
        oldValue: 'StuRa Beispieluni',
        newValue: 'StuRa Test',
      })
      expect(Number(rows[0].id)).toBeGreaterThan(0)
      expect(rows[0].createdAt).toBeInstanceOf(Date)
    })
  })

  describe('NULL handling on optional fields', () => {
    it('persists oldValue as NULL when omitted (insert path)', async () => {
      // The schema declares old_value as nullable, new_value as NOT NULL
      // (migrations/0009_audit_log.sql:7-8). An audit entry recording an
      // initial-config write (no prior value) sets oldValue: null and
      // the row must persist with old_value IS NULL on read.
      await writeAuditEntry({
        userId: actor('user-null'),
        field: 'org.initialSetup',
        oldValue: null,
        newValue: 'completed',
      })
      const rows = await readAuditLog('org.initialSetup')
      expect(rows).toHaveLength(1)
      expect(rows[0].oldValue).toBeNull()
      expect(rows[0].newValue).toBe('completed')
    })

    it('readAuditLog returns oldValue as a JS null (not "null" string or undefined)', async () => {
      const sql = getDb()
      // Insert a row with raw NULL via the driver to confirm the
      // SELECT alias mapping (`old_value AS "oldValue"`) preserves
      // NULL semantics rather than turning them into the string "null"
      // (a classic JSON round-trip failure mode).
      await sql`
        INSERT INTO audit_log (user_id, field, old_value, new_value)
        VALUES (${actor('user-direct-null')}, 'config.x', NULL, 'new')
      `
      const rows = await readAuditLog('config.x')
      expect(rows[0].oldValue).toBeNull()
      // Defensive: ensure it isn't the literal string "null" or undefined.
      expect(rows[0].oldValue).not.toBe('null')
      expect(rows[0].oldValue).not.toBeUndefined()
    })
  })

  describe('limit + ordering contract', () => {
    it('default limit is 50 — inserting 60 rows for one field returns only the 50 most recent', async () => {
      // The audit-db API exposes a `limit = 50` default
      // (audit-db.ts:23). Anything larger should be filtered at the
      // SQL boundary, not by the caller, so a leaked-row test of size
      // 60 should still see only 50 rows back.
      for (let i = 0; i < 60; i++) {
        await writeAuditEntry({
          userId: actor(`user-${i}`),
          field: 'cap.test',
          oldValue: null,
          newValue: `v${i}`,
        })
      }
      const rows = await readAuditLog('cap.test')
      expect(rows).toHaveLength(50)
      // ORDER BY created_at DESC must put the latest insert first.
      // We deliberately don't assert exact ordering by user-id (the
      // bulk insert may share a millisecond for several rows) but the
      // newValue suffix is monotonic from 0 to 59, and the top row
      // should be one of the high indexes (>= 50 if ordering works).
      const topNewValue = rows[0].newValue
      const topIdx = Number(topNewValue.slice(1))
      expect(topIdx).toBeGreaterThanOrEqual(50)
    })

    it('explicit limit override caps the result set below the default', async () => {
      for (let i = 0; i < 10; i++) {
        await writeAuditEntry({
          userId: actor(`u-${i}`),
          field: 'small.cap',
          oldValue: null,
          newValue: String(i),
        })
      }
      const rows = await readAuditLog('small.cap', 3)
      expect(rows).toHaveLength(3)
    })

    it('returns rows in created_at DESC order', async () => {
      const sql = getDb()
      // Force a known ordering by inserting with explicit timestamps so
      // the test isn't flaky on rows that share now() to the millisecond.
      await sql`INSERT INTO audit_log (created_at, user_id, field, old_value, new_value) VALUES (now() - INTERVAL '30 minutes', ${actor('u-old')},  'order.test', 'a', 'b')`
      await sql`INSERT INTO audit_log (created_at, user_id, field, old_value, new_value) VALUES (now() - INTERVAL '10 minutes', ${actor('u-mid')},  'order.test', 'a', 'b')`
      await sql`INSERT INTO audit_log (created_at, user_id, field, old_value, new_value) VALUES (now(),                          ${actor('u-new')},  'order.test', 'a', 'b')`
      const rows = await readAuditLog('order.test')
      expect(rows.map((r) => r.userId)).toEqual([actor('u-new'), actor('u-mid'), actor('u-old')])
    })
  })

  describe('composite index (G-076 / cluster-1 T1.1, migration 024)', () => {
    it('idx_audit_log_field_created_at exists in pg_indexes', async () => {
      // Sanity check before the EXPLAIN assertion — if migration 024
      // didn't run, fail loudly here instead of further down with a
      // misleading "no index used" message.
      const sql = getDb()
      const rows = await sql<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'audit_log'
          AND indexname = 'idx_audit_log_field_created_at'
      `
      expect(rows).toHaveLength(1)
    })

    it('the field-filter + created_at-order query plan references the composite index', async () => {
      // Seed enough rows that the planner prefers an index scan over a
      // sequential scan. With only a handful of rows Postgres often picks
      // SeqScan, which would make this assertion permanently fail even
      // though the index is correct.
      const sql = getDb()
      for (let i = 0; i < 200; i++) {
        await sql`
          INSERT INTO audit_log (user_id, field, old_value, new_value)
          VALUES (${actor('u' + i)}, ${i % 5 === 0 ? 'idx.target' : 'idx.other'}, NULL, 'v')
        `
      }
      await sql`ANALYZE audit_log`
      // On a small CI dataset the planner cheaply prefers SeqScan (200 rows fit
      // one heap page), so asserting the index is *chosen* is environment-
      // fragile. Force-disable seqscan inside a transaction and assert the
      // composite (field, created_at DESC) index CAN serve the whole
      // predicate+order in one scan — the actual invariant. SET LOCAL only
      // lives for the transaction, so the pool's other connections are
      // unaffected.
      const planText = await sql.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`
        const plan = await tx<Array<Record<string, string>>>`
          EXPLAIN
          SELECT id, created_at, user_id, field, old_value, new_value
          FROM audit_log
          WHERE field = ${'idx.target'}
          ORDER BY created_at DESC
          LIMIT 50
        `
        return plan.map((row) => Object.values(row).join(' ')).join('\n')
      })
      expect(planText, `expected idx_audit_log_field_created_at in plan:\n${planText}`)
        .toContain('idx_audit_log_field_created_at')
    })
  })
})

/**
 * Back to genesis: the rows and the purge anchor (migration 0059). The anchor
 * is cleared only where its table exists, so a database without 0059 fails
 * these tests on the defect they pin, not on a missing table.
 */
async function resetAuditChain(): Promise<void> {
  const sql = getDb()
  await sql`TRUNCATE audit_log RESTART IDENTITY`
  await sql`
    DO $$ BEGIN
      IF to_regclass('public.audit_log_chain_anchor') IS NOT NULL THEN
        DELETE FROM audit_log_chain_anchor;
      END IF;
    END $$`
}

// Governance Core INV-1 (tamper-evident record) — migration 043 hash chain.
describe('audit_log hash chain (INV-1)', () => {
  beforeEach(resetAuditChain)

  it('chains sequential entries and verifies intact', async () => {
    await writeAuditEntry({ userId: actor('u1'), field: 'committee.create', oldValue: null, newValue: 'A' })
    await writeAuditEntry({ userId: actor('u2'), field: 'committee.update', oldValue: 'A', newValue: 'B' })

    const sql = getDb()
    const rows = await sql<{ id: number; prev_hash: string | null; row_hash: string }[]>`
      SELECT id, prev_hash, row_hash FROM audit_log ORDER BY id`
    expect(rows).toHaveLength(2)
    expect(rows[0].prev_hash).toBeNull()
    expect(rows[0].row_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[1].prev_hash).toBe(rows[0].row_hash) // linkage

    expect(await verifyAuditChain()).toEqual({ ok: true })
  })

  it('detects tampering when a row is mutated without re-hashing', async () => {
    await writeAuditEntry({ userId: actor('u1'), field: 'x', oldValue: null, newValue: 'orig' })
    await writeAuditEntry({ userId: actor('u2'), field: 'y', oldValue: null, newValue: 'second' })

    const sql = getDb()
    await sql`UPDATE audit_log SET new_value = 'TAMPERED' WHERE id = 1`

    expect(await verifyAuditChain()).toEqual({ ok: false, brokenAtId: 1 })
  })

  it('detects a mid-chain row deletion (the successor linkage breaks)', async () => {
    await writeAuditEntry({ userId: actor('u1'), field: 'a', oldValue: null, newValue: '1' })
    await writeAuditEntry({ userId: actor('u2'), field: 'b', oldValue: null, newValue: '2' })
    await writeAuditEntry({ userId: actor('u3'), field: 'c', oldValue: null, newValue: '3' })

    const sql = getDb()
    // delete the MIDDLE row — row 3's prev_hash now points at a hash no surviving
    // row produces, so the chain breaks at row 3.
    await sql`DELETE FROM audit_log WHERE id = 2`

    expect(await verifyAuditChain()).toEqual({ ok: false, brokenAtId: 3 })
  })

  it('KNOWN LIMITATION: tail truncation (deleting the most recent rows) is NOT detected', async () => {
    // A self-contained hash chain detects in-place UPDATEs and mid-chain
    // INSERT/DELETE, but deleting the TAIL leaves a shorter, internally-consistent
    // chain. This test pins that documented gap (see migration 043's verifier
    // comment + the Phase-3 external-anchor follow-up). If a future change adds
    // truncation detection, update this expectation.
    await writeAuditEntry({ userId: actor('u1'), field: 'a', oldValue: null, newValue: '1' })
    await writeAuditEntry({ userId: actor('u2'), field: 'b', oldValue: null, newValue: '2' })
    await writeAuditEntry({ userId: actor('u3'), field: 'c', oldValue: null, newValue: '3' })

    const sql = getDb()
    await sql`DELETE FROM audit_log WHERE id = (SELECT max(id) FROM audit_log)`

    // The remaining 2-row prefix is still internally consistent → reports ok.
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })
})

// K1#2 / S5#24 (F1-FIX-02): the id came from the column DEFAULT, i.e. BEFORE
// the trigger took the chain lock, while the verifier walks the chain in id
// order. A writer whose id was drawn while another transaction held the lock
// linked itself behind a row with a HIGHER id, and the chain verified BROKEN
// with nobody tampering. Migration 0059 draws the id under the lock.
describe('audit_log hash chain under concurrent writers (K1#2)', () => {
  beforeEach(resetAuditChain)

  it('two connections: an id drawn while the other writer holds the chain lock still verifies intact', async () => {
    const sql = getDb()
    const a = await sql.reserve()
    const b = await sql.reserve()
    try {
      await a.unsafe('BEGIN')
      await a`INSERT INTO audit_log (user_id, field, new_value) VALUES (${actor('writer-a')}, 'race.a', '1')`

      // B draws its id now and then waits for A's transaction-scoped chain lock.
      const bDone = b`INSERT INTO audit_log (user_id, field, new_value) VALUES (${actor('writer-b')}, 'race.b', '2')`.then(() => 'b-committed')
      let waiting = 0
      for (let i = 0; i < 100 && waiting === 0; i++) {
        const [row] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
        waiting = row!.n
        if (waiting === 0) await new Promise((r) => setTimeout(r, 50))
      }
      expect(waiting, 'writer B never queued behind the chain lock').toBe(1)

      // A writes again (a higher id than B's) and commits; then B proceeds.
      await a`INSERT INTO audit_log (user_id, field, new_value) VALUES (${actor('writer-a')}, 'race.a', '3')`
      await a.unsafe('COMMIT')
      expect(await bDone).toBe('b-committed')
    } finally {
      a.release()
      b.release()
    }

    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log`
    expect(rows[0]!.n).toBe(3)
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })
})

// Migration 0059 on a database whose head was ALREADY purged before it shipped.
// The first surviving row's prev_hash is then the only trace of its removed
// predecessor, and a migration cannot tell a retention purge from a deleted
// head. It never rewrites or drops an audit row, and it fails loudly instead of
// guessing: it adopts that prev_hash as the anchor only when the operator has
// acknowledged exactly that hash (gremion.audit_chain_adopt_head). Each case
// runs the committed file's text inside a transaction that is rolled back.
describe('migration 0059 on a chain whose head was purged before it (H01 upgrade path)', () => {
  const MIGRATION = join(process.cwd(), 'migrations', '0059_audit_log_chain_anchor.sql')
  class Rollback extends Error {}

  beforeEach(resetAuditChain)

  async function inRolledBackTx(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
    const sql = getDb()
    await sql
      .begin(async (tx) => {
        await fn(tx)
        throw new Rollback()
      })
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e
      })
  }

  /** Three rows, the oldest removed the pre-0059 way: a plain DELETE, no anchor. */
  async function purgedHeadWithoutAnchor(tx: TransactionSql): Promise<{ headPrev: string; chain: string }> {
    for (const v of ['1', '2', '3']) {
      await tx`INSERT INTO audit_log (user_id, field, new_value) VALUES (${actor('u')}, 'upgrade.chain', ${v})`
    }
    await tx`DELETE FROM audit_log WHERE id = (SELECT min(id) FROM audit_log)`
    await tx`DELETE FROM audit_log_chain_anchor`
    const [head] = await tx<{ prev_hash: string }[]>`SELECT prev_hash FROM audit_log ORDER BY id LIMIT 1`
    return { headPrev: head!.prev_hash, chain: await chainFingerprint(tx) }
  }

  async function chainFingerprint(tx: TransactionSql): Promise<string> {
    const [r] = await tx<{ f: string | null }[]>`
      SELECT string_agg(id::text || ':' || coalesce(prev_hash, '') || ':' || row_hash || ':' || new_value, ',' ORDER BY id) AS f
      FROM audit_log`
    return r!.f ?? ''
  }

  it('without the operator acknowledgement it refuses: it cannot tell a purge from a deleted head', async () => {
    const text = readFileSync(MIGRATION, 'utf-8')
    await inRolledBackTx(async (tx) => {
      const { headPrev } = await purgedHeadWithoutAnchor(tx)
      await expect(tx.unsafe(text)).rejects.toThrow(new RegExp(`cannot anchor[\\s\\S]*${headPrev}[\\s\\S]*gremion\\.audit_chain_adopt_head`))
    })
  })

  it('with the acknowledged hash it adopts it as the anchor, rewrites no row, and the chain verifies', async () => {
    const text = readFileSync(MIGRATION, 'utf-8')
    await inRolledBackTx(async (tx) => {
      const { headPrev, chain } = await purgedHeadWithoutAnchor(tx)
      await tx`SELECT set_config('gremion.audit_chain_adopt_head', ${headPrev}, true)`
      await tx.unsafe(text)

      expect(await chainFingerprint(tx)).toBe(chain)
      const [anchor] = await tx<{ anchor_hash: string; source: string }[]>`SELECT anchor_hash, source FROM audit_log_chain_anchor`
      expect(anchor).toEqual({ anchor_hash: headPrev, source: 'adopted' })
      const [v] = await tx<{ broken: string | null }[]>`SELECT audit_log_verify_chain() AS broken`
      expect(v!.broken).toBeNull()
    })
  })

  it('an acknowledgement naming a different hash is refused', async () => {
    const text = readFileSync(MIGRATION, 'utf-8')
    await inRolledBackTx(async (tx) => {
      await purgedHeadWithoutAnchor(tx)
      await tx`SELECT set_config('gremion.audit_chain_adopt_head', ${'0'.repeat(64)}, true)`
      await expect(tx.unsafe(text)).rejects.toThrow(/does not match/)
    })
  })

  it('a chain that still starts at genesis needs no anchor and no acknowledgement', async () => {
    const text = readFileSync(MIGRATION, 'utf-8')
    await inRolledBackTx(async (tx) => {
      for (const v of ['1', '2']) {
        await tx`INSERT INTO audit_log (user_id, field, new_value) VALUES (${actor('u')}, 'upgrade.genesis', ${v})`
      }
      const before = await chainFingerprint(tx)
      await tx.unsafe(text)

      expect(await chainFingerprint(tx)).toBe(before)
      const anchors = await tx`SELECT 1 FROM audit_log_chain_anchor`
      expect(anchors).toHaveLength(0)
      const [v] = await tx<{ broken: string | null }[]>`SELECT audit_log_verify_chain() AS broken`
      expect(v!.broken).toBeNull()
    })
  })
})
