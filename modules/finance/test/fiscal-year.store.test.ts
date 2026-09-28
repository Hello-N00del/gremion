// test/fiscal-year.store.test.ts — mocked-PG unit test for the fiscal_year
// domain store functions (#383 finance-leaf gap-close). Asserts the store
// coerces a raw finance.fiscal_year row into the EXACT FiscalYear DTO the
// ServiceFinanceClient casts to: BIGINT id → number, DATE → 'YYYY-MM-DD'
// (the frozen contract shape — see gremion-ui/.../read/dto-map.ts#toFiscalYearDto),
// and enforces the end>start validation + the update not-found (null) contract.
// The real ephemeral-PG round-trip is in api.integration.test.ts.

import { describe, it, expect } from 'vitest'
import {
  listFiscalYears,
  createFiscalYear,
  updateFiscalYear,
  FinanceValidationError,
} from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

/** A fake postgres-js Sql whose tagged-template calls return, in order, the
 *  canned result-sets from `queue`; `.begin(cb)` runs the callback with the
 *  same fake (so a store fn's transaction body sees the same queue). */
function fakeSql(queue: Array<Array<Record<string, unknown>>>) {
  const fn = ((..._args: unknown[]) => Promise.resolve(queue.shift() ?? [])) as unknown as {
    (...args: unknown[]): Promise<unknown[]>
    begin: (cb: (tx: unknown) => unknown) => Promise<unknown>
  }
  fn.begin = async (cb: (tx: unknown) => unknown) => cb(fn)
  return fn as unknown as Sql
}

describe('fiscal_year store — listFiscalYears', () => {
  it('coerces BIGINT id → number and DATE → YYYY-MM-DD (exact FiscalYear DTO)', async () => {
    const sql = fakeSql([
      [
        { id: '3', name: 'HH 2025', start_date: '2025-01-01', end_date: '2025-12-31' },
        { id: '4', name: 'HH 2026', start_date: '2026-01-01', end_date: '2026-12-31' },
      ],
    ])
    const rows = await listFiscalYears(sql)
    expect(rows).toEqual([
      { id: 3, name: 'HH 2025', start_date: '2025-01-01', end_date: '2025-12-31' },
      { id: 4, name: 'HH 2026', start_date: '2026-01-01', end_date: '2026-12-31' },
    ])
    // id must be a JS number, not the raw BIGINT string.
    expect(typeof rows[0]!.id).toBe('number')
  })

  it('coerces a Date-typed DATE column to YYYY-MM-DD (defensive path)', async () => {
    const sql = fakeSql([[{ id: 7, name: 'HH', start_date: new Date('2026-01-01T00:00:00Z'), end_date: new Date('2026-12-31T00:00:00Z') }]])
    const rows = await listFiscalYears(sql)
    expect(rows[0]).toEqual({ id: 7, name: 'HH', start_date: '2026-01-01', end_date: '2026-12-31' })
  })
})

describe('fiscal_year store — createFiscalYear', () => {
  it('returns the inserted FiscalYear DTO (id→number, YYYY-MM-DD dates)', async () => {
    const sql = fakeSql([[{ id: '9', name: 'HH 2027', start_date: '2027-01-01', end_date: '2027-12-31' }]])
    const fy = await createFiscalYear(sql, { name: 'HH 2027', startDate: '2027-01-01', endDate: '2027-12-31' })
    expect(fy).toEqual({ id: 9, name: 'HH 2027', start_date: '2027-01-01', end_date: '2027-12-31' })
  })

  it('rejects a degenerate year (end <= start) with a FinanceValidationError before any INSERT', async () => {
    const sql = fakeSql([]) // no INSERT result should ever be consumed
    await expect(
      createFiscalYear(sql, { name: 'Bad', startDate: '2027-12-31', endDate: '2027-01-01' }),
    ).rejects.toBeInstanceOf(FinanceValidationError)
    await expect(
      createFiscalYear(sql, { name: 'Equal', startDate: '2027-06-01', endDate: '2027-06-01' }),
    ).rejects.toBeInstanceOf(FinanceValidationError)
  })
})

describe('fiscal_year store — updateFiscalYear', () => {
  it('returns null when the id does not exist (→ route 404)', async () => {
    const sql = fakeSql([[]]) // SELECT ... FOR UPDATE returns no rows
    const res = await updateFiscalYear(sql, 999, { name: 'x' })
    expect(res).toBeNull()
  })

  it('patches only provided keys and returns the refreshed DTO', async () => {
    const sql = fakeSql([
      [{ id: '5', name: 'Old', start_date: '2026-01-01', end_date: '2026-12-31' }], // current (FOR UPDATE)
      [{ id: '5', name: 'New', start_date: '2026-01-01', end_date: '2026-12-31' }], // UPDATE RETURNING
    ])
    const res = await updateFiscalYear(sql, 5, { name: 'New' })
    expect(res).toEqual({ id: 5, name: 'New', start_date: '2026-01-01', end_date: '2026-12-31' })
  })

  it('re-validates end>start against the merged (current+patch) dates', async () => {
    const sql = fakeSql([
      [{ id: '5', name: 'Old', start_date: '2026-01-01', end_date: '2026-12-31' }], // current
    ])
    // Patch only end_date to before the existing start → must reject.
    await expect(updateFiscalYear(sql, 5, { endDate: '2025-01-01' })).rejects.toBeInstanceOf(FinanceValidationError)
  })
})
