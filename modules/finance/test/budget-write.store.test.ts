// test/budget-write.store.test.ts — mocked-PG unit test for the budget WRITE domain
// (#383 Lane D). Mirrors services/write/budget.ts + the write facade's DTO assembly
// (services/write/index.ts). Asserts the EXACT DTO shapes + coercions the ACL client
// expects (BIGINT→number, planned_cents→value cents, TIMESTAMPTZ→ISO-Z, DATE→YYYY-MM-DD)
// AND the two behaviours the task pins:
//   * write-scope 403 (AccessDeniedError) — a non-superuser out of the central scope
//   * invalid-transition (FinanceStateError) — activateBudget on a non-approved plan
//   * the FACADE ACTUALS QUIRK — createBudgetPlan/updateBudgetPlan ship booked=0
//     (empty actuals map); activateBudget/assignBudgetFiscalYear ship REAL actuals.

import { describe, it, expect } from 'vitest'
import {
  createBudgetPlan,
  updateBudgetPlan,
  createBudgetGroup,
  updateBudgetGroup,
  deleteBudgetGroup,
  createBudgetItem,
  updateBudgetItem,
  deleteBudgetItem,
  activateBudget,
  assignBudgetFiscalYear,
  closeBudget,
  AccessDeniedError,
  FinanceValidationError,
  FinanceStateError,
  type ActorContext,
} from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

/** FIFO fake postgres-js with .begin: each tagged-template query shifts the next queued
 *  rows; .begin runs the callback against the same fake. Records SQL text for assertions. */
function recordSql(queue: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ q: string; values: unknown[] }> = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ q: strings.join('?').replace(/\s+/g, ' ').trim(), values })
    return Promise.resolve(queue.shift() ?? [])
  }) as unknown as Sql
  ;(fn as unknown as { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }).begin = async (
    cb: (tx: unknown) => unknown,
  ) => cb(fn)
  return { fn, calls }
}

const SUPER: ActorContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [], userId: 'pres', groups: [] }
const DENIED: ActorContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [], userId: 'u', groups: [] }

const CENTRAL = { id: '1', org_unit_id: 'central-ou' }
const PLAN_ROW = {
  id: '5', name: 'HH 9', state: 'draft', fiscal_year_id: '9', approved_by: null, approved_at: null,
  fy_name: 'HH 2026', fy_start: new Date('2026-01-01T00:00:00.000Z'), fy_end: new Date('2026-12-31T00:00:00.000Z'),
}
const GROUP = { id: '11', name: 'Einnahmen', budget_type: 'income', budget_section_id: '21' }
const TITEL = { id: '101', budget_group_id: '11', titel_nr: '1.1', titel_name: 'Beiträge', planned_cents: '10000' }
const ACTUALS = { budget_titel_id: '101', booked: '3000' }

describe('budget-write store — createBudgetPlan', () => {
  it('inserts a draft plan and returns the BudgetPlanDetail (empty groups, id→number, DATE→YYYY-MM-DD)', async () => {
    const { fn } = recordSql([[CENTRAL], [{ id: '5' }], [PLAN_ROW], [], []])
    const res = await createBudgetPlan(fn, SUPER, { fiscalYearId: 9 })
    expect(res).toEqual({
      id: 5, name: 'HH 9', von: '2026-01-01', bis: '2026-12-31', state: 'draft',
      fiscal_year_id: 9, approved_by: null, approved_at: null, groups: [],
    })
    expect(typeof res.id).toBe('number')
  })

  it('write-scope 403: a non-superuser out of the central org-unit scope → AccessDeniedError', async () => {
    const { fn } = recordSql([[CENTRAL]])
    await expect(createBudgetPlan(fn, DENIED, { fiscalYearId: 9 })).rejects.toBeInstanceOf(AccessDeniedError)
  })
})

