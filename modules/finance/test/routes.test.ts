// test/routes.test.ts — the finance leaf route SURFACE (Lane D capstone).
//
// Mirrors the intent of the kernel's route-parity.test.ts: assert the leaf
// registers EVERY FinanceBackend op with the expected verb+path, in lock-step
// with gremion-ui/.../backend/service-client.ts (query strings excluded — the
// server strips them before matching).
//
// #383 Lane E1 — the CAPSTONE partition: every one of the 61 ops is classified as
// exactly one of
//   LIVE                        — store-backed, buildApiRoutes wires a REAL handler
//                                 (no lockedHandler fallback → never 501)
//   KERNEL_COUPLING_EXCEPTIONS  — provably un-portable → stays 501-locked (NOW EMPTY)
//   DEFERRED_PORTABLE           — leaf-local but needs new transport → stays 501-locked
// The three sets PARTITION the 61 ops (disjoint, union = 61). Lane E1 landed the
// org-unit mirror + event resync, unlocking the KERNEL org_units residual (the 9 project
// R1 + sub-org-read/sub_org_type R2 ops); Lane E3 moved the byte exports
// (getBudgetStatementPdf/exportBudget), csvImport, and configureFints/syncFints from
// DEFERRED_PORTABLE to LIVE; Lane E2 (R7) moved the receipts trio (uploadReceipt/
// deleteReceipt/publishReceipt) to LIVE, emptying DEFERRED_PORTABLE; **FIN-52 ported the
// LAST kernel-coupling residual — the WP-YearEnd closeBudget — leaf-local, emptying
// KERNEL_COUPLING_EXCEPTIONS.** TASK-009 lane C / R23-6 then AMENDED the contract 52→55,
// adding the finanzordnung config trio (getFinanzordnungProfile / getSignerConfig /
// updateSignerConfig) — landed LIVE in the same change. R23-7 then extended the
// contract 55→61, porting the six BankServiceImpl money ops (recordManualPayout/
// recordCashPayout/allocateSplit/reconcileCashBox/suggestPaymentOrderMatches/
// exportSepa) instead of leaving them 501-locked — also landed LIVE in the same
// change, so the surface stays FINAL at 61 LIVE (34 lanes A–D + 9 Lane E1 + 5 Lane
// E3 + 3 Lane E2 + 1 FIN-52 + 3 R23-6 + 6 R23-7) ⊍ 0 residual = 61. Real DB value
// parity is in api.integration.test.ts / lane-e3.integration.test.ts /
// lane-e2.integration.test.ts (+ the per-op *.store.test.ts / module tests).

import { describe, it, expect } from 'vitest'
import type http from 'node:http'
import {
  buildApiRoutes,
  FINANCE_ROUTE_SPECS,
  KERNEL_COUPLING_EXCEPTIONS,
  DEFERRED_PORTABLE,
} from '../src/http/routes.ts'
import type { Route } from '../src/http/router.ts'

