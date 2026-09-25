// test/sub-org.store.test.ts — #383 Lane E1 sub-org read (R2) store parity.
//
// Per-op parity vs the native oracle (services/read/sub-org.ts + services/write/
// sub-org.ts) across the FOUR scope lenses (auditor=all, in-scope, out-of-scope→
// []/404, empty scope→[]), honouring read/sub-org.ts's isAuditor-only see-all.
// Plus: listSubOrgTypes derives types from DISTINCT org_unit_mirror.kind (NOT the
// catalog), and createSubOrgType/deleteSubOrgType write finance.sub_org_type
// (leaf-owned, NO org-unit scope). Real SQL parity is in the integration suite.

import { describe, it, expect } from 'vitest'
import {
  listSubOrgs,
  getSubOrgSummary,
  listSubOrgTypes,
  createSubOrgType,
  deleteSubOrgType,
  type ActorContext,
  type ScopeContext,
} from '../src/store/index.ts'

const SUBORG = { id: '10', name: 'Fachschaft A', org_unit_id: 'ou-a', kind: 'council', bookkeeping_mode: 'own' }

type FakeSql = ((...a: unknown[]) => Promise<unknown[]>) & { queries: string[] }
function fakeSql(overrides: Partial<Record<string, unknown[]>> = {}): FakeSql {
  const queries: string[] = []
  const route = (q: string): unknown[] => {
    if (q.includes('DISTINCT ou.kind')) return overrides.types ?? [{ kind: 'council' }, { kind: 'committee' }]
    if (q.includes('INSERT INTO finance.sub_org_type')) return [{ id: '5', name: 'Fachschaft', description: null }]
    if (q.includes('DELETE FROM finance.sub_org_type')) return []
    if (q.includes('planned_cents')) return [{ s: '100000' }]
    if (q.includes('FROM finance.booking b')) return [{ s: '30000' }]
    if (q.includes('WHERE fu.id =')) return overrides.summary ?? [{ id: '10', name: 'Fachschaft A', org_unit_id: 'ou-a' }]
    if (q.includes('org_unit_id = ANY')) return overrides.scopedList ?? [SUBORG]
    if (q.includes('FROM finance.finance_unit fu')) return overrides.allList ?? [SUBORG]
    return []
  }
  const fn = ((strings: TemplateStringsArray) => {
    const q = strings.join(' ? ')
    queries.push(q)
    return Promise.resolve(route(q))
  }) as FakeSql
  fn.queries = queries
  return fn
}

const auditor: ScopeContext = { isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [] }
const inScope: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: ['ou-a'] }
const outScope: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: ['ou-z'] }
const emptyScope: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [] }
const superuser: ScopeContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [] }

describe('listSubOrgs — four scope lenses (isAuditor-only see-all)', () => {
  it('auditor sees ALL (unscoped query) and maps the SubOrg DTO', async () => {
    const sql = fakeSql()
    const rows = await listSubOrgs(sql, auditor)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 10, name: 'Fachschaft A', type_id: 1, type: 'council', bookkeeping_mode: 'own',
      payment_method: 'standard', allocation_amount: 0, budget_plan_id: null,
    })
    expect(sql.queries.some((q) => q.includes('org_unit_id = ANY'))).toBe(false)
  })
  it('in-scope actor queries the scoped branch', async () => {
    const sql = fakeSql()
    await listSubOrgs(sql, inScope)
    expect(sql.queries.some((q) => q.includes('org_unit_id = ANY'))).toBe(true)
  })
  it('out-of-scope non-empty scope issues the scoped query (DB filters → [])', async () => {
    const sql = fakeSql({ scopedList: [] })
    expect(await listSubOrgs(sql, outScope)).toEqual([])
    expect(sql.queries.some((q) => q.includes('org_unit_id = ANY'))).toBe(true)
  })
  it('empty scope short-circuits to [] WITHOUT touching the DB', async () => {
    const sql = fakeSql()
    expect(await listSubOrgs(sql, emptyScope)).toEqual([])
    expect(sql.queries).toHaveLength(0)
  })
  it('DIVERGENCE: superuser-not-auditor is STILL org-unit-scoped (empty su scope → [])', async () => {
    const sql = fakeSql()
    expect(await listSubOrgs(sql, superuser)).toEqual([])
    expect(sql.queries).toHaveLength(0)
  })
})

describe('getSubOrgSummary — four scope lenses + rolled-up planned/booked', () => {
  it('auditor sees the summary (allocated/spent/remaining)', async () => {
    const s = await getSubOrgSummary(fakeSql(), auditor, 10)
    expect(s).toEqual({ id: 10, name: 'Fachschaft A', allocated: 100000, spent: 30000, remaining: 70000 })
  })
  it("spent rollup normalizes sign per budget_type — expense outflows count positive (#410 FIN-3)", async () => {
    const sql = fakeSql()
    await getSubOrgSummary(sql, auditor, 10)
    const bookedQ = sql.queries.find((q) => q.includes('FROM finance.booking b'))
    expect(bookedQ).toMatch(/CASE WHEN bg\.budget_type = 'income' THEN b\.amount_cents ELSE -b\.amount_cents END/)
    expect(bookedQ).not.toMatch(/ABS\(/)
  })
  it('in-scope actor sees the summary', async () => {
    const s = await getSubOrgSummary(fakeSql(), inScope, 10)
    expect(s?.id).toBe(10)
  })
  it('out-of-scope non-auditor 404s (null) though the sub-org EXISTS (G-019)', async () => {
    expect(await getSubOrgSummary(fakeSql(), outScope, 10)).toBeNull()
  })
  it('empty scope 404s (null)', async () => {
    expect(await getSubOrgSummary(fakeSql(), emptyScope, 10)).toBeNull()
  })
  it('absent sub-org 404s (null)', async () => {
    expect(await getSubOrgSummary(fakeSql({ summary: [] }), auditor, 999)).toBeNull()
  })
})

describe('listSubOrgTypes — DISTINCT org_unit_mirror.kind (NOT the catalog table)', () => {
  it('maps each distinct kind to its synthesised type_id', async () => {
    const sql = fakeSql()
    const types = await listSubOrgTypes(sql)
    expect(types).toEqual([
      { id: 1, name: 'council', description: null },
      { id: 2, name: 'committee', description: null },
    ])
    // reads the mirror kind, NOT finance.sub_org_type
    expect(sql.queries.some((q) => q.includes('DISTINCT ou.kind'))).toBe(true)
    expect(sql.queries.some((q) => q.includes('sub_org_type'))).toBe(false)
  })
  it('an unknown kind synthesises type_id 0', async () => {
    const types = await listSubOrgTypes(fakeSql({ types: [{ kind: 'plenum' }] }))
    expect(types).toEqual([{ id: 0, name: 'plenum', description: null }])
  })
})

describe('createSubOrgType / deleteSubOrgType — write finance.sub_org_type (no org scope)', () => {
  it('createSubOrgType inserts into finance.sub_org_type and returns the DTO', async () => {
    const sql = fakeSql()
    const t = await createSubOrgType(sql, { name: 'Fachschaft', description: null })
    expect(t).toEqual({ id: 5, name: 'Fachschaft', description: null })
    expect(sql.queries.some((q) => q.includes('INSERT INTO finance.sub_org_type'))).toBe(true)
  })
  it('deleteSubOrgType deletes from finance.sub_org_type', async () => {
    const sql = fakeSql()
    await deleteSubOrgType(sql, 5)
    expect(sql.queries.some((q) => q.includes('DELETE FROM finance.sub_org_type'))).toBe(true)
  })
})
