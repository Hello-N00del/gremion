// test/project.store.test.ts — #383 Lane E1 project (R1) store parity.
//
// Per-op parity vs the native oracle (services/read/project.ts +
// services/write/index.ts createProject/updateProjectState) across the FOUR scope
// lenses, honouring the oracle's exact isAuditor-only see-all signal:
//   auditor       → sees ALL (no scope filter / bypasses the id scope check)
//   in-scope      → sees the row (org_unit ∈ scope)
//   out-of-scope  → list filters it out ([]); id-read 404s (null)  ← G-019
//   empty scope   → [] / 404 (short-circuit, never queries the DB)
// A superuser-not-auditor is STILL org-unit-scoped here (read/project.ts gates on
// isAuditor, NOT seesAllFinance) — the parity divergence pinned below.
//
// The store's SQL is exercised against real PG in org-unit-mirror.integration.test.ts;
// this suite drives a keyword-routing fake sql so the JS scope decisions (branch
// selection, short-circuit, 404, DTO mapping) are asserted deterministically.

import { describe, it, expect } from 'vitest'
import {
  createProject,
  listProjects,
  getProject,
  updateProjectState,
  AccessDeniedError,
  FinanceValidationError,
  FinanceStateError,
  type ActorContext,
  type ScopeContext,
} from '../src/store/index.ts'

// A project row shaped like the leaf's SELECT (org_unit_id = 'ou-a', ou_name joined).
const PROJ = {
  id: '42',
  name: 'Ersti-Woche',
  state: 'draft',
  org_unit_id: 'ou-a',
  ou_name: 'Fachschaft A',
  responsible: 'Anna',
  description: 'kickoff',
  date_start: '2026-01-01',
  date_end: '2026-06-30',
  created_at: '2026-01-15T09:30:00.000Z',
  expenses_count: 3,
  spent_cents: '5000',
  type: 'internal',
}

/** Keyword-routing fake postgres-js Sql. Records queries; returns canned rows per
 *  query intent. Every store query lands in exactly one branch below. */
type FakeSql = ((...a: unknown[]) => Promise<unknown[]>) & {
  begin: (cb: (tx: unknown) => unknown) => Promise<unknown>
  queries: string[]
}
function fakeSql(overrides: Partial<Record<string, unknown[]>> = {}): FakeSql {
  const queries: string[] = []
  const route = (q: string): unknown[] => {
    if (q.includes('org_unit_mirror') && q.includes('AND NOT deleted')) {
      return overrides.resolve ?? [{ id: 'ou-a', name: 'Fachschaft A', kind: 'council' }]
    }
    if (q.includes('INSERT INTO finance.project')) return [PROJ]
    if (q.includes('SELECT name FROM finance.org_unit_mirror')) return [{ name: 'Fachschaft A' }]
    if (q.includes('FROM finance.project WHERE id') && q.includes('FOR UPDATE')) {
      return overrides.forUpdate ?? [{ org_unit_id: 'ou-a', type: 'internal', state: 'draft' }]
    }
    if (q.includes('UPDATE finance.project SET state')) return []
    if (q.includes('COUNT(*)::int AS c FROM finance.project')) return overrides.count ?? [{ c: 1 }]
    if (q.includes('expenses_count')) return overrides.detail ?? [PROJ] // getProject
    if (q.includes('spent_cents')) return overrides.list ?? [PROJ] // listProjects list
    return []
  }
  const fn = ((strings: TemplateStringsArray) => {
    const q = strings.join(' ? ')
    queries.push(q)
    return Promise.resolve(route(q))
  }) as FakeSql
  fn.begin = async (cb: (tx: unknown) => unknown) => cb(fn)
  fn.queries = queries
  return fn
}

const auditor: ActorContext = { isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [], userId: 'aud', groups: [] }
const inScope: ActorContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: ['ou-a'], userId: 'u1', groups: [] }
const outScope: ActorContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: ['ou-z'], userId: 'u2', groups: [] }
const emptyScope: ActorContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [], userId: 'u3', groups: [] }
const superuser: ActorContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [], userId: 'su', groups: [] }
const scope = (a: ActorContext): ScopeContext => a

describe('listProjects — four scope lenses (isAuditor-only see-all)', () => {
  it('auditor sees ALL (unscoped query, no ANY(scope) filter)', async () => {
    const sql = fakeSql()
    const res = await listProjects(sql, scope(auditor), {})
    expect(res.data).toHaveLength(1)
    expect(res.data[0]).toMatchObject({ id: 42, org: 'Fachschaft A', spent_cents: 5000 })
    expect(sql.queries.some((q) => q.includes('org_unit_id = ANY'))).toBe(false)
  })
  it('in-scope actor queries the scoped branch (WHERE org_unit_id = ANY(scope))', async () => {
    const sql = fakeSql()
    await listProjects(sql, scope(inScope), {})
    expect(sql.queries.some((q) => q.includes('org_unit_id = ANY'))).toBe(true)
  })
  it('out-of-scope non-empty scope still issues the scoped query (DB filters → []) ', async () => {
    const sql = fakeSql({ list: [], count: [{ c: 0 }] })
    const res = await listProjects(sql, scope(outScope), {})
    expect(res.data).toEqual([])
    expect(res.meta.total).toBe(0)
    expect(sql.queries.some((q) => q.includes('org_unit_id = ANY'))).toBe(true)
  })
  it('empty scope short-circuits to [] WITHOUT touching the DB', async () => {
    const sql = fakeSql()
    const res = await listProjects(sql, scope(emptyScope), {})
    expect(res.data).toEqual([])
    expect(sql.queries).toHaveLength(0)
  })
  it('DIVERGENCE: a superuser-not-auditor is STILL org-unit-scoped (empty su scope → [])', async () => {
    const sql = fakeSql()
    const res = await listProjects(sql, scope(superuser), {})
    expect(res.data).toEqual([])
    expect(sql.queries).toHaveLength(0)
  })
})

