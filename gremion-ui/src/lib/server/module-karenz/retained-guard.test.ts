// Module Karenz (phase 2, JOIN-2 fix 7): the write path of the sealed retained copies
// refuses to write unless the append-only guard of migration 0064 is in place, and
// checks that once per process. A tenant that was provisioned before the guard existed
// has retained_record writable by the app role until reconcile revokes it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sql } from '@gremion/db'
import {
  RetainedGuardError,
  assertRetainedAppendOnly,
  insertDataKey,
  insertRetainedRecord,
  resetRetainedGuardCache,
  rewrapDataKey,
  type RetainedRecordInsert,
} from './retained-guard'

interface Probe {
  present?: boolean
  update?: boolean
  del?: boolean
  truncate?: boolean
  keyGuard?: boolean
}

/** A fake tenant pool: every statement is recorded, the guard probe answers from `probe`. */
function fakeDb(probe: Probe, database = 'tenant_a') {
  const statements: string[] = []
  const p = { present: true, update: false, del: false, truncate: false, keyGuard: true, ...probe }
  const db = Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join('?')
      statements.push(text)
      if (/has_any_column_privilege/.test(text)) {
        return [{ present: p.present, can_update: p.update, can_delete: p.del, can_truncate: p.truncate, key_guard: p.keyGuard }]
      }
      if (/INSERT INTO karenz_data_key/.test(text)) return [{ key_id: 'k1' }]
      if (/INSERT INTO retained_record/.test(text)) return [{ id: 'r1' }]
      if (/karenz_rewrap_data_key/.test(text)) return [{ ok: true }]
      throw new Error(`unexpected statement: ${text}`)
    },
    { options: { database, user: 'app' } },
  )
  return { db: db as unknown as Sql, p, statements, probes: () => statements.filter((s) => /has_any_column_privilege/.test(s)).length }
}

const record: RetainedRecordInsert = {
  karenzId: '0192f3e0-1a2b-7c3d-8e4f-0123456789ab',
  catalogueId: 'votes',
  retentionClass: 'RC-VOTE',
  extractorId: 'votes.polls',
  lineCount: 1,
  plaintextSha256: 'a'.repeat(64),
  keyId: '0192f3e0-1a2b-7c3d-8e4f-0123456789ac',
  nonce: Buffer.alloc(12),
  ciphertext: Buffer.from('sealed'),
  subjectRefs: [],
  holdUntil: null,
}

beforeEach(() => resetRetainedGuardCache())

describe('assertRetainedAppendOnly', () => {
  it('refuses while the app role can still UPDATE, DELETE or TRUNCATE retained_record, and names every privilege held', async () => {
    const { db } = fakeDb({ update: true, del: true, truncate: true })
    const err = await assertRetainedAppendOnly(db).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RetainedGuardError)
    expect((err as RetainedGuardError).problems).toEqual([
      'retained_record: the role can still UPDATE',
      'retained_record: the role can still DELETE',
      'retained_record: the role can still TRUNCATE',
    ])
    expect((err as Error).message).toMatch(/retained_record/)
    expect((err as Error).message).toMatch(/reconcile/)
  })

  it('refuses when the key-row guard trigger of karenz_data_key is missing or disabled', async () => {
    const { db } = fakeDb({ keyGuard: false })
    const err = (await assertRetainedAppendOnly(db).catch((e: unknown) => e)) as RetainedGuardError
    expect(err).toBeInstanceOf(RetainedGuardError)
    expect(err.problems).toEqual(['karenz_data_key: the row guard trigger karenz_data_key_guard_trg is missing or disabled'])
  })

  it('refuses when retained_record does not exist (the migration has not run)', async () => {
    const { db } = fakeDb({ present: false })
    const err = (await assertRetainedAppendOnly(db).catch((e: unknown) => e)) as RetainedGuardError
    expect(err.problems).toEqual(['retained_record: the table does not exist (migration 0064 has not run)'])
  })

  it('checks once per process: a passing check is not repeated for the same database and role', async () => {
    const { db, probes } = fakeDb({})
    await assertRetainedAppendOnly(db)
    await assertRetainedAppendOnly(db)
    await assertRetainedAppendOnly(db)
    expect(probes()).toBe(1)
  })

  it('a failed check is not cached: reconcile fixes the tenant and the next write goes through', async () => {
    const { db, probes, p } = fakeDb({ update: true })
    await expect(assertRetainedAppendOnly(db)).rejects.toBeInstanceOf(RetainedGuardError)
    p.update = false
    await expect(assertRetainedAppendOnly(db)).resolves.toBeUndefined()
    expect(probes()).toBe(2)
  })

  it('concurrent first writes share one probe', async () => {
    const { db, probes } = fakeDb({})
    await Promise.all([assertRetainedAppendOnly(db), assertRetainedAppendOnly(db), assertRetainedAppendOnly(db)])
    expect(probes()).toBe(1)
  })
})

describe('the guarded write path', () => {
  it('insertRetainedRecord and insertDataKey write nothing while the guard is missing', async () => {
    const { db, statements } = fakeDb({ update: true })
    await expect(insertRetainedRecord(db, record)).rejects.toBeInstanceOf(RetainedGuardError)
    await expect(insertDataKey(db, Buffer.from('w'))).rejects.toBeInstanceOf(RetainedGuardError)
    expect(statements.filter((s) => /INSERT INTO/.test(s))).toEqual([])
  })

  it('with the guard in place they write, and rewrapDataKey calls the re-wrap function', async () => {
    const { db, statements } = fakeDb({})
    expect(await insertDataKey(db, Buffer.from('w'))).toBe('k1')
    expect(await insertRetainedRecord(db, record)).toBe('r1')
    expect(await rewrapDataKey(db, 'k1', 1, Buffer.from('w2'))).toBe(true)
    expect(statements.some((s) => /karenz_rewrap_data_key/.test(s))).toBe(true)
    // a bare UPDATE of karenz_data_key never appears in this module
    expect(statements.some((s) => /UPDATE\s+karenz_data_key/i.test(s))).toBe(false)
  })

  it('an injected guard replaces the probe (test seam for suites that run as a superuser)', async () => {
    const { db, probes } = fakeDb({ update: true })
    const guard = vi.fn(async () => {})
    expect(await insertRetainedRecord(db, record, { guard })).toBe('r1')
    expect(guard).toHaveBeenCalledTimes(1)
    expect(probes()).toBe(0)
  })
})
