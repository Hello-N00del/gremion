// test/expense.store.test.ts — mocked-PG unit test for the expense read domain
// (#383 R10 scope-forwarding). Mirrors read/expense.ts + dto-map.ts#toExpenseDto:
// the 12-field Expense DTO (id→number, projekt_id 0-when-null, name_suffix/
// zahlung_vwzk = payee_purpose, payed/created/last_change = ISO-Z, rejected only
// when state='rejected', amount_cents = Σ receipt_item.amount_cents), pagination
// meta (per_page=20, last_page=ceil(total/20)), and getExpense's null (→404) +
// 0-sum contract.
//
// R10: listExpenses/getExpense now take a ScopeContext. An auditor sees all; a
// non-auditor is row-scoped to expenses whose finance_unit ∈ scope — listExpenses
// filters the page + total (empty scope → empty page), getExpense 404s (null) an
// out-of-scope-but-EXISTING expense (G-019). DIVERGENCE: scoping goes through
// scopedFinanceUnitIds, which honours seesAllFinance — a superuser-not-auditor
// sees ALL here (unlike bank_account/fints).

import { describe, it, expect } from 'vitest'
import {
  listExpenses,
  getExpense,
  createExpense,
  AccessDeniedError,
  type ScopeContext,
  type ActorContext,
} from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

function queueSql(queue: Array<Array<Record<string, unknown>>>) {
  return (() => Promise.resolve(queue.shift() ?? [])) as unknown as Sql
}

const AUDITOR: ScopeContext = { isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [] }

const ROW = {
  id: '31',
  finance_unit_id: '3',
  project_id: '9',
  payee_name: 'ACME GmbH',
  payee_iban: 'DE12',
  payee_purpose: 'Catering',
  payment_method: 'bank_transfer',
  state: 'paid',
  paid_at: new Date('2026-04-01T10:00:00.000Z'),
  created_at: new Date('2026-03-20T08:00:00.000Z'),
  amount_cents: '4200',
}

describe('expense store — listExpenses (paginated, auditor DTO/meta path)', () => {
  it('maps rows to the 12-field Expense DTO and computes pagination meta', async () => {
    const sql = queueSql([[ROW], [{ c: 25 }]]) // list rows, then count
    const res = await listExpenses(sql, 1, AUDITOR)
    expect(res.meta).toEqual({ current_page: 1, last_page: 2, per_page: 20, total: 25 })
    expect(res.data[0]).toEqual({
      id: 31,
      projekt_id: 9,
      name_suffix: 'Catering',
      state: 'paid',
      zahlung_iban: 'DE12',
      zahlung_name: 'ACME GmbH',
      zahlung_vwzk: 'Catering',
      payed: '2026-04-01T10:00:00.000Z',
      rejected: '',
      created: '2026-03-20T08:00:00.000Z',
      last_change: '2026-03-20T08:00:00.000Z',
      amount_cents: 4200,
    })
  })

  it('projekt_id 0 when project_id is null; rejected timestamp only when state=rejected; amount_cents 0 when null', async () => {
    const sql = queueSql([
      [{ ...ROW, project_id: null, state: 'rejected', paid_at: null, amount_cents: null }],
      [{ c: 1 }],
    ])
    const res = await listExpenses(sql, 1, AUDITOR)
    expect(res.data[0]!.projekt_id).toBe(0)
    expect(res.data[0]!.payed).toBe('')
    expect(res.data[0]!.rejected).toBe('2026-03-20T08:00:00.000Z') // = created_at
    expect(res.data[0]!.amount_cents).toBe(0)
  })

  it('clamps a missing/invalid page to 1', async () => {
    const sql = queueSql([[], [{ c: 0 }]])
    const res = await listExpenses(sql, undefined, AUDITOR)
    expect(res.meta.current_page).toBe(1)
    expect(res.meta.last_page).toBe(1)
  })
})

describe('expense store — getExpense (auditor DTO path)', () => {
  it('returns null when the expense does not exist (→ route 404)', async () => {
    const sql = queueSql([[]])
    expect(await getExpense(sql, 999, AUDITOR)).toBeNull()
  })

  it('returns the ExpenseDetail DTO with amount_cents 0 (detail endpoint does NOT sum receipts)', async () => {
    const sql = queueSql([[{ ...ROW, amount_cents: undefined }]]) // getExpense query has no sum
    const e = await getExpense(sql, 31, AUDITOR)
    expect(e!.id).toBe(31)
    expect(e!.amount_cents).toBe(0)
    expect(e!.zahlung_name).toBe('ACME GmbH')
  })
})

