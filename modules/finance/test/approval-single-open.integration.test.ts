// test/approval-single-open.integration.test.ts -- F1-FIX-05-K (H20: S4#3, K4#0).
//
// createApproval had no one-open-approval guard and no unique index: a repeated
// "Genehmigung anfordern" (double click, retry) opened two pending approvals, both
// could be signed to the end, and each finalisation inserted its own authorised
// payment_order -- a double payout for one expense. Real Postgres, full HTTP round
// trips (guard -> router -> store -> PG), plus the migration's refusal to build the
// indexes over existing duplicates (it must fail loudly and keep every row).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { storeFor, _resetTenantStoreForTests, type TenantRef, type Sql } from '../src/tenant-store.ts'

const TEST_DB_PREFIX = 'finance_test_'
const TEST_PG_URL = (() => {
  const url = process.env.FINANCE_TEST_PG_URL
  if (!url) {
    throw new Error(
      '[fin-test-guard] FINANCE_TEST_PG_URL is REQUIRED -- refusing to default to localhost:5432 ' +
        '(the LIVE staging Postgres). Start a throwaway container on a NON-5432 port.',
    )
  }
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(host)) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: non-localhost host "${host}" -- refusing.`)
  }
  if (parsed.port === '' || parsed.port === '5432') {
    throw new Error('[fin-test-guard] SAFETY VIOLATION: port 5432 (or implicit default) -- refusing.')
  }
  return url
})()

const SECRET = 'approval-single-open-secret'
const TENANT: TenantRef = { id: 'f105f105-0000-4000-8000-f105f105f105', slug: 'f105approval' }
const OU = 'f1050000-aaaa-4aaa-8aaa-f10500000001'

interface Actor { userId: string; isSuperuser?: boolean; groups?: string[] }
const CREATOR: Actor = { userId: 'creator', isSuperuser: true }
const KV: Actor = { userId: 'kv-u', groups: ['ref-finanzen-kv'] }
const HV: Actor = { userId: 'hv-u', groups: ['ref-finanzen-hv'] }

const headers = (a: Actor): Record<string, string> => ({
  'x-internal-auth': SECRET,
  'x-tenant-id': TENANT.id,
  'x-tenant-slug': TENANT.slug,
  'content-type': 'application/json',
  'x-finance-user-id': a.userId,
  'x-finance-is-auditor': 'false',
  'x-finance-is-superuser': String(!!a.isSuperuser),
  ...(a.groups ? { 'x-finance-groups': a.groups.join(',') } : {}),
})

describe('finance leaf -- one open approval and one live payment_order per approvable (H20)', () => {
  let server: ReturnType<typeof createServer>
  let base: string
  let sql: Sql
  let projectId: number

  const post = (path: string, a: Actor, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST', headers: headers(a), ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  async function makeExpense(): Promise<number> {
    const res = await post('/api/v1/expenses', CREATOR, {
      projekt_id: projectId, name_suffix: 'n', zahlung_name: 'Payee GmbH', zahlung_vwzk: 'Zweck',
    })
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()).id
  }
  const requestApproval = (expenseId: number) => post(`/api/v1/expenses/${expenseId}/request-approval`, CREATOR)
  async function signThrough(approvalId: number): Promise<void> {
    expect((await post(`/api/v1/approvals/${approvalId}/sign`, KV, { note: 'kv' })).status).toBe(200)
    const last = await post(`/api/v1/approvals/${approvalId}/sign`, HV, { note: 'hv' })
    expect(last.status, await last.clone().text()).toBe(200)
  }
  const count = async (q: Promise<{ n: string }[]>): Promise<number> => Number((await q)[0]!.n)

  beforeAll(async () => {
    await _resetTenantStoreForTests()
    sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const storeFn = (t: TenantRef) => storeFor(t, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    server = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await _resetTenantStoreForTests()
  })

  beforeEach(async () => {
    await sql`TRUNCATE finance.payment_order, finance.approval, finance.expense,
              finance.project, finance.finance_unit, finance.finanzordnung_profile,
              finance.finance_helios_settings RESTART IDENTITY CASCADE`
    await sql`INSERT INTO finance.finanzordnung_profile (bundesland) VALUES ('BE')`
    await sql`INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
              VALUES (${OU}, 'central', 'central', 'carry_forward')`
    projectId = Number((await sql<{ id: string }[]>`
      INSERT INTO finance.project (org_unit_id, type, name) VALUES (${OU}, 'internal', 'P') RETURNING id`)[0]!.id)
  })

  it('a second request-approval while one is pending returns 409 and opens nothing', async () => {
    const expenseId = await makeExpense()
    expect((await requestApproval(expenseId)).status).toBe(200)
    const second = await requestApproval(expenseId)
    expect(second.status, await second.clone().text()).toBe(409)
    expect((await second.json()).code).toBe('APPROVAL_ALREADY_OPEN')
    expect(await count(sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM finance.approval WHERE approvable_id = ${expenseId}`)).toBe(1)
  })

  it('a double click (two concurrent requests) opens exactly one approval', async () => {
    const expenseId = await makeExpense()
    const [a, b] = await Promise.all([requestApproval(expenseId), requestApproval(expenseId)])
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409])
    expect(await count(sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM finance.approval
      WHERE approvable_type = 'expense' AND approvable_id = ${expenseId}`)).toBe(1)
  })

  it('a direct INSERT of a second pending approval violates the unique index', async () => {
    const expenseId = await makeExpense()
    expect((await requestApproval(expenseId)).status).toBe(200)
    await expect(sql`
      INSERT INTO finance.approval (approvable_type, approvable_id, created_by)
      VALUES ('expense', ${expenseId}, 'direct')`).rejects.toMatchObject({ code: '23505' })
  })

  it('an approved expense cannot open a new approval (409), so it keeps one payment_order', async () => {
    const expenseId = await makeExpense()
    const opened = await requestApproval(expenseId)
    await signThrough((await opened.json()).approval_id)
    const again = await requestApproval(expenseId)
    expect(again.status, await again.clone().text()).toBe(409)
    expect(await count(sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM finance.payment_order WHERE expense_id = ${expenseId}`)).toBe(1)
  })

  it('finalising twice yields one payment_order (the second finalisation is refused, 409)', async () => {
    const expenseId = await makeExpense()
    await signThrough((await (await requestApproval(expenseId)).json()).approval_id)
    // Force the expense back to a requestable state (as a stale UI or a data repair
    // could), open and sign a second approval through to its final stage.
    await sql`UPDATE finance.expense SET state = 'submitted' WHERE id = ${expenseId}`
    const second = await requestApproval(expenseId)
    expect(second.status, await second.clone().text()).toBe(200)
    const approvalId = (await second.json()).approval_id
    expect((await post(`/api/v1/approvals/${approvalId}/sign`, KV, { note: 'kv' })).status).toBe(200)
    const final = await post(`/api/v1/approvals/${approvalId}/sign`, HV, { note: 'hv' })
    expect(final.status, await final.clone().text()).toBe(409)
    expect(await count(sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM finance.payment_order
      WHERE expense_id = ${expenseId} AND state <> 'voided'`)).toBe(1)
  })

  it('a direct INSERT of a second live payment_order violates the unique index; a voided one does not count', async () => {
    const expenseId = await makeExpense()
    await sql`INSERT INTO finance.payment_order (expense_id, anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by, state)
              VALUES (${expenseId}, 'a', 'b', 'b', 'voided')`
    await sql`INSERT INTO finance.payment_order (expense_id, anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by)
              VALUES (${expenseId}, 'a', 'b', 'b')`
    await expect(sql`
      INSERT INTO finance.payment_order (expense_id, anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by)
      VALUES (${expenseId}, 'a', 'b', 'b')`).rejects.toMatchObject({ code: '23505' })
  })

  it('a rejected expense may be requested again (re-submission after rejection stays possible)', async () => {
    const expenseId = await makeExpense()
    const approvalId = (await (await requestApproval(expenseId)).json()).approval_id
    expect((await post(`/api/v1/approvals/${approvalId}/reject`, KV, { note: 'nein' })).status).toBe(200)
    expect((await requestApproval(expenseId)).status).toBe(200)
  })

  // Migration 006 over existing duplicates. ONE arm per case: with both arms seeded
  // at once, a regression that silently DELETEs the surplus approvals stayed green,
  // because the payment_order arm's RAISE rolled the DELETE back (verifier, r1).
  //
  // The boot is re-run through storeFor() under a second tenant id that shares the
  // slug (so the same tenant DB): the pool map is keyed by id, so this opens a FRESH
  // pool and runs every migration exactly as a leaf's first contact does, while the
  // suite's `sql` pool on TENANT stays open to read and repair the rows. No direct
  // driver connection in this file (kernel lint-tenant-db-access).
  const REBOOT: TenantRef = { id: 'f105f105-0000-4000-8000-f105f105f106', slug: TENANT.slug }
  const reboot = () => storeFor(REBOOT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })

  async function dropSingleOpenIndexes(): Promise<void> {
    await sql`DROP INDEX IF EXISTS finance.approval_one_open_per_approvable_idx`
    await sql`DROP INDEX IF EXISTS finance.payment_order_one_live_per_expense_idx`
  }

  async function expectIndexesRebuiltAfterRepair(): Promise<void> {
    // The repaired DB boots under the real tenant again and carries both indexes.
    await _resetTenantStoreForTests()
    sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'finance'
        AND indexname IN ('approval_one_open_per_approvable_idx', 'payment_order_one_live_per_expense_idx')
      ORDER BY indexname`
    expect(idx.map((r) => r.indexname)).toEqual([
      'approval_one_open_per_approvable_idx', 'payment_order_one_live_per_expense_idx',
    ])
  }

  it('migration 006 refuses to boot over duplicate pending approvals ALONE, loudly, and keeps every row', async () => {
    const expenseId = await makeExpense()
    await dropSingleOpenIndexes()
    await sql`INSERT INTO finance.approval (approvable_type, approvable_id, created_by)
              VALUES ('expense', ${expenseId}, 'dup-1'), ('expense', ${expenseId}, 'dup-2')`

    await expect(reboot()).rejects.toThrow(/migration 006: duplicate pending approvals exist for expense#/)

    // Nothing was dropped, rejected or rewritten.
    const rows = await sql<{ created_by: string; status: string }[]>`
      SELECT created_by, status FROM finance.approval WHERE approvable_id = ${expenseId} ORDER BY created_by`
    expect(rows.map((r) => `${r.created_by}:${r.status}`)).toEqual(['dup-1:pending', 'dup-2:pending'])
    expect(await count(sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_indexes WHERE schemaname = 'finance'
        AND indexname = 'approval_one_open_per_approvable_idx'`)).toBe(0)

    // Operator repair (by hand, never by the migration): reject the surplus approval.
    await sql`UPDATE finance.approval SET status = 'rejected', rejection_reason = 'duplicate (006 repair)'
              WHERE approvable_id = ${expenseId} AND created_by = 'dup-2'`
    await expectIndexesRebuiltAfterRepair()
    expect(await count(sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM finance.approval WHERE approvable_id = ${expenseId}`)).toBe(2)
  })

  it('migration 006 refuses to boot over duplicate live payment_orders ALONE, loudly, and keeps every row', async () => {
    const expenseId = await makeExpense()
    await dropSingleOpenIndexes()
    await sql`INSERT INTO finance.payment_order (expense_id, anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by)
              VALUES (${expenseId}, 'a', 'b', 'b'), (${expenseId}, 'a', 'b', 'b')`

    await expect(reboot()).rejects.toThrow(/migration 006: duplicate live payment_orders exist for expense#/)

    // Nothing was dropped or voided.
    const states = await sql<{ state: string }[]>`
      SELECT state FROM finance.payment_order WHERE expense_id = ${expenseId} ORDER BY id`
    expect(states).toHaveLength(2)
    expect(states.every((r) => r.state !== 'voided')).toBe(true)
    expect(await count(sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_indexes WHERE schemaname = 'finance'
        AND indexname = 'payment_order_one_live_per_expense_idx'`)).toBe(0)

    // Operator repair (by hand, never by the migration): void the surplus order.
    await sql`UPDATE finance.payment_order SET state = 'voided'
              WHERE id = (SELECT max(id) FROM finance.payment_order WHERE expense_id = ${expenseId})`
    await expectIndexesRebuiltAfterRepair()
    expect(await count(sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM finance.payment_order WHERE expense_id = ${expenseId}`)).toBe(2)
  })
})