// The 61-op surface (op → verb + leaf path), authored in lock-step with the ACL
// client. If either side drifts, this table + the kernel route-parity.test.ts
// diverge and one goes red.
const EXPECTED: Array<[string, string, string]> = [
  ['getBudget', 'GET', '/api/v1/budget'],
  ['createProject', 'POST', '/api/v1/projects'],
  ['listProjects', 'GET', '/api/v1/projects'],
  ['updateProjectState', 'PATCH', '/api/v1/projects/:id/state'],
  ['getProject', 'GET', '/api/v1/projects/:id'],
  ['createExpense', 'POST', '/api/v1/expenses'],
  ['listExpenses', 'GET', '/api/v1/expenses'],
  ['getExpense', 'GET', '/api/v1/expenses/:id'],
  ['listBookings', 'GET', '/api/v1/bookings'],
  ['listBankAccounts', 'GET', '/api/v1/bank-accounts'],
  ['listPendingApprovals', 'GET', '/api/v1/approvals/pending'],
  ['requestProjectApproval', 'POST', '/api/v1/projects/:id/request-approval'],
  ['requestExpenseApproval', 'POST', '/api/v1/expenses/:id/request-approval'],
  ['createApproval', 'POST', '/api/v1/approvals'],
  ['signApproval', 'POST', '/api/v1/approvals/:id/sign'],
  ['rejectApproval', 'POST', '/api/v1/approvals/:id/reject'],
  ['configureFints', 'PUT', '/api/v1/bank-accounts/:id/fints'],
  ['getFintsStatus', 'GET', '/api/v1/bank-accounts/:id/fints'],
  ['syncFints', 'POST', '/api/v1/bank-accounts/:id/fints/sync'],
  ['listReceipts', 'GET', '/api/v1/expenses/:id/receipts'],
  ['uploadReceipt', 'POST', '/api/v1/expenses/:id/receipts'],
  ['deleteReceipt', 'DELETE', '/api/v1/expenses/:id/receipts/:attachmentId'],
  ['publishReceipt', 'POST', '/api/v1/expenses/:id/receipts/:attachmentId/publish'],
  ['listSubOrgTypes', 'GET', '/api/v1/sub-org-types'],
  ['createSubOrgType', 'POST', '/api/v1/sub-org-types'],
  ['deleteSubOrgType', 'DELETE', '/api/v1/sub-org-types/:id'],
  ['listSubOrgs', 'GET', '/api/v1/sub-orgs'],
  ['createSubOrg', 'POST', '/api/v1/sub-orgs'],
  ['updateSubOrg', 'PATCH', '/api/v1/sub-orgs/:id'],
  ['deleteSubOrg', 'DELETE', '/api/v1/sub-orgs/:id'],
  ['getSubOrgSummary', 'GET', '/api/v1/sub-orgs/:id/summary'],
  ['createBudgetPlan', 'POST', '/api/v1/budget-plans'],
  ['getBudgetPlan', 'GET', '/api/v1/budget-plans/:id'],
  ['updateBudgetPlan', 'PATCH', '/api/v1/budget-plans/:id'],
  ['createBudgetGroup', 'POST', '/api/v1/budget-plans/:budgetId/groups'],
  ['updateBudgetGroup', 'PATCH', '/api/v1/budget-plans/:budgetId/groups/:groupId'],
  ['deleteBudgetGroup', 'DELETE', '/api/v1/budget-plans/:budgetId/groups/:groupId'],
  ['createBudgetItem', 'POST', '/api/v1/budget-plans/:budgetId/groups/:groupId/items'],
  ['updateBudgetItem', 'PATCH', '/api/v1/budget-plans/:budgetId/groups/:groupId/items/:itemId'],
  ['deleteBudgetItem', 'DELETE', '/api/v1/budget-plans/:budgetId/groups/:groupId/items/:itemId'],
  ['requestBudgetApproval', 'POST', '/api/v1/budget-plans/:id/request-approval'],
  ['activateBudget', 'POST', '/api/v1/budget-plans/:id/activate'],
  ['closeBudget', 'POST', '/api/v1/budget-plans/:id/close'],
  ['getBudgetStatement', 'GET', '/api/v1/budget-plans/:id/statement'],
  ['getBudgetStatementPdf', 'GET', '/api/v1/budget-plans/:id/statement/pdf'],
  ['exportBudget', 'GET', '/api/v1/budget-plans/:id/export'],
  ['listFiscalYears', 'GET', '/api/v1/fiscal-years'],
  ['createFiscalYear', 'POST', '/api/v1/fiscal-years'],
  ['updateFiscalYear', 'PATCH', '/api/v1/fiscal-years/:id'],
  ['assignBudgetFiscalYear', 'PUT', '/api/v1/budget-plans/:budgetId/fiscal-year'],
  ['csvImport', 'POST', '/api/v1/bank-accounts/:id/csv-import'],
  ['checkOrgUnitFinanceRefs', 'GET', '/api/v1/org-units/:orgUnitId/finance-refs'],
  // TASK-009 lane C / R23-6 — the finanzordnung config trio (53rd-55th ops).
  ['getFinanzordnungProfile', 'GET', '/api/v1/finanzordnung'],
  ['getSignerConfig', 'GET', '/api/v1/finanzordnung/signer-config'],
  ['updateSignerConfig', 'PUT', '/api/v1/finanzordnung/signer-config'],
  // TASK-009 lane C / R23-7 — the six BankServiceImpl money ops (56th-61st ops).
  ['recordCashPayout', 'POST', '/api/v1/payment-orders/:id/record-cash-payout'],
  ['recordManualPayout', 'POST', '/api/v1/payment-orders/:id/record-manual-payout'],
  ['suggestPaymentOrderMatches', 'GET', '/api/v1/payment-orders/:id/suggest-matches'],
  ['exportSepa', 'POST', '/api/v1/sepa/export'],
  ['reconcileCashBox', 'POST', '/api/v1/cash-boxes/:ledgerId/reconcile'],
  ['allocateSplit', 'POST', '/api/v1/bank-transactions/:id/allocate-split'],
]

