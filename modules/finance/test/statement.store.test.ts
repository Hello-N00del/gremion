// test/statement.store.test.ts — mocked-PG unit test for the budget-statement READ
// (#383 Lane B). Mirrors read/statement.ts#getBudgetStatement + dto-map.ts#toStatementDto:
//   * state='closed' + persisted budget_plan.statement jsonb → returned VERBATIM
//     (plan_id → number, closed_at ISO-or-null, surplus → number, extra keys pass through).
//   * else → interim on-the-fly: surplus = Σ(planned) − Σ(ist) over the plan's Titel.
// Visibility mirrors getBudgetPlan: auditor bypass; a non-auditor needs a budget_section
// in scope (EXISTS), else null (→ route 404, G-019 anti-probing).
//
// IMPORTANT (Lane B boundary): the leaf serves ONLY getBudgetStatement — the PDF/xlsx byte
// exports (getBudgetStatementPdf / exportBudget) stay 501-locked (R5). This suite asserts the
// store module pulls in NO exceljs / pdf renderer, so the statement read never drags the
// byte-generation deps into the leaf bundle.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getBudgetStatement, type ScopeContext } from '../src/store/index.ts'
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

describe('statement store — getBudgetStatement (closed = persisted jsonb verbatim)', () => {
  it('returns the persisted statement jsonb verbatim (plan_id→number, closed_at passthrough, extra keys survive)', async () => {
    const persisted = {
      plan_id: '1',
      closed_at: '2026-12-31T00:00:00.000Z',
      surplus: '5000',
      carried_over: 1234,
      note: 'Jahresabschluss 2026',
    }
    const planRow = { id: '1', name: 'HH', state: 'closed', statement: persisted, closed_at: new Date('2026-12-31T00:00:00.000Z') }
    const { fn } = recordSql([[planRow]])
    const res = await getBudgetStatement(fn, 1, AUDITOR)
    expect(res).toEqual({
      plan_id: 1, // coerced to number
      closed_at: '2026-12-31T00:00:00.000Z', // passthrough ISO string
      surplus: 5000, // coerced to number
      carried_over: 1234, // passthrough
      note: 'Jahresabschluss 2026', // passthrough
    })
  })
})

// interim projection fixtures — two Titel, one with a posted actual
const TITEL = [{ id: '101', planned_cents: '10000' }, { id: '102', planned_cents: '5000' }]
const ACTUALS = [{ budget_titel_id: '101', booked: '3000' }] // titel 102 has no posted booking → ist 0

describe('statement store — getBudgetStatement (interim on-the-fly when not closed)', () => {
  it('computes interim surplus = Σ(planned) − Σ(ist), closed_at null', async () => {
    const planRow = { id: '7', name: 'HH', state: 'draft', statement: null, closed_at: null }
    const { fn } = recordSql([[planRow], TITEL, ACTUALS])
    const res = await getBudgetStatement(fn, 7, AUDITOR)
    expect(res).toEqual({ plan_id: 7, closed_at: null, surplus: 12000 }) // (10000+5000) − 3000
  })

  it('a closed plan with a NULL statement still falls back to the interim compute', async () => {
    const planRow = { id: '7', name: 'HH', state: 'closed', statement: null, closed_at: new Date('2026-12-31T00:00:00.000Z') }
    const { fn } = recordSql([[planRow], TITEL, ACTUALS])
    const res = await getBudgetStatement(fn, 7, AUDITOR)
    expect(res!.surplus).toBe(12000)
    expect(res!.closed_at).toBeNull()
  })
})

describe('statement store — visibility (auditor bypass / scoped EXISTS / out-of-scope null)', () => {
  it('auditor bypasses scoping — no visibility query issued', async () => {
    const planRow = { id: '7', name: 'HH', state: 'draft', statement: null, closed_at: null }
    const { fn, calls } = recordSql([[planRow], TITEL, ACTUALS])
    await getBudgetStatement(fn, 7, AUDITOR)
    expect(calls.some((c) => /budget_section/.test(c.q) && /EXISTS/.test(c.q))).toBe(false)
  })

  it('scoped in-scope plan resolves (visibility EXISTS true)', async () => {
    const planRow = { id: '7', name: 'HH', state: 'draft', statement: null, closed_at: null }
    const { fn } = recordSql([[planRow], [{ id: '3' }], [{ exists: true }], TITEL, ACTUALS])
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    const res = await getBudgetStatement(fn, 7, scoped)
    expect(res!.surplus).toBe(12000)
  })

  it('out-of-scope-but-EXISTING plan → null (G-019 → route 404)', async () => {
    const planRow = { id: '7', name: 'HH', state: 'draft', statement: null, closed_at: null }
    const { fn } = recordSql([[planRow], [{ id: '99' }], [{ exists: false }]])
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_B] }
    expect(await getBudgetStatement(fn, 7, scoped)).toBeNull()
  })

  it('plan not found → null', async () => {
    const { fn } = recordSql([[]])
    expect(await getBudgetStatement(fn, 999, AUDITOR)).toBeNull()
  })
})

describe('statement store — Lane B boundary: NO byte-generation deps dragged into the leaf', () => {
  it('the store module imports neither exceljs nor the pdf statement renderer', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/store/index.ts', import.meta.url)), 'utf8')
    // Match the DEPENDENCY specifiers a byte-generation port would pull in, not the
    // bare word "pdf" (which is fine to name in a comment explaining the R5 lock).
    const importSpecifiers = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
    expect(importSpecifiers.some((s) => /exceljs/i.test(s))).toBe(false)
    expect(importSpecifiers.some((s) => /pdf|budget-statement|renderBudgetStatement/i.test(s))).toBe(false)
  })
})