describe('getProject — four scope lenses', () => {
  it('auditor sees the row regardless of scope', async () => {
    const p = await getProject(fakeSql(), scope(auditor), 42)
    expect(p).toMatchObject({ id: 42, org: 'Fachschaft A', beschreibung: 'kickoff', expenses_count: 3 })
  })
  it('in-scope actor sees the row', async () => {
    const p = await getProject(fakeSql(), scope(inScope), 42)
    expect(p?.id).toBe(42)
  })
  it('out-of-scope non-auditor 404s (null) even though the row EXISTS (G-019)', async () => {
    const p = await getProject(fakeSql(), scope(outScope), 42)
    expect(p).toBeNull()
  })
  it('empty scope 404s (null)', async () => {
    const p = await getProject(fakeSql(), scope(emptyScope), 42)
    expect(p).toBeNull()
  })
  it('absent project 404s (null)', async () => {
    const p = await getProject(fakeSql({ detail: [] }), scope(auditor), 999)
    expect(p).toBeNull()
  })
})

describe('createProject — ou_name-from-mirror + dto.org resolution + expenses_count=0', () => {
  it('resolves dto.org against the mirror, then assembles ProjectDetail with ou_name + expenses_count=0', async () => {
    const sql = fakeSql()
    const p = await createProject(sql, inScope, { name: 'Ersti-Woche', org: 'ou-a', responsible: 'Anna' })
    expect(p).toMatchObject({ id: 42, name: 'Ersti-Woche', org: 'Fachschaft A', expenses_count: 0 })
    // the mirror resolve ran, and the row was inserted with type 'internal'
    expect(sql.queries.some((q) => q.includes('org_unit_mirror') && q.includes('AND NOT deleted'))).toBe(true)
    expect(sql.queries.some((q) => q.includes('INSERT INTO finance.project'))).toBe(true)
  })
  it('falls back to the actor first scoped org unit when dto.org is absent', async () => {
    const sql = fakeSql()
    const p = await createProject(sql, inScope, { name: 'No Org' })
    expect(p.expenses_count).toBe(0)
    // no mirror-resolve query (dto.org absent → straight to the scope fallback)
    expect(sql.queries.some((q) => q.includes('AND NOT deleted'))).toBe(false)
  })
  it('empty scope + no dto.org → FinanceValidationError (cannot resolve org_unit)', async () => {
    await expect(createProject(fakeSql(), emptyScope, { name: 'X' })).rejects.toBeInstanceOf(FinanceValidationError)
  })
  it('out-of-scope target → AccessDeniedError (§11 write gate)', async () => {
    // dto.org resolves to ou-a, but the actor only holds ou-z → denied.
    await expect(
      createProject(fakeSql(), outScope, { name: 'X', org: 'ou-a' }),
    ).rejects.toBeInstanceOf(AccessDeniedError)
  })
  it('superuser bypasses the write-scope gate', async () => {
    const p = await createProject(fakeSql(), superuser, { name: 'X', org: 'ou-a' })
    expect(p.id).toBe(42)
  })
})

describe('updateProjectState — write gate + state machine', () => {
  it('in-scope draft→submitted transitions then re-reads through the scoped read path', async () => {
    const p = await updateProjectState(fakeSql(), inScope, 42, 'submitted')
    expect(p?.id).toBe(42)
  })
  it('invalid state → FinanceValidationError (400)', async () => {
    await expect(updateProjectState(fakeSql(), inScope, 42, 'gibberish')).rejects.toBeInstanceOf(FinanceValidationError)
  })
  it('illegal transition (draft→completed, internal) → FinanceStateError (409)', async () => {
    await expect(updateProjectState(fakeSql(), inScope, 42, 'completed')).rejects.toBeInstanceOf(FinanceStateError)
  })
  it('out-of-scope actor → AccessDeniedError (403)', async () => {
    await expect(updateProjectState(fakeSql(), outScope, 42, 'submitted')).rejects.toBeInstanceOf(AccessDeniedError)
  })
  it('absent project → null (404)', async () => {
    const p = await updateProjectState(fakeSql({ forUpdate: [] }), inScope, 999, 'submitted')
    expect(p).toBeNull()
  })
  it('external_grant approved→disbursed is legal (internal would reject it)', async () => {
    const sql = fakeSql({ forUpdate: [{ org_unit_id: 'ou-a', type: 'external_grant', state: 'approved' }] })
    const p = await updateProjectState(sql, inScope, 42, 'disbursed')
    expect(p?.id).toBe(42)
  })
})
