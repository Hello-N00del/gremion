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
// migration `024_audit_log_composite_index.sql` (Cluster 1, G-076).
// That migration is now on master at HEAD; the EXPLAIN assertion lands
// inline here per the brief's "use option (a)" instruction.

import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from './db'
import { writeAuditEntry, readAuditLog, verifyAuditChain } from './audit-db'

describe('G-103 audit-db integration', () => {
  beforeEach(async () => {
    const sql = getDb()
    // Same isolation pattern as audit-retention.integration.test.ts — wipe
    // the table at the start of each test so neighbouring suites' leaked
    // rows don't shift the assertions.
    await sql`TRUNCATE audit_log RESTART IDENTITY CASCADE`
  })

  describe('writeAuditEntry → readAuditLog round-trip', () => {
    it('round-trips a complete audit entry (all fields populated)', async () => {
      await writeAuditEntry({
        userId: 'user-roundtrip',
        field: 'org.name',
        oldValue: 'StuRa Beispieluni',
        newValue: 'StuRa Test',
      })
      const rows = await readAuditLog('org.name')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        userId: 'user-roundtrip',
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
      // (migrations/009_audit_log.sql:7-8). An audit entry recording an
      // initial-config write (no prior value) sets oldValue: null and
      // the row must persist with old_value IS NULL on read.
      await writeAuditEntry({
        userId: 'user-null',
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
        VALUES ('user-direct-null', 'config.x', NULL, 'new')
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
          userId: `user-${i}`,
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
          userId: `u-${i}`,
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
      await sql`INSERT INTO audit_log (created_at, user_id, field, old_value, new_value) VALUES (now() - INTERVAL '30 minutes', 'u-old',  'order.test', 'a', 'b')`
      await sql`INSERT INTO audit_log (created_at, user_id, field, old_value, new_value) VALUES (now() - INTERVAL '10 minutes', 'u-mid',  'order.test', 'a', 'b')`
      await sql`INSERT INTO audit_log (created_at, user_id, field, old_value, new_value) VALUES (now(),                          'u-new',  'order.test', 'a', 'b')`
      const rows = await readAuditLog('order.test')
      expect(rows.map((r) => r.userId)).toEqual(['u-new', 'u-mid', 'u-old'])
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
          VALUES (${'u' + i}, ${i % 5 === 0 ? 'idx.target' : 'idx.other'}, NULL, 'v')
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

// Governance Core INV-1 (tamper-evident record) — migration 043 hash chain.
describe('audit_log hash chain (INV-1)', () => {
  beforeEach(async () => {
    const sql = getDb()
    await sql`TRUNCATE audit_log RESTART IDENTITY`
  })

  it('chains sequential entries and verifies intact', async () => {
    await writeAuditEntry({ userId: 'u1', field: 'committee.create', oldValue: null, newValue: 'A' })
    await writeAuditEntry({ userId: 'u2', field: 'committee.update', oldValue: 'A', newValue: 'B' })

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
    await writeAuditEntry({ userId: 'u1', field: 'x', oldValue: null, newValue: 'orig' })
    await writeAuditEntry({ userId: 'u2', field: 'y', oldValue: null, newValue: 'second' })

    const sql = getDb()
    await sql`UPDATE audit_log SET new_value = 'TAMPERED' WHERE id = 1`

    expect(await verifyAuditChain()).toEqual({ ok: false, brokenAtId: 1 })
  })

  it('detects a mid-chain row deletion (the successor linkage breaks)', async () => {
    await writeAuditEntry({ userId: 'u1', field: 'a', oldValue: null, newValue: '1' })
    await writeAuditEntry({ userId: 'u2', field: 'b', oldValue: null, newValue: '2' })
    await writeAuditEntry({ userId: 'u3', field: 'c', oldValue: null, newValue: '3' })

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
    await writeAuditEntry({ userId: 'u1', field: 'a', oldValue: null, newValue: '1' })
    await writeAuditEntry({ userId: 'u2', field: 'b', oldValue: null, newValue: '2' })
    await writeAuditEntry({ userId: 'u3', field: 'c', oldValue: null, newValue: '3' })

    const sql = getDb()
    await sql`DELETE FROM audit_log WHERE id = (SELECT max(id) FROM audit_log)`

    // The remaining 2-row prefix is still internally consistent → reports ok.
    expect(await verifyAuditChain()).toEqual({ ok: true })
  })
})