describe('budget-write store — updateBudgetPlan', () => {
  it('renames the plan; re-read detail ships booked=0 (facade EMPTY-actuals quirk)', async () => {
    // exists, central, UPDATE(name), then assemble plan/groups/titel — NO actuals query.
    const { fn, calls } = recordSql([[{ id: '5' }], [CENTRAL], [], [PLAN_ROW], [GROUP], [TITEL]])
    const res = await updateBudgetPlan(fn, SUPER, 5, { name: 'Renamed' })
    expect(res!.groups[0]!.items[0]).toEqual({
      id: 101, titel_nr: '1.1', titel_name: 'Beiträge', value: 10000, booked: 0, remaining: 10000,
    })
    // No actualsForPlan query ran (createBudgetPlan/updateBudgetPlan ship an empty map).
    // Pin on the FROM clause, not the aggregate expression — the aggregate was
    // rewritten to a budget_type CASE (#410 FIN-3) and a stale regex here would
    // make this "no actuals query ran" guard vacuously green.
    expect(calls.some((c) => /FROM finance\.booking/.test(c.q))).toBe(false)
  })

  it('returns null (→404) when the plan does not exist', async () => {
    const { fn } = recordSql([[]])
    expect(await updateBudgetPlan(fn, SUPER, 999, { name: 'x' })).toBeNull()
  })
})

describe('budget-write store — groups', () => {
  it('createBudgetGroup returns BudgetGroupDetail with items:[]', async () => {
    const { fn } = recordSql([[CENTRAL], [{ id: '21' }], [{ id: '11', name: 'Einnahmen', budget_type: 'income' }]])
    const res = await createBudgetGroup(fn, SUPER, 5, { name: 'Einnahmen', budget_type: 'income' })
    expect(res).toEqual({ id: 11, name: 'Einnahmen', budget_type: 'income', items: [] })
  })

  it('createBudgetGroup rejects an invalid budget_type with FinanceValidationError (→400)', async () => {
    const { fn } = recordSql([])
    await expect(createBudgetGroup(fn, SUPER, 5, { name: 'x', budget_type: 'bad' })).rejects.toBeInstanceOf(
      FinanceValidationError,
    )
  })

  it('updateBudgetGroup returns null (→404) when the group is absent', async () => {
    const { fn } = recordSql([[]])
    expect(await updateBudgetGroup(fn, SUPER, 999, { name: 'x' })).toBeNull()
  })

  it('deleteBudgetGroup is idempotent (missing group → void, no throw)', async () => {
    const { fn } = recordSql([[]])
    await expect(deleteBudgetGroup(fn, SUPER, 999)).resolves.toBeUndefined()
  })
})

describe('budget-write store — items', () => {
  it('createBudgetItem returns BudgetItem with value=planned, booked=0, remaining=value', async () => {
    const { fn } = recordSql([[{ org_unit_id: 'central-ou' }], [TITEL]])
    const res = await createBudgetItem(fn, SUPER, 11, { titel_nr: '1.1', titel_name: 'Beiträge', value: 10000 })
    expect(res).toEqual({ id: 101, titel_nr: '1.1', titel_name: 'Beiträge', value: 10000, booked: 0, remaining: 10000 })
  })

  it('createBudgetItem returns null (→404) when the group is absent', async () => {
    const { fn } = recordSql([[]])
    expect(await createBudgetItem(fn, SUPER, 999, { titel_nr: '', titel_name: 'x', value: 1 })).toBeNull()
  })

  it('updateBudgetItem returns null (→404) when the titel is absent', async () => {
    const { fn } = recordSql([[]])
    expect(await updateBudgetItem(fn, SUPER, 999, { titel_name: 'x' })).toBeNull()
  })

  it('deleteBudgetItem is idempotent (missing titel → void)', async () => {
    const { fn } = recordSql([[]])
    await expect(deleteBudgetItem(fn, SUPER, 999)).resolves.toBeUndefined()
  })
})

