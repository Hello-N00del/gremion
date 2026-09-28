// test/statement-projection.store.test.ts — mocked-PG unit test for the byte-export
// projection (#383 Lane E3, R5). getStatementProjection mirrors the native
// read/statement.ts#projectPlan + assertPlanVisible: the SAME visibility gate as
// getBudgetStatement (auditor bypass / scoped budget_section EXISTS / out-of-scope →
// null → route 404, G-019), then the flat per-Titel lines (ansatz=planned_cents,
// ist=posted actuals, section/group ids) that BOTH byte exports render.

import { describe, it, expect } from 'vitest'
import { getStatementProjection, type ScopeContext } from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

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

const PLAN = { id: '7', name: 'HH 2026', state: 'active', statement: null, closed_at: null }
const TITEL = [
  { id: '101', budget_group_id: '4', budget_section_id: '1', titel_nr: '1.1', titel_name: 'Personal', planned_cents: '12000' },
  { id: '102', budget_group_id: '4', budget_section_id: '1', titel_nr: null, titel_name: 'Sachmittel', planned_cents: '5000' },
]
const ACTUALS = [{ budget_titel_id: '101', booked: '11000' }]

describe('statement projection store — getStatementProjection', () => {
  it('projects the plan + flat Titel lines with posted actuals (null titel_nr → "")', async () => {
    const { fn } = recordSql([[PLAN], TITEL, ACTUALS])
    const res = await getStatementProjection(fn, 7, AUDITOR)
    expect(res).toEqual({
      plan: { id: 7, name: 'HH 2026', state: 'active' },
      lines: [
        { titel_id: 101, titel_nr: '1.1', titel_name: 'Personal', ansatz: 12000, ist: 11000, section_id: 1, group_id: 4 },
        { titel_id: 102, titel_nr: '', titel_name: 'Sachmittel', ansatz: 5000, ist: 0, section_id: 1, group_id: 4 },
      ],
    })
  })

  it('orders the projection query by section, group, titel (native ORDER BY parity)', async () => {
    const { fn, calls } = recordSql([[PLAN], TITEL, ACTUALS])
    await getStatementProjection(fn, 7, AUDITOR)
    const proj = calls.find((c) => /FROM finance\.budget_titel/.test(c.q))!
    expect(proj.q).toMatch(/ORDER BY bs\.id, bg\.id, bt\.id/)
  })

  it('auditor bypasses the scoping (no visibility EXISTS query)', async () => {
    const { fn, calls } = recordSql([[PLAN], TITEL, ACTUALS])
    await getStatementProjection(fn, 7, AUDITOR)
    expect(calls.some((c) => /EXISTS/.test(c.q))).toBe(false)
  })

  it('scoped in-scope actor resolves (visibility EXISTS true)', async () => {
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    const { fn } = recordSql([[PLAN], [{ id: '3' }], [{ exists: true }], TITEL, ACTUALS])
    const res = await getStatementProjection(fn, 7, scoped)
    expect(res!.plan.id).toBe(7)
    expect(res!.lines).toHaveLength(2)
  })

  it('out-of-scope-but-EXISTING plan → null (G-019 → route 404), projection never queried', async () => {
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_B] }
    const { fn, calls } = recordSql([[PLAN], [{ id: '99' }], [{ exists: false }]])
    expect(await getStatementProjection(fn, 7, scoped)).toBeNull()
    expect(calls.some((c) => /FROM finance\.budget_titel/.test(c.q))).toBe(false)
  })

  it('plan not found → null', async () => {
    const { fn } = recordSql([[]])
    expect(await getStatementProjection(fn, 999, AUDITOR)).toBeNull()
  })
})
