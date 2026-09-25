// test/budget.store.test.ts — mocked-PG unit test for the budget READ domain
// (#383 Lane B). Mirrors read/budget.ts + dto-map.ts:
//   getBudget      → BudgetPlan[] list DTO ({ id, von, bis, state, groups:[] };
//                    von/bis = fiscal_year.{start,end} DATE → YYYY-MM-DD).
//   getBudgetPlan  → BudgetPlanDetail (nested groups→items; booked = actualsForPlan,
//                    remaining = planned − booked; a group with no titel → items:[]).
//
// Row-scoping mirrors read/budget.ts: an auditor sees all; a non-auditor is scoped
// via scopedFinanceUnitIds (which honours seesAllFinance) — getBudget filters the list
// (DISTINCT over budget_section.finance_unit_id ∈ scope; empty scope → []), getBudgetPlan
// 404s (null) an out-of-scope-but-EXISTING plan (G-019). DIVERGENCE: a superuser-not-
// auditor SEES ALL here (scopedFinanceUnitIds see-all branch), like expense/receipt.

import { describe, it, expect } from 'vitest'
import { getBudget, getBudgetPlan, type ScopeContext } from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

/** FIFO fake postgres-js: each tagged-template query returns the next queued rows
 *  (queries run in a deterministic order); records the SQL text so a test can prove
 *  which code path (auditor vs scoped DISTINCT vs see-all) ran. */
function recordSql(queue: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ q: string; values: unknown[] }> = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ q: strings.join('?').replace(/\s+/g, ' ').trim(), values })
    return Promise.resolve(queue.shift() ?? [])
  }) as unknown as Sql
  return { fn, calls }
}

const AUDITOR: ScopeContext = { isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [] }
const OU_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OU_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const PLAN_A = {
  id: '1', name: 'HH A', state: 'draft', fiscal_year_id: '9',
  approved_by: null, approved_at: null,
  fy_name: 'HH 2026', fy_start: new Date('2026-01-01T00:00:00.000Z'), fy_end: new Date('2026-12-31T00:00:00.000Z'),
}
const PLAN_B = { ...PLAN_A, id: '2', name: 'HH B' }

describe('budget store — getBudget (auditor DTO/date-coercion path)', () => {
  it('maps a plan row to the BudgetPlan list DTO ({id,von,bis,state,groups:[]})', async () => {
    const { fn } = recordSql([[PLAN_A]])
    const res = await getBudget(fn, AUDITOR)
    expect(res[0]).toEqual({ id: 1, von: '2026-01-01', bis: '2026-12-31', state: 'draft', groups: [] })
    expect(typeof res[0]!.id).toBe('number')
  })
})

describe('budget store — getBudget row-scoping (Lane B, four lenses + divergence)', () => {
  it('auditor sees ALL plans (no section-scope filter)', async () => {
    const { fn } = recordSql([[PLAN_A, PLAN_B]])
    const res = await getBudget(fn, AUDITOR)
    expect(res.map((p) => p.id)).toEqual([1, 2])
  })

  it('scoped non-auditor sees ONLY its section-scoped plans (DISTINCT via budget_section)', async () => {
    const { fn, calls } = recordSql([[{ id: '3' }], [PLAN_A]])
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    const res = await getBudget(fn, scoped)
    expect(res.map((p) => p.id)).toEqual([1])
    // scopedFinanceUnitIds ran the org-unit-filtered finance_unit query …
    expect(calls[0]!.q).toMatch(/FROM finance\.finance_unit/)
    expect(calls[0]!.q).toMatch(/WHERE org_unit_id = ANY/)
    // … then the DISTINCT plan query joined budget_section on the forwarded fu ids.
    expect(calls[1]!.q).toMatch(/DISTINCT/)
    expect(calls[1]!.q).toMatch(/JOIN finance\.budget_section/)
    expect(calls[1]!.values.at(-1)).toEqual([3])
  })

  it('empty scope + not see-all → [] WITHOUT issuing any query (short-circuit)', async () => {
    const { fn, calls } = recordSql([])
    const empty: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [] }
    expect(await getBudget(fn, empty)).toEqual([])
    expect(calls.length).toBe(0)
  })

  it('DIVERGENCE: superuser-not-auditor SEES ALL plans (see-all finance_unit branch)', async () => {
    const { fn, calls } = recordSql([[{ id: '3' }, { id: '4' }], [PLAN_A, PLAN_B]])
    const superuser: ScopeContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [OU_A] }
    const res = await getBudget(fn, superuser)
    expect(res.map((p) => p.id)).toEqual([1, 2]) // both, not just OU_A's
    const fuCall = calls.find((c) => /FROM finance\.finance_unit/.test(c.q))!
    expect(/WHERE org_unit_id = ANY/.test(fuCall.q)).toBe(false) // see-all branch
  })
})

// ── getBudgetPlan detail projection ──────────────────────────────────────────
const GROUPS = [{ id: '11', name: 'Einnahmen', budget_type: 'income', budget_section_id: '21' }]
const TITEL = [{ id: '101', budget_group_id: '11', titel_nr: '1.1', titel_name: 'Beiträge', planned_cents: '10000' }]
const ACTUALS = [{ budget_titel_id: '101', booked: '3000' }]