describe('budget-write store — lifecycle', () => {
  it('activateBudget on a non-approved plan → FinanceStateError (→409 invalid transition)', async () => {
    const { fn } = recordSql([[{ id: '5', state: 'draft' }], [CENTRAL]])
    await expect(activateBudget(fn, SUPER, 5)).rejects.toBeInstanceOf(FinanceStateError)
  })

  it('activateBudget approved→active returns detail with REAL actuals (booked=3000, remaining=7000)', async () => {
    const { fn } = recordSql([
      [{ id: '5', state: 'approved' }], [CENTRAL], [], // select-for-update, central, UPDATE
      [{ ...PLAN_ROW, state: 'active' }], [GROUP], [TITEL], [ACTUALS], // assemble WITH actuals
    ])
    const res = await activateBudget(fn, SUPER, 5)
    expect(res!.state).toBe('active')
    expect(res!.groups[0]!.items[0]).toEqual({
      id: 101, titel_nr: '1.1', titel_name: 'Beiträge', value: 10000, booked: 3000, remaining: 7000,
    })
  })

  it('activateBudget returns null (→404) when the plan is absent', async () => {
    const { fn } = recordSql([[]])
    expect(await activateBudget(fn, SUPER, 999)).toBeNull()
  })

  it('assignBudgetFiscalYear rejects a null fiscal year with FinanceValidationError (→400)', async () => {
    const { fn } = recordSql([])
    await expect(assignBudgetFiscalYear(fn, SUPER, 5, null)).rejects.toBeInstanceOf(FinanceValidationError)
  })

  it('assignBudgetFiscalYear re-points the plan and returns detail with REAL actuals', async () => {
    const { fn } = recordSql([
      [{ id: '5' }], [CENTRAL], [], // select-for-update, central, UPDATE
      [PLAN_ROW], [GROUP], [TITEL], [ACTUALS], // assemble WITH actuals
    ])
    const res = await assignBudgetFiscalYear(fn, SUPER, 5, 9)
    expect(res!.fiscal_year_id).toBe(9)
    expect(res!.groups[0]!.items[0]!.booked).toBe(3000)
  })
})

// ── closeBudget (#383 / FIN-52 — the WP-YearEnd Jahresabschluss, ported leaf-local) ──
// The 52nd/final finance op. Mirrors services/yearend/service.ts#closePlan composed
// leaf-local: load+lock the plan, §11 central write-scope gate, §4.1 active→closed edge,
// compose the statement (fy / section / unit / titel-actuals / inventar), persist it as
// budget_plan.statement jsonb, apply the reserve deltas (surplus → frei/betriebsmittel;
// deficit → cascade) + retention markers, flip state→closed (+ closed_at), then re-read
// through getBudgetStatement so the returned Statement IS the persisted jsonb round-tripped.
const FY_ROW = { id: '9', name: 'HH 2026', end_date: new Date('2026-12-31T00:00:00.000Z') }
const SECTION_ROW = { finance_unit_id: '1' }
const UNIT_ROW = { id: '1', org_unit_id: 'central-ou' }
const CLOSE_TITEL = { id: '101', planned_cents: '10000' }
const CLOSE_ACTUALS = { budget_titel_id: '101', booked: '3000' }
const INVENTAR_ROW = { inventory_no: 'INV-1', acquisition_value_cents: '50000', disposed_at: null }
const PROFILE_ROW = {
  reserve_frei_bound: 'ceiling', reserve_frei_amount_cents: '0',
  reserve_betriebsmittel_amount_cents: '0', reserve_zweckgebunden_amount_cents: '0',
  retention_years: 10, retention_from: 'fiscal_year_end',
}
// The persisted statement as read back by getBudgetStatement (state='closed' branch);
// in a live DB this IS the composed jsonb — here it is a fixed fixture the re-read yields.
const CLOSED_STMT_JSONB = {
  meta: {
    fiscal_year_id: 9, fiscal_year_name: 'HH 2026', budget_plan_id: 5,
    finance_unit_name: 'HH 9', generated_at: '2026-07-21T09:00:00.000Z',
  },
  titel_actuals: [{ budget_titel_id: 101, ansatz_cents: 10000, ist_cents: 3000, diff_cents: -7000 }],
  carry_over: { carry_amount_cents: 0, reserve_delta_cents: -7000 },
  reserve_deltas: [],
  inventar: {
    fy_end: '2026-12-31T00:00:00.000Z',
    items: [{ inventory_no: 'INV-1', acquisition_value_cents: 50000, disposed_at: null }],
    total_value_cents: 50000,
  },
  kassenbestand_reconciliation: { opening_cents: 0, closing_cents: 0, diff_cents: 0 },
}
const CLOSED_PLAN_REREAD = {
  id: '5', name: 'HH 9', state: 'closed', statement: CLOSED_STMT_JSONB,
  closed_at: new Date('2026-07-21T09:00:00.000Z'),
}