// ── R10 scope fixtures: two org units, one expense each ────────────────────────
const OU_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OU_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OU_BY_FU: Record<string, string> = { '3': OU_A, '4': OU_B }
const EXP_A = { ...ROW, id: '31', finance_unit_id: '3', payee_name: 'A GmbH' } // OU_A
const EXP_B = { ...ROW, id: '32', finance_unit_id: '4', payee_name: 'B GmbH' } // OU_B
const EXP_BY_ID: Record<string, Record<string, unknown>> = { '31': EXP_A, '32': EXP_B }
const ALL_EXP = [EXP_A, EXP_B]

/** Query-aware fake honouring the WHERE scope: scopedFinanceUnitIds (seesAll = no
 *  org_unit filter; scoped = WHERE org_unit_id = ANY), the filtered list + count,
 *  and getExpense by id. Records every issued query. */
function scopeFakeSql() {
  const calls: Array<{ q: string; values: unknown[] }> = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ q, values })
    const scopeArg = values.find((v) => Array.isArray(v)) as string[] | number[] | undefined
    if (/SELECT \* FROM finance\.expense WHERE id/.test(q)) {
      return Promise.resolve(EXP_BY_ID[String(values[0])] ? [EXP_BY_ID[String(values[0])]] : [])
    }
    if (/FROM finance\.finance_unit/.test(q)) {
      if (/WHERE org_unit_id = ANY/.test(q)) {
        const scope = (scopeArg ?? []) as string[]
        return Promise.resolve(
          Object.entries(OU_BY_FU).filter(([, ou]) => scope.includes(ou)).map(([fu]) => ({ id: fu })),
        )
      }
      return Promise.resolve(Object.keys(OU_BY_FU).map((fu) => ({ id: fu }))) // seesAll → all fu ids
    }
    if (/COUNT\(\*\)/.test(q)) {
      const ids = scopeArg as number[] | undefined
      const c = ids ? ALL_EXP.filter((e) => ids.includes(Number(e.finance_unit_id))).length : ALL_EXP.length
      return Promise.resolve([{ c }])
    }
    if (/FROM finance\.expense e/.test(q)) {
      const ids = scopeArg as number[] | undefined
      const rows = ids ? ALL_EXP.filter((e) => ids.includes(Number(e.finance_unit_id))) : ALL_EXP
      return Promise.resolve([...rows].sort((a, b) => Number(b.id) - Number(a.id)))
    }
    return Promise.resolve([])
  }) as unknown as Sql
  return { fn, calls }
}

describe('expense store — listExpenses scope (R10, four lenses + divergence)', () => {
  it('auditor sees ALL expenses with the full total', async () => {
    const { fn } = scopeFakeSql()
    const res = await listExpenses(fn, 1, AUDITOR)
    expect(res.data.map((e) => e.id)).toEqual([32, 31]) // id DESC
    expect(res.meta.total).toBe(2)
  })

  it('scoped non-auditor sees ONLY its org-unit expenses, and total counts only those', async () => {
    const { fn } = scopeFakeSql()
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    const res = await listExpenses(fn, 1, scoped)
    expect(res.data.map((e) => e.id)).toEqual([31]) // only OU_A's expense
    expect(res.meta.total).toBe(1)
  })

  it('empty scope + not see-all → empty page WITHOUT issuing any query (short-circuit)', async () => {
    const { fn, calls } = scopeFakeSql()
    const empty: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [] }
    const res = await listExpenses(fn, 1, empty)
    expect(res.data).toEqual([])
    expect(res.meta).toEqual({ current_page: 1, last_page: 1, per_page: 20, total: 0 })
    expect(calls.length).toBe(0)
  })

  it('DIVERGENCE: superuser-not-auditor SEES ALL expenses (via the see-all finance_unit branch)', async () => {
    const { fn, calls } = scopeFakeSql()
    const superuser: ScopeContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [OU_A] }
    const res = await listExpenses(fn, 1, superuser)
    expect(res.data.map((e) => e.id)).toEqual([32, 31]) // both, not just OU_A
    expect(res.meta.total).toBe(2)
    const fuCall = calls.find((c) => /FROM finance\.finance_unit/.test(c.q))!
    expect(/WHERE org_unit_id = ANY/.test(fuCall.q)).toBe(false) // see-all branch
  })
})

// ── createExpense write (R9 — leaf-local expense write + org-scope gate) ─────────
// Mirrors ExpenseServiceImpl.create + write/access.ts#assertOrgUnitWritable +
// dto-map.ts#toExpenseDetailDto: resolves project → org_unit → finance_unit
// (leaf-local), gates the write on the actor's org-unit write scope (auditor
// refused, superuser bypasses), inserts state='draft'/method='bank_transfer', and
// returns the SAME 12-field ExpenseDetail DTO a subsequent getExpense yields.