/** A fake postgres-js Sql: every query returns [row]; .begin runs the callback. */
function fakeSql(row: Record<string, unknown>) {
  const fn = (() => Promise.resolve([row])) as unknown as {
    (...args: unknown[]): Promise<unknown[]>
    begin: (cb: (tx: unknown) => unknown) => Promise<unknown>
  }
  fn.begin = async (cb: (tx: unknown) => unknown) => cb(fn)
  return fn
}
const CANNED = {
  id: '7', org_unit_id: 'ou-x', kind: 'central', bookkeeping_mode: 'central', carry_over_rule: 'carry_forward',
  finance_unit: 0, project: 0, inventory_item: 0, ledger_account: 0, budget_section: 0, expense: 0, discharge: 0,
  name: 'HH', start_date: '2026-01-01', end_date: '2026-12-31', state: 'draft',
  // finanzordnung_profile's NOT NULL jsonb columns (arrays). getSignerConfig now
  // REQUIRES arrays and throws on anything else (TASK-009 fix round 5).
  signer_stages: [], decision_authority_tiers: [],
}
const fakeStore = async () => fakeSql(CANNED) as never

/** Invoke a route's handler with a fake ctx and capture the status + JSON body. */
async function invoke(route: Route, params: Record<string, string> = {}) {
  let status = 0
  let body = ''
  const res = {
    writeHead(s: number) { status = s; return res },
    end(chunk?: string) { if (chunk) body = chunk },
  } as unknown as http.ServerResponse
  const req = { headers: {}, [Symbol.asyncIterator]: async function* () {} } as unknown as http.IncomingMessage
  await route.handler({ params, req, res, tenant: { id: 't', slug: 's' } } as never)
  return { status, body: body ? JSON.parse(body) : undefined }
}

/** All params the fake handlers might read (id/budgetId/groupId/itemId/attachmentId/
 *  orgUnitId/ledgerId — ledgerId added for R23-7's cash-box reconcile route). */
const ALL_PARAMS = {
  id: '7', budgetId: '7', groupId: '7', itemId: '7', attachmentId: '7', orgUnitId: 'ou-x', ledgerId: '7',
}

/** Invoke a route's handler with a JSON request body. */
async function invokeWithBody(route: Route, params: Record<string, string>, payload: unknown) {
  let status = 0
  let body = ''
  const res = {
    writeHead(s: number) { status = s; return res },
    end(chunk?: string) { if (chunk) body = chunk },
  } as unknown as http.ServerResponse
  const raw = Buffer.from(JSON.stringify(payload), 'utf8')
  const req = { headers: {}, [Symbol.asyncIterator]: async function* () { yield raw } } as unknown as http.IncomingMessage
  await route.handler({ params, req, res, tenant: { id: 't', slug: 's' } } as never)
  return { status, body: body ? JSON.parse(body) : undefined }
}

describe('allocate-split input contract (TASK-009 verifier item 4)', () => {
  // The in-process ACL zod always accepted negative parts for a debit
  // (outgoing) split; the leaf port required > 0, so service mode refused
  // every outgoing split with a 400. Restored: non-zero safe integers (the
  // store checks the sign against the transaction).
  const reachedStore = new Error('reached-store')
  const splitRoute = () => {
    const r = buildApiRoutes(async () => { throw reachedStore }).find(
      (x) => x.method === 'POST' && x.path === '/api/v1/bank-transactions/:id/allocate-split',
    )
    if (!r) throw new Error('allocate-split route missing')
    return r
  }
  const part = (amountCents: unknown) => ({ ledgerAccountId: 9, budgetTitelId: 1, fiscalYearId: 1, amountCents })

  it('a debit split with NEGATIVE parts passes validation and reaches the store', async () => {
    await expect(
      invokeWithBody(splitRoute(), { id: '7' }, { parts: [part(-60), part(-40)] }),
    ).rejects.toBe(reachedStore)
  })

  it('a credit split with positive parts still reaches the store', async () => {
    await expect(
      invokeWithBody(splitRoute(), { id: '7' }, { parts: [part(60), part(40)] }),
    ).rejects.toBe(reachedStore)
  })

  it.each([
    ['zero', 0], ['fractional', 1.5], ['unsafe', 2 ** 60], ['non-numeric', 'x'],
  ])('a %s part amount is a 400', async (_label, amount) => {
    const { status } = await invokeWithBody(splitRoute(), { id: '7' }, { parts: [part(amount)] })
    expect(status).toBe(400)
  })
})