describe('budget-write store — closeBudget (year-end)', () => {
  it('active→closed composes+persists the statement, applies reserves+retention, sets closed_at, returns the re-read Statement', async () => {
    const { fn, calls } = recordSql([
      [{ id: '5', fiscal_year_id: '9', name: 'HH 9', state: 'active' }], // 1 plan FOR UPDATE
      [CENTRAL], // 2 findCentral (write-scope gate)
      [FY_ROW], // 3 fiscal_year
      [SECTION_ROW], // 4 central budget_section
      [UNIT_ROW], // 5 finance_unit
      [CLOSE_TITEL], // 6 titel
      [CLOSE_ACTUALS], // 7 actualsForPlan
      [INVENTAR_ROW], // 8 inventar (org_unit_mirror subtree)
      [], // 9 persist UPDATE statement
      [PROFILE_ROW], // 10 loadProfile
      [], // 11 applyReserveDeltas (frei += surplus)
      [], // 12 discharge lookup (none)
      [], // 13 markRetention UPDATE booking
      [], // 14 state flip UPDATE (closed + closed_at)
      [CLOSED_PLAN_REREAD], // 15 getBudgetStatement re-read plan
      [{ id: '1' }], // 16 scopedFinanceUnitIds (superuser see-all)
      [{ exists: true }], // 17 visibility EXISTS
    ])
    const res = await closeBudget(fn, SUPER, 5)

    // (a) the composed statement was persisted as JSON on budget_plan.statement.
    const persist = calls.find((c) => /UPDATE finance\.budget_plan SET statement =/.test(c.q))
    expect(persist).toBeDefined()
    const persisted = JSON.parse(persist!.values[0] as string)
    expect(typeof persisted.meta.generated_at).toBe('string')
    expect(persisted.titel_actuals[0]).toEqual({
      budget_titel_id: 101, ansatz_cents: 10000, ist_cents: 3000, diff_cents: -7000,
    })
    expect(persisted.carry_over).toEqual({ carry_amount_cents: 0, reserve_delta_cents: -7000 })
    expect(persisted.inventar.total_value_cents).toBe(50000)
    expect(persisted.kassenbestand_reconciliation).toEqual({ opening_cents: 0, closing_cents: 0, diff_cents: 0 })

    // (b) surplus (Σansatz−Σist = 7000) credited the frei reserve (ceiling bound); the
    //     closed-year bookings were stamped with a retention_until.
    const reserve = calls.find((c) => /UPDATE finance\.reserve SET amount_cents/.test(c.q))
    expect(reserve).toBeDefined()
    expect(reserve!.values).toContain(7000)
    expect(calls.some((c) => /UPDATE finance\.booking SET retention_until/.test(c.q))).toBe(true)

    // (c) the state flip set state='closed' AND stamped closed_at.
    const flip = calls.find((c) => /SET state = 'closed'/.test(c.q))
    expect(flip).toBeDefined()
    expect(/closed_at/.test(flip!.q)).toBe(true)

    // (d) close-then-read round-trip: the returned Statement is the persisted jsonb read
    //     back (carry_over / inventar / kassenbestand placeholder / meta.generated_at survive).
    const stmt = res as unknown as {
      meta: { generated_at: string }
      carry_over: { carry_amount_cents: number; reserve_delta_cents: number }
      inventar: { total_value_cents: number }
      kassenbestand_reconciliation: { opening_cents: number; closing_cents: number; diff_cents: number }
      closed_at: string | null
    }
    expect(stmt.meta.generated_at).toBe('2026-07-21T09:00:00.000Z')
    expect(stmt.carry_over).toEqual({ carry_amount_cents: 0, reserve_delta_cents: -7000 })
    expect(stmt.inventar.total_value_cents).toBe(50000)
    expect(stmt.kassenbestand_reconciliation).toEqual({ opening_cents: 0, closing_cents: 0, diff_cents: 0 })
    expect(stmt.closed_at).toBeNull() // toStatementDto normalises the absent top-level closed_at
  })

  it('rejects a non-active source state (draft/approved/closed) with FinanceStateError (→409)', async () => {
    for (const state of ['draft', 'approved', 'closed']) {
      const { fn } = recordSql([[{ id: '5', fiscal_year_id: '9', name: 'HH 9', state }], [CENTRAL]])
      await expect(closeBudget(fn, SUPER, 5)).rejects.toBeInstanceOf(FinanceStateError)
    }
  })

  it('write-scope 403: an out-of-scope non-superuser (central org-unit not in scope) → AccessDeniedError', async () => {
    const { fn } = recordSql([[{ id: '5', fiscal_year_id: '9', name: 'HH 9', state: 'active' }], [CENTRAL]])
    await expect(closeBudget(fn, DENIED, 5)).rejects.toBeInstanceOf(AccessDeniedError)
  })

  it('returns null (→404) when the plan is absent', async () => {
    const { fn } = recordSql([[]])
    expect(await closeBudget(fn, SUPER, 999)).toBeNull()
  })

  // Deficit path (§3.5 cascade) — the higher-risk arithmetic the surplus happy-path does
  // not exercise: the `surplus = -Σdiff` sign-wiring in the OTHER direction (ist>ansatz →
  // deficit) AND the multi-bucket dissolution frei→betriebsmittel→zweckgebunden, each
  // capped at its available balance. Verbatim mirror of native reserves.ts#
  // planReserveAdjustment (deficit branch) driven through the leaf closeBudget path.
  it('deficit (ist>ansatz) dissolves reserves frei→betriebsmittel→zweckgebunden, each capped at balance', async () => {
    // ansatz 10000, ist 15000 → diff +5000 → surplus −5000 (a 5000 shortfall to cover).
    // Buckets 2000/2000/2000 → frei −2000, betriebsmittel −2000, zweckgebunden −1000 (cap).
    const DEFICIT_TITEL = { id: '101', planned_cents: '10000' }
    const DEFICIT_ACTUALS = { budget_titel_id: '101', booked: '15000' }
    const DEFICIT_PROFILE = {
      reserve_frei_bound: 'ceiling', reserve_frei_amount_cents: '2000',
      reserve_betriebsmittel_amount_cents: '2000', reserve_zweckgebunden_amount_cents: '2000',
      retention_years: 10, retention_from: 'fiscal_year_end',
    }
    const CLOSED_REREAD_DEFICIT = {
      id: '5', name: 'HH 9', state: 'closed',
      statement: { ...CLOSED_STMT_JSONB, carry_over: { carry_amount_cents: 0, reserve_delta_cents: 5000 } },
      closed_at: new Date('2026-07-21T09:00:00.000Z'),
    }
    const { fn, calls } = recordSql([
      [{ id: '5', fiscal_year_id: '9', name: 'HH 9', state: 'active' }], // 1 plan FOR UPDATE
      [CENTRAL], // 2 findCentral
      [FY_ROW], // 3 fiscal_year
      [SECTION_ROW], // 4 section
      [UNIT_ROW], // 5 finance_unit
      [DEFICIT_TITEL], // 6 titel
      [DEFICIT_ACTUALS], // 7 actualsForPlan (ist 15000)
      [], // 8 inventar (empty)
      [], // 9 persist UPDATE statement
      [DEFICIT_PROFILE], // 10 loadProfile
      [], // 11 applyReserveDeltas — frei −2000
      [], // 12 applyReserveDeltas — betriebsmittel −2000
      [], // 13 applyReserveDeltas — zweckgebunden −1000 (capped)
      [], // 14 discharge lookup (none)
      [], // 15 markRetention UPDATE booking
      [], // 16 state flip UPDATE
      [CLOSED_REREAD_DEFICIT], // 17 getBudgetStatement re-read
      [{ id: '1' }], // 18 scopedFinanceUnitIds
      [{ exists: true }], // 19 visibility EXISTS
    ])
    await closeBudget(fn, SUPER, 5)

    // (a) the surplus SIGN wired the other way: Σdiff = +5000 persisted on carry_over.
    const persist = calls.find((c) => /UPDATE finance\.budget_plan SET statement =/.test(c.q))
    expect(JSON.parse(persist!.values[0] as string).carry_over.reserve_delta_cents).toBe(5000)

    // (b) the deficit cascade dissolved all three buckets in priority order, capped at balance:
    //     frei −2000, betriebsmittel −2000, zweckgebunden −1000 (Σ = −5000, the full shortfall).
    const reserves = calls.filter((c) => /UPDATE finance\.reserve SET amount_cents/.test(c.q))
    expect(reserves.map((c) => c.values)).toEqual([
      [-2000, 'frei'],
      [-2000, 'betriebsmittel'],
      [-1000, 'zweckgebunden'],
    ])
    expect(reserves.reduce((s, c) => s + (c.values[0] as number), 0)).toBe(-5000)
  })
})