const EXP_CREATED_ROW = {
  id: '77',
  finance_unit_id: '3',
  project_id: '9',
  payee_name: 'Neuer Payee GmbH',
  payee_iban: 'DE99',
  payee_purpose: 'Büromaterial',
  payment_method: 'bank_transfer',
  state: 'draft',
  paid_at: null,
  created_at: new Date('2026-05-01T09:30:00.000Z'),
}

/** createExpense issues: (1) SELECT project org_unit_id, (2) SELECT finance_unit
 *  by org_unit, (3) INSERT expense RETURNING *. Queue answers them in order. */
function createFakeSql() {
  return queueSql([
    [{ org_unit_id: OU_A }], // project resolve
    [{ id: '3', org_unit_id: OU_A }], // finance_unit resolve
    [EXP_CREATED_ROW], // INSERT ... RETURNING *
  ])
}

const CREATE_INPUT = {
  projekt_id: 9,
  name_suffix: 'ignored-by-native',
  zahlung_name: 'Neuer Payee GmbH',
  zahlung_iban: 'DE99',
  zahlung_vwzk: 'Büromaterial',
}

describe('expense store — createExpense (R9 write + org-scope gate)', () => {
  const SUPERUSER: ActorContext = {
    userId: 'su', isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [], groups: [],
  }
  const SCOPED_MEMBER: ActorContext = {
    userId: 'm', isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A], groups: [],
  }
  const AUDITOR_ACTOR: ActorContext = {
    userId: 'aud', isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [], groups: [],
  }

  it("inserts state='draft' and returns an ExpenseDetail byte-matching a subsequent getExpense", async () => {
    const created = await createExpense(createFakeSql(), SCOPED_MEMBER, CREATE_INPUT)
    // getExpense on the SAME row (auditor sees all) must be byte-identical.
    const fetched = await getExpense(queueSql([[EXP_CREATED_ROW]]), 77, AUDITOR)
    expect(created).toEqual(fetched)
    expect(created.state).toBe('draft')
    expect(created).toEqual({
      id: 77,
      projekt_id: 9,
      name_suffix: 'Büromaterial',
      state: 'draft',
      zahlung_iban: 'DE99',
      zahlung_name: 'Neuer Payee GmbH',
      zahlung_vwzk: 'Büromaterial',
      payed: '',
      rejected: '',
      created: '2026-05-01T09:30:00.000Z',
      last_change: '2026-05-01T09:30:00.000Z',
      amount_cents: 0,
    })
  })

  it('rejects an auditor with AccessDenied (auditors are read-only)', async () => {
    await expect(createExpense(createFakeSql(), AUDITOR_ACTOR, CREATE_INPUT)).rejects.toBeInstanceOf(
      AccessDeniedError,
    )
  })

  it('bypasses the write gate for a superuser (writes any org unit)', async () => {
    const created = await createExpense(createFakeSql(), SUPERUSER, CREATE_INPUT)
    expect(created.id).toBe(77)
    expect(created.zahlung_name).toBe('Neuer Payee GmbH')
  })

  it('a scoped member OUTSIDE the target org unit is refused (AccessDenied)', async () => {
    const outsider: ActorContext = {
      userId: 'x', isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_B], groups: [],
    }
    await expect(createExpense(createFakeSql(), outsider, CREATE_INPUT)).rejects.toBeInstanceOf(
      AccessDeniedError,
    )
  })
})

describe('expense store — getExpense scope (R10, four lenses + divergence)', () => {
  it('scoped non-auditor sees its own in-scope expense', async () => {
    const { fn } = scopeFakeSql()
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    const e = await getExpense(fn, 31, scoped)
    expect(e!.id).toBe(31)
  })

  it('out-of-scope-but-EXISTING expense → null (G-019 → route 404)', async () => {
    const { fn } = scopeFakeSql()
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    expect(await getExpense(fn, 32, scoped)).toBeNull() // expense 32 → fu 4 (OU_B)
  })

  it('empty scope + not see-all → null even for an existing expense', async () => {
    const { fn } = scopeFakeSql()
    const empty: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [] }
    expect(await getExpense(fn, 31, empty)).toBeNull()
  })

  it('DIVERGENCE: superuser-not-auditor SEES an out-of-scope expense (see-all)', async () => {
    const { fn } = scopeFakeSql()
    const superuser: ScopeContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [OU_A] }
    const e = await getExpense(fn, 32, superuser) // fu 4 (OU_B), NOT in scope
    expect(e!.id).toBe(32) // still visible — superuser sees all here
  })
})