describe('budget store — getBudgetPlan (detail projection + actuals)', () => {
  it('projects nested groups→items with booked=actuals, remaining=planned−booked', async () => {
    const { fn } = recordSql([[PLAN_A], GROUPS, TITEL, ACTUALS])
    const res = await getBudgetPlan(fn, 1, AUDITOR)
    expect(res).toEqual({
      id: 1,
      name: 'HH A',
      von: '2026-01-01',
      bis: '2026-12-31',
      state: 'draft',
      fiscal_year_id: 9,
      approved_by: null,
      approved_at: null,
      groups: [
        {
          id: 11,
          name: 'Einnahmen',
          budget_type: 'income',
          items: [{ id: 101, titel_nr: '1.1', titel_name: 'Beiträge', value: 10000, booked: 3000, remaining: 7000 }],
        },
      ],
    })
  })

  it('a group with no titel → items:[] (empty-group array)', async () => {
    const twoGroups = [
      { id: '11', name: 'Einnahmen', budget_type: 'income', budget_section_id: '21' },
      { id: '12', name: 'Ausgaben', budget_type: 'expense', budget_section_id: '21' },
    ]
    const { fn } = recordSql([[PLAN_A], twoGroups, TITEL, ACTUALS])
    const res = await getBudgetPlan(fn, 1, AUDITOR)
    expect(res!.groups[1]).toEqual({ id: 12, name: 'Ausgaben', budget_type: 'expense', items: [] })
  })

  it('returns null when the plan does not exist (→ route 404)', async () => {
    const { fn } = recordSql([[]])
    expect(await getBudgetPlan(fn, 999, AUDITOR)).toBeNull()
  })

  it('out-of-scope-but-EXISTING plan → null (G-019 → route 404)', async () => {
    // planRows found, but the scoped visibility EXISTS check fails.
    const { fn } = recordSql([[PLAN_A], [{ id: '99' }], [{ exists: false }]])
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_B] }
    expect(await getBudgetPlan(fn, 1, scoped)).toBeNull()
  })

  it('scoped in-scope plan resolves (visibility EXISTS true)', async () => {
    const { fn } = recordSql([[PLAN_A], [{ id: '3' }], [{ exists: true }], GROUPS, TITEL, ACTUALS])
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    const res = await getBudgetPlan(fn, 1, scoped)
    expect(res!.id).toBe(1)
  })

  it('DIVERGENCE: superuser-not-auditor resolves an out-of-scope plan (see-all)', async () => {
    // scopedFinanceUnitIds see-all → EXISTS passes for any plan with a section.
    const { fn } = recordSql([[PLAN_B], [{ id: '3' }, { id: '4' }], [{ exists: true }], GROUPS, TITEL, ACTUALS])
    const superuser: ScopeContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [OU_A] }
    const res = await getBudgetPlan(fn, 2, superuser)
    expect(res!.id).toBe(2)
  })
})

// ── #410 FIN-3: booked aggregation sign convention ────────────────────────────
// booking.amount_cents is bank-signed (expense bookings NEGATIVE, income
// POSITIVE) while the DTO's `booked` is budget-consumption cents (positive =
// consumed). The actuals SUM must flip the sign per budget_type — and must NOT
// use ABS, which would turn a struck(-X)+rebooked(+Y) correction pair into
// |X|+|Y| instead of netting it. The aggregation itself runs in Postgres, so
// the sign expression is pinned on the recorded SQL text; the DTO cases pin the
// downstream projection of the (now positively-signed) actuals.
describe('budget store — actualsForPlan sign convention (#410 FIN-3)', () => {
  it('sums with a budget_type-aware sign (income raw, expense negated) — never ABS', async () => {
    const { fn, calls } = recordSql([[PLAN_A], GROUPS, TITEL, ACTUALS])
    await getBudgetPlan(fn, 1, AUDITOR)
    const actualsCall = calls.find((c) => /FROM finance\.booking b/.test(c.q))
    expect(actualsCall).toBeDefined()
    expect(actualsCall!.q).toContain(
      "SUM(CASE WHEN bg.budget_type = 'income' THEN b.amount_cents ELSE -b.amount_cents END)::text AS booked"
    )
    expect(actualsCall!.q).not.toMatch(/ABS\s*\(/i)
  })

  it('an expense Titel with a -95000 posted booking projects booked=+95000, remaining=planned−booked', async () => {
    // The sign-aware SUM yields +95000 for the single -95000 expense booking
    // (old raw SUM returned -95000 → booked negative, remaining inflated).
    const expenseGroups = [{ id: '12', name: 'Ausgaben', budget_type: 'expense', budget_section_id: '21' }]
    const expenseTitel = [{ id: '102', budget_group_id: '12', titel_nr: '2.1', titel_name: 'Erstifahrt', planned_cents: '200000' }]
    const actuals = [{ budget_titel_id: '102', booked: '95000' }]
    const { fn } = recordSql([[PLAN_A], expenseGroups, expenseTitel, actuals])
    const res = await getBudgetPlan(fn, 1, AUDITOR)
    expect(res!.groups[0]!.items[0]).toMatchObject({ booked: 95000, remaining: 105000 })
  })

  it('an income Titel keeps its raw positive sum (unchanged)', async () => {
    const { fn } = recordSql([[PLAN_A], GROUPS, TITEL, ACTUALS])
    const res = await getBudgetPlan(fn, 1, AUDITOR)
    expect(res!.groups[0]!.items[0]).toMatchObject({ booked: 3000, remaining: 7000 })
  })
})
