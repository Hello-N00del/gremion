// test/receipt.store.test.ts — mocked-PG unit test for the receipt read domain
// (#383 R10 scope-forwarding). Mirrors read/receipt.ts + dto-map.ts#toReceiptDto:
// a non-visible parent expense → null (route 404); the lean finance.receipt row (no
// filename/mime_type/nextcloud_path/uploaded_by) → the Receipt DTO with '' / null
// defaults and the timestamptz created_at coerced to ISO-Z.
//
// R10: listReceipts now takes a ScopeContext. Visibility flows from the parent
// expense (read/receipt.ts): null when it does NOT EXIST OR (for a non-auditor) its
// finance_unit is out of scope — the G-019 anti-probing 404 for an out-of-scope-but-
// EXISTING expense. DIVERGENCE: scoping goes through scopedFinanceUnitIds, which
// honours seesAllFinance — a superuser-not-auditor sees ALL here.

import { describe, it, expect } from 'vitest'
import { listReceipts, type ScopeContext } from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

const OU_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OU_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OU_BY_FU: Record<string, string> = { '3': OU_A, '4': OU_B }
// expense 7 → finance_unit 3 (OU_A); expense 8 → finance_unit 4 (OU_B); 999 → absent.
const EXPENSE_FU: Record<string, string> = { '7': '3', '8': '4' }
const RECEIPTS: Record<string, Array<Record<string, unknown>>> = {
  '7': [{ id: '1', expense_id: '7', beleg_nr: 'B-1', beleg_date: '2026-01-05', description: 'Taxi', created_at: new Date('2026-01-05T08:00:00.000Z') }],
  '8': [{ id: '2', expense_id: '8', beleg_nr: 'B-2', beleg_date: '2026-02-05', description: 'Bahn', created_at: new Date('2026-02-05T08:00:00.000Z') }],
}

/** Query-aware fake: expense existence / scopedFinanceUnitIds (seesAll = no WHERE;
 *  scoped = WHERE org_unit_id = ANY) / receipt list, over a two-org-unit fixture. */
function fakeSql() {
  const calls: Array<{ q: string; values: unknown[] }> = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ q, values })
    if (/FROM finance\.expense WHERE id/.test(q)) {
      const id = String(values[0])
      return Promise.resolve(EXPENSE_FU[id] ? [{ id, finance_unit_id: EXPENSE_FU[id] }] : [])
    }
    if (/FROM finance\.finance_unit/.test(q)) {
      if (/WHERE org_unit_id = ANY/.test(q)) {
        const scope = (values[values.length - 1] ?? []) as string[]
        return Promise.resolve(
          Object.entries(OU_BY_FU).filter(([, ou]) => scope.includes(ou)).map(([fu]) => ({ id: fu })),
        )
      }
      return Promise.resolve(Object.keys(OU_BY_FU).map((fu) => ({ id: fu }))) // seesAll → all fu ids
    }
    if (/FROM finance\.receipt WHERE expense_id/.test(q)) {
      return Promise.resolve(RECEIPTS[String(values[0])] ?? [])
    }
    return Promise.resolve([])
  }) as unknown as Sql
  return { fn, calls }
}

const AUDITOR: ScopeContext = { isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [] }

describe('receipt store — listReceipts DTO mapping (auditor path)', () => {
  it('returns null when the expense does not exist (→ route 404)', async () => {
    const { fn } = fakeSql()
    expect(await listReceipts(fn, 999, AUDITOR)).toBeNull()
  })

  it('maps lean finance.receipt rows to the Receipt DTO with defaults for absent fields', async () => {
    const { fn, calls } = fakeSql()
    const rows = await listReceipts(fn, 7, AUDITOR)
    expect(rows).toEqual([
      {
        id: 1,
        expense_id: 7,
        filename: '',
        mime_type: '',
        nextcloud_path: null,
        published_at: null,
        uploaded_by_id: '',
        created_at: '2026-01-05T08:00:00.000Z',
      },
    ])
    expect(typeof rows![0]!.id).toBe('number')
    // auditor fast path issues NO finance_unit scope query.
    expect(calls.some((c) => /FROM finance\.finance_unit/.test(c.q))).toBe(false)
  })
})

describe('receipt store — listReceipts scope (R10, four lenses + divergence)', () => {
  it('scoped non-auditor whose finance_unit owns the expense sees its receipts', async () => {
    const { fn } = fakeSql()
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    const rows = await listReceipts(fn, 7, scoped) // expense 7 → fu 3 (OU_A)
    expect(rows!.map((r) => r.id)).toEqual([1])
  })

  it('out-of-scope-but-EXISTING expense → null (G-019 → route 404)', async () => {
    const { fn } = fakeSql()
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    expect(await listReceipts(fn, 8, scoped)).toBeNull() // expense 8 → fu 4 (OU_B), out of scope
  })

  it('empty scope + not see-all → null (expense exists, scope resolves to no finance_units)', async () => {
    const { fn } = fakeSql()
    const empty: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [] }
    expect(await listReceipts(fn, 7, empty)).toBeNull()
  })

  it('DIVERGENCE: superuser-not-auditor SEES ALL — receipts of an out-of-scope expense are visible', async () => {
    const { fn, calls } = fakeSql()
    const superuser: ScopeContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [OU_A] }
    const rows = await listReceipts(fn, 8, superuser) // expense 8 → fu 4 (OU_B), NOT in scope
    expect(rows!.map((r) => r.id)).toEqual([2]) // still visible — superuser sees all here
    // proves the see-all branch of scopedFinanceUnitIds ran (no org_unit_id filter).
    const fuCall = calls.find((c) => /FROM finance\.finance_unit/.test(c.q))!
    expect(/WHERE org_unit_id = ANY/.test(fuCall.q)).toBe(false)
  })
})