describe('finance leaf route surface', () => {
  it('registers exactly the 61 FinanceBackend ops', () => {
    expect(FINANCE_ROUTE_SPECS.length).toBe(61)
    expect(EXPECTED.length).toBe(61)
  })

  it('every op maps to the expected verb + path (lock-step with the ACL client)', () => {
    const actual = new Map(FINANCE_ROUTE_SPECS.map((s) => [s.op, `${s.method} ${s.path}`]))
    for (const [op, verb, path] of EXPECTED) {
      expect(actual.get(op), `op ${op}`).toBe(`${verb} ${path}`)
    }
  })

  it('buildApiRoutes(store) produces 61 spec routes + the internal saga-resolve route', () => {
    expect(buildApiRoutes().length).toBe(FINANCE_ROUTE_SPECS.length) // no store → 61 locked
    const withStore = buildApiRoutes(fakeStore)
    expect(withStore.length).toBe(FINANCE_ROUTE_SPECS.length + 1) // + internal GET /sub-orgs/:id
    expect(withStore.some((r) => r.method === 'GET' && r.path === '/api/v1/sub-orgs/:id')).toBe(true)
  })

  it('has no duplicate (method, path) pairs (incl. the internal resolve route)', () => {
    const keys = buildApiRoutes(fakeStore).map((s) => `${s.method} ${s.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('without a storeFn, EVERY op is 501 surface-locked (pre-cutover default)', async () => {
    for (const route of buildApiRoutes()) {
      const { status, body } = await invoke(route, ALL_PARAMS)
      expect(status, `${route.method} ${route.path}`).toBe(501)
      expect(body).toMatchObject({ success: false })
    }
  })

  // ── CAPSTONE: the 61-op partition (LIVE ⊍ exceptions ⊍ deferred) ─────────────
  it('the exception + deferred sets are disjoint and reference only real ops', () => {
    const all = new Set(FINANCE_ROUTE_SPECS.map((s) => s.op))
    for (const op of KERNEL_COUPLING_EXCEPTIONS) expect(all.has(op), `exception ${op}`).toBe(true)
    for (const op of DEFERRED_PORTABLE) expect(all.has(op), `deferred ${op}`).toBe(true)
    for (const op of KERNEL_COUPLING_EXCEPTIONS) {
      expect(DEFERRED_PORTABLE.has(op), `${op} in both sets`).toBe(false)
    }
  })

  it('every op is LIVE (real handler, not 501) XOR a documented residual (501-locked)', async () => {
    const routes = buildApiRoutes(fakeStore)
    const liveOps: string[] = []
    const lockedOps: string[] = []
    for (const spec of FINANCE_ROUTE_SPECS) {
      const route = routes.find((r) => r.method === spec.method && r.path === spec.path)!
      const { status } = await invoke(route, ALL_PARAMS)
      if (status === 501) lockedOps.push(spec.op)
      else liveOps.push(spec.op)
    }
    // The 501-locked ops are EXACTLY the documented residual (exceptions ∪ deferred) —
    // proving buildApiRoutes wires zero lockedHandler fallbacks for any LIVE op.
    const residual = new Set([...KERNEL_COUPLING_EXCEPTIONS, ...DEFERRED_PORTABLE])
    expect(new Set(lockedOps)).toEqual(residual)
    // LIVE + residual PARTITION the 61 ops.
    expect(liveOps.length + residual.size).toBe(61)
    expect(new Set([...liveOps, ...residual]).size).toBe(61)
  })

  it('the merged LIVE surface is 61 − |exceptions| − |deferred| ops (== 61 after R23-7, FINAL)', async () => {
    const routes = buildApiRoutes(fakeStore)
    let live = 0
    for (const spec of FINANCE_ROUTE_SPECS) {
      const route = routes.find((r) => r.method === spec.method && r.path === spec.path)!
      const { status } = await invoke(route, ALL_PARAMS)
      if (status !== 501) live++
    }
    expect(live).toBe(61)
    // SET-SIZE form too (not just the bare literal) so a parallel lane branch that
    // shrinks the residual sets sum-merges without a conflict on this line.
    expect(live).toBe(61 - KERNEL_COUPLING_EXCEPTIONS.size - DEFERRED_PORTABLE.size)
    // FIN-52 ported the last kernel-coupling residual (the WP-YearEnd closeBudget) leaf-
    // local → KERNEL_COUPLING_EXCEPTIONS is now EMPTY; Lane E3 + E2 emptied
    // DEFERRED_PORTABLE. 61 − 0 − 0 = 61 — every registered op is LIVE.
    expect(KERNEL_COUPLING_EXCEPTIONS).toEqual(new Set())
    expect(DEFERRED_PORTABLE).toEqual(new Set())
    expect(61 - KERNEL_COUPLING_EXCEPTIONS.size - DEFERRED_PORTABLE.size).toBe(61)
  })

  it('the 3 Lane E2 receipt ops are LIVE (not 501) and DEFERRED_PORTABLE is now EMPTY', async () => {
    const laneE2 = new Set([
      'POST /api/v1/expenses/:id/receipts', // uploadReceipt
      'DELETE /api/v1/expenses/:id/receipts/:attachmentId', // deleteReceipt
      'POST /api/v1/expenses/:id/receipts/:attachmentId/publish', // publishReceipt
    ])
    let seen = 0
    for (const route of buildApiRoutes(fakeStore)) {
      if (!laneE2.has(`${route.method} ${route.path}`)) continue
      seen++
      const { status } = await invoke(route, ALL_PARAMS)
      expect(status, `live ${route.method} ${route.path}`).not.toBe(501)
    }
    expect(seen).toBe(3)
    // Every DEFERRED_PORTABLE op has been carried across to LIVE — the set is empty.
    expect(DEFERRED_PORTABLE.size).toBe(0)
    for (const op of ['uploadReceipt', 'deleteReceipt', 'publishReceipt']) {
      expect(DEFERRED_PORTABLE.has(op), `${op} still deferred`).toBe(false)
    }
  })

  it('the 5 Lane E3 ops are LIVE (not 501)', async () => {
    const laneE3 = new Set([
      'GET /api/v1/budget-plans/:id/statement/pdf',
      'GET /api/v1/budget-plans/:id/export',
      'POST /api/v1/bank-accounts/:id/csv-import',
      'PUT /api/v1/bank-accounts/:id/fints',
      'POST /api/v1/bank-accounts/:id/fints/sync',
    ])
    for (const route of buildApiRoutes(fakeStore)) {
      if (!laneE3.has(`${route.method} ${route.path}`)) continue
      const { status } = await invoke(route, ALL_PARAMS)
      expect(status, `live ${route.method} ${route.path}`).not.toBe(501)
    }
  })

  it('the 9 Lane E1 R1/R2 ops resolve store-backed (a REAL handler, never 501)', async () => {
    const laneE1 = new Set([
      'POST /api/v1/projects', // createProject
      'GET /api/v1/projects', // listProjects
      'GET /api/v1/projects/:id', // getProject
      'PATCH /api/v1/projects/:id/state', // updateProjectState
      'GET /api/v1/sub-orgs', // listSubOrgs
      'GET /api/v1/sub-orgs/:id/summary', // getSubOrgSummary
      'GET /api/v1/sub-org-types', // listSubOrgTypes
      'POST /api/v1/sub-org-types', // createSubOrgType
      'DELETE /api/v1/sub-org-types/:id', // deleteSubOrgType
    ])
    let seen = 0
    for (const route of buildApiRoutes(fakeStore)) {
      if (!laneE1.has(`${route.method} ${route.path}`)) continue
      seen++
      const { status } = await invoke(route, ALL_PARAMS)
      expect(status, `live ${route.method} ${route.path}`).not.toBe(501)
    }
    expect(seen).toBe(9)
    // And none of the 9 is still listed as a kernel-coupling exception.
    for (const op of ['createProject', 'listProjects', 'getProject', 'updateProjectState',
      'listSubOrgs', 'getSubOrgSummary', 'listSubOrgTypes', 'createSubOrgType', 'deleteSubOrgType']) {
      expect(KERNEL_COUPLING_EXCEPTIONS.has(op), `${op} still excepted`).toBe(false)
    }
  })

  it('the 10 Lane D budget write ops are LIVE (not 501)', async () => {
    const laneD = new Set([
      'POST /api/v1/budget-plans',
      'PATCH /api/v1/budget-plans/:id',
      'POST /api/v1/budget-plans/:budgetId/groups',
      'PATCH /api/v1/budget-plans/:budgetId/groups/:groupId',
      'DELETE /api/v1/budget-plans/:budgetId/groups/:groupId',
      'POST /api/v1/budget-plans/:budgetId/groups/:groupId/items',
      'PATCH /api/v1/budget-plans/:budgetId/groups/:groupId/items/:itemId',
      'DELETE /api/v1/budget-plans/:budgetId/groups/:groupId/items/:itemId',
      'POST /api/v1/budget-plans/:id/activate',
      'PUT /api/v1/budget-plans/:budgetId/fiscal-year',
    ])
    for (const route of buildApiRoutes(fakeStore)) {
      if (!laneD.has(`${route.method} ${route.path}`)) continue
      const { status } = await invoke(route, ALL_PARAMS)
      expect(status, `live ${route.method} ${route.path}`).not.toBe(501)
    }
  })

  it('includes the 3 org_units-writer routes + the referential-guard route', () => {
    const ops = new Set(FINANCE_ROUTE_SPECS.map((s) => s.op))
    expect(ops.has('createSubOrg')).toBe(true)
    expect(ops.has('updateSubOrg')).toBe(true)
    expect(ops.has('deleteSubOrg')).toBe(true)
    expect(ops.has('checkOrgUnitFinanceRefs')).toBe(true)
  })

  it('the referential-guard route returns REAL counts (referenced:false when clear)', async () => {
    const route = buildApiRoutes(fakeStore).find(
      (r) => r.method === 'GET' && r.path === '/api/v1/org-units/:orgUnitId/finance-refs',
    )!
    const { status, body } = await invoke(route, { orgUnitId: 'ou-x' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ referenced: false })
    expect(typeof body.counts).toBe('object')
  })

  // ── R23-7: the 6 money ops are LIVE (not 501), and 400 on a body/params gap ──
  // (the generic fakeStore's CANNED row satisfies the "not 501" shape but not
  // every op's specific validation; each op's real happy/authz/invalid-input
  // coverage is in test/bank-money.store.test.ts — this capstone only proves the
  // wiring, mirroring the Lane E1/E2/E3 blocks above.)
  it('the 6 R23-7 money ops are LIVE (not 501)', async () => {
    const money = new Set([
      'POST /api/v1/payment-orders/:id/record-cash-payout',
      'POST /api/v1/payment-orders/:id/record-manual-payout',
      'GET /api/v1/payment-orders/:id/suggest-matches',
      'POST /api/v1/sepa/export',
      'POST /api/v1/cash-boxes/:ledgerId/reconcile',
      'POST /api/v1/bank-transactions/:id/allocate-split',
    ])
    let seen = 0
    for (const route of buildApiRoutes(fakeStore)) {
      if (!money.has(`${route.method} ${route.path}`)) continue
      seen++
      const { status } = await invoke(route, ALL_PARAMS)
      expect(status, `live ${route.method} ${route.path}`).not.toBe(501)
    }
    expect(seen).toBe(6)
    for (const op of [
      'recordCashPayout', 'recordManualPayout', 'suggestPaymentOrderMatches',
      'exportSepa', 'reconcileCashBox', 'allocateSplit',
    ]) {
      expect(KERNEL_COUPLING_EXCEPTIONS.has(op), `${op} excepted`).toBe(false)
      expect(DEFERRED_PORTABLE.has(op), `${op} deferred`).toBe(false)
    }
  })
})
