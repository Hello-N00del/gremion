/**
 * API smoke test for the finance leaf HTTP server. Boots a real node:http server
 * (no PG needed for these paths) and asserts the request lifecycle:
 *   - /healthz is guard-exempt and returns {"status":"ok"}
 *   - a guarded route with NO/!wrong secret → 403; with a bad tenant slug → 400
 *   - a matched + guarded route is SURFACE-LOCKED to 501 (until cutover)
 *   - an unknown path → 404; a wrong method on a known path → 405
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { storeFor, _resetTenantStoreForTests, type TenantRef, type Sql } from '../src/tenant-store.ts'

const SECRET = 'smoke-secret'
let server: ReturnType<typeof createServer>
let base: string

const TENANT_HEADERS = {
  'x-internal-auth': SECRET,
  'x-tenant-id': '11111111-1111-1111-1111-111111111111',
  'x-tenant-slug': 'alpha',
}

beforeAll(async () => {
  server = createServer({ secret: SECRET, routes: buildApiRoutes() })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('finance leaf HTTP server — smoke', () => {
  it('GET /healthz → 200 {status:ok} (guard-exempt)', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('a guarded route with no secret → 403', async () => {
    const res = await fetch(`${base}/api/v1/budget`)
    expect(res.status).toBe(403)
  })

  it('a guarded route with a bad tenant slug → 400', async () => {
    const res = await fetch(`${base}/api/v1/budget`, {
      headers: { ...TENANT_HEADERS, 'x-tenant-slug': 'BAD_SLUG' },
    })
    expect(res.status).toBe(400)
  })

  it('a matched + guarded route is surface-locked to 501', async () => {
    const res = await fetch(`${base}/api/v1/budget`, { headers: TENANT_HEADERS })
    expect(res.status).toBe(501)
    const body = await res.json()
    expect(body).toMatchObject({ success: false })
    expect(String(body.error)).toMatch(/not implemented|surface locked/i)
  })

  it('a byte-path (statement/pdf) is also surface-locked to 501 (guarded)', async () => {
    const res = await fetch(`${base}/api/v1/budget-plans/1/statement/pdf`, { headers: TENANT_HEADERS })
    expect(res.status).toBe(501)
  })

  it('an unknown guarded path → 404', async () => {
    const res = await fetch(`${base}/api/v1/nope`, { headers: TENANT_HEADERS })
    expect(res.status).toBe(404)
  })

  it('a wrong method on a known path → 405 with an Allow header', async () => {
    const res = await fetch(`${base}/api/v1/budget`, { method: 'DELETE', headers: TENANT_HEADERS })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toContain('GET')
  })
})

// ── #369 slice-3 sub-org saga endpoints against a REAL disposable Postgres ──────
// The finance_unit sub-org write + referential-count endpoints return REAL results
// (not 501). Runs against FINANCE_TEST_PG_URL (a local throwaway Postgres);
// fail-closed guard: localhost-only + the finance_test_ DB-name prefix.

// FINANCE_TEST_PG_URL MUST be set explicitly to a throwaway Postgres on a
// NON-5432 port. We refuse to default to localhost:5432 — on this host that port
// is the LIVE staging Postgres, and this suite CREATEs/DROPs/TRUNCATEs databases.
const TEST_PG_URL = requireEphemeralTestPgUrl()
const TEST_DB_PREFIX = 'finance_test_'

function requireEphemeralTestPgUrl(): string {
  const url = process.env.FINANCE_TEST_PG_URL
  if (!url) {
    throw new Error(
      '[fin-test-guard] FINANCE_TEST_PG_URL is REQUIRED for the finance integration suite — ' +
        'refusing to default to localhost:5432 (the LIVE staging Postgres on this host, which this ' +
        'suite would CREATE/DROP/TRUNCATE against). Start an ephemeral throwaway container on a ' +
        'NON-5432 port and export the URL, e.g.:\n' +
        '  docker run --rm -d --name fin-test-pg -p 127.0.0.1:55434:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine\n' +
        '  export FINANCE_TEST_PG_URL=postgres://postgres@localhost:55434/postgres',
    )
  }
  return url
}

function assertSafeTestEnv(url: string, dbPrefix: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`[fin-test-guard] must use postgres:// scheme. Got: ${parsed.protocol}`)
  }
  const rawHost = parsed.hostname.toLowerCase()
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(host)) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: non-localhost host "${host}" — refusing.`)
  }
  // Port 5432 (and the implicit default, i.e. empty port) is the LIVE staging PG
  // on this host — reject it outright so a misconfiguration can never hit live data.
  if (parsed.port === '' || parsed.port === '5432') {
    throw new Error(
      `[fin-test-guard] SAFETY VIOLATION: port "${parsed.port || '(implicit default 5432)'}" is the live ` +
        'Postgres — refusing. Use a throwaway container on a non-5432 port (e.g. 55434).',
    )
  }
  if (!dbPrefix.startsWith('finance_test_')) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: dbPrefix "${dbPrefix}" — refusing.`)
  }
}
assertSafeTestEnv(TEST_PG_URL, TEST_DB_PREFIX)

const SAGA_TENANT: TenantRef = { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', slug: 'sagaslice3' }
const SAGA_HEADERS = {
  'x-internal-auth': SECRET,
  'x-tenant-id': SAGA_TENANT.id,
  'x-tenant-slug': SAGA_TENANT.slug,
  'content-type': 'application/json',
}
const OU_A = '11111111-aaaa-4aaa-8aaa-111111111111'
const OU_B = '22222222-bbbb-4bbb-8bbb-222222222222'
const OU_UNUSED = '33333333-cccc-4ccc-8ccc-333333333333'

describe('finance leaf — slice-3 sub-org saga endpoints (real PG)', () => {
  let sagaServer: ReturnType<typeof createServer>
  let sagaBase: string
  let sql: Sql

  beforeAll(async () => {
    await _resetTenantStoreForTests()
    // First contact creates + migrates finance_test_sagaslice3, returns its pool.
    sql = await storeFor(SAGA_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const storeFn = (t: TenantRef) => storeFor(t, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    sagaServer = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => sagaServer.listen(0, '127.0.0.1', resolve))
    sagaBase = `http://127.0.0.1:${(sagaServer.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    if (sagaServer) await new Promise<void>((resolve) => sagaServer.close(() => resolve()))
    await _resetTenantStoreForTests()
  })

  beforeEach(async () => {
    await sql`TRUNCATE finance.project, finance.expense, finance.finance_unit RESTART IDENTITY CASCADE`
  })

  it('POST /api/v1/sub-orgs creates a REAL finance_unit (not 501)', async () => {
    const res = await fetch(`${sagaBase}/api/v1/sub-orgs`, {
      method: 'POST',
      headers: SAGA_HEADERS,
      body: JSON.stringify({ org_unit_id: OU_A }),
    })
    expect(res.status, await res.clone().text()).toBe(200)
    const fu = await res.json()
    expect(fu.org_unit_id).toBe(OU_A)
    expect(typeof fu.id).toBe('number')
    const rows = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM finance.finance_unit WHERE org_unit_id = ${OU_A}`
    expect(rows[0]!.c).toBe(1)
  })

  it('GET /api/v1/org-units/:id/finance-refs → referenced:true when the pair exists, false when clear', async () => {
    await sql`INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
              VALUES (${OU_A}, 'standard', 'central', 'carry_forward')`
    const a = await (await fetch(`${sagaBase}/api/v1/org-units/${OU_A}/finance-refs`, { headers: SAGA_HEADERS })).json()
    expect(a.referenced).toBe(true)
    expect(a.counts.finance_unit).toBe(1)
    const u = await (await fetch(`${sagaBase}/api/v1/org-units/${OU_UNUSED}/finance-refs`, { headers: SAGA_HEADERS })).json()
    expect(u.referenced).toBe(false)
  })

  it('DELETE /api/v1/sub-orgs/:id deletes the finance_unit and returns org_unit_id when clear', async () => {
    const ins = await sql<{ id: string }[]>`
      INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
      VALUES (${OU_A}, 'standard', 'central', 'carry_forward') RETURNING id`
    const id = ins[0]!.id
    const res = await fetch(`${sagaBase}/api/v1/sub-orgs/${id}`, { method: 'DELETE', headers: SAGA_HEADERS })
    expect(res.status, await res.clone().text()).toBe(200)
    expect((await res.json()).org_unit_id).toBe(OU_A)
    const rows = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM finance.finance_unit WHERE id = ${id}`
    expect(rows[0]!.c).toBe(0)
  })

  it('DELETE /api/v1/sub-orgs/:id → 409 (RESTRICT-equivalent) when a finance row still references the org unit', async () => {
    const ins = await sql<{ id: string }[]>`
      INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
      VALUES (${OU_B}, 'standard', 'central', 'carry_forward') RETURNING id`
    const id = ins[0]!.id
    await sql`INSERT INTO finance.project (org_unit_id, type, name) VALUES (${OU_B}, 'internal', 'Blocking project')`
    const res = await fetch(`${sagaBase}/api/v1/sub-orgs/${id}`, { method: 'DELETE', headers: SAGA_HEADERS })
    expect(res.status).toBe(409)
    // the finance_unit must NOT have been deleted.
    const rows = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM finance.finance_unit WHERE id = ${id}`
    expect(rows[0]!.c).toBe(1)
  })
})

// ── #383 leaf gap-close — store-backed CRUD domains against a REAL disposable PG ──
// A full HTTP round-trip through the booted node:http server (guard → router →
// store-backed handler → PG → DTO), proving VALUE parity (DTO shape + coercion),
// not just verb+path. One throwaway DB (finance_test_crudslice) is shared across
// the domain suites; each suite truncates the tables it touches in beforeEach.

const CRUD_TENANT: TenantRef = { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', slug: 'crudslice' }
const CRUD_HEADERS = {
  'x-internal-auth': SECRET,
  'x-tenant-id': CRUD_TENANT.id,
  'x-tenant-slug': CRUD_TENANT.slug,
  'content-type': 'application/json',
}

describe('finance leaf — store-backed CRUD domains (real PG)', () => {
  let crudServer: ReturnType<typeof createServer>
  let crudBase: string
  let sql: Sql

  beforeAll(async () => {
    await _resetTenantStoreForTests()
    sql = await storeFor(CRUD_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const storeFn = (t: TenantRef) => storeFor(t, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    crudServer = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => crudServer.listen(0, '127.0.0.1', resolve))
    crudBase = `http://127.0.0.1:${(crudServer.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    if (crudServer) await new Promise<void>((resolve) => crudServer.close(() => resolve()))
    await _resetTenantStoreForTests()
  })

  const get = (path: string) => fetch(`${crudBase}${path}`, { headers: CRUD_HEADERS })
  const post = (path: string, body: unknown) =>
    fetch(`${crudBase}${path}`, { method: 'POST', headers: CRUD_HEADERS, body: JSON.stringify(body) })
  const patch = (path: string, body: unknown) =>
    fetch(`${crudBase}${path}`, { method: 'PATCH', headers: CRUD_HEADERS, body: JSON.stringify(body) })

  // ── fiscal_year ───────────────────────────────────────────────────────────────
  describe('fiscal-years', () => {
    beforeEach(async () => {
      await sql`TRUNCATE finance.fiscal_year RESTART IDENTITY CASCADE`
    })

    it('POST /api/v1/fiscal-years creates a REAL fiscal_year and returns the FiscalYear DTO (not 501)', async () => {
      const res = await post('/api/v1/fiscal-years', { name: 'HH 2026', start_date: '2026-01-01', end_date: '2026-12-31' })
      expect(res.status, await res.clone().text()).toBe(200)
      const fy = await res.json()
      expect(fy).toEqual({ id: fy.id, name: 'HH 2026', start_date: '2026-01-01', end_date: '2026-12-31' })
      expect(typeof fy.id).toBe('number')
      const rows = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM finance.fiscal_year WHERE id = ${fy.id}`
      expect(rows[0]!.c).toBe(1)
    })

    it('GET /api/v1/fiscal-years lists rows ordered by start_date with YYYY-MM-DD dates + numeric id', async () => {
      await post('/api/v1/fiscal-years', { name: 'HH 2027', start_date: '2027-01-01', end_date: '2027-12-31' })
      await post('/api/v1/fiscal-years', { name: 'HH 2025', start_date: '2025-01-01', end_date: '2025-12-31' })
      const res = await get('/api/v1/fiscal-years')
      expect(res.status).toBe(200)
      const list = await res.json()
      expect(list.map((f: { name: string }) => f.name)).toEqual(['HH 2025', 'HH 2027']) // start_date ASC
      expect(list[0]).toEqual({ id: list[0].id, name: 'HH 2025', start_date: '2025-01-01', end_date: '2025-12-31' })
      expect(typeof list[0].id).toBe('number')
    })

    it('PATCH /api/v1/fiscal-years/:id patches only provided keys and returns the refreshed DTO', async () => {
      const created = await (await post('/api/v1/fiscal-years', { name: 'Old', start_date: '2026-01-01', end_date: '2026-12-31' })).json()
      const res = await patch(`/api/v1/fiscal-years/${created.id}`, { name: 'Renamed' })
      expect(res.status, await res.clone().text()).toBe(200)
      expect(await res.json()).toEqual({ id: created.id, name: 'Renamed', start_date: '2026-01-01', end_date: '2026-12-31' })
    })

    it('POST with end_date <= start_date → 400 (degenerate year, no row written)', async () => {
      const res = await post('/api/v1/fiscal-years', { name: 'Bad', start_date: '2026-12-31', end_date: '2026-01-01' })
      expect(res.status).toBe(400)
      const rows = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM finance.fiscal_year`
      expect(rows[0]!.c).toBe(0)
    })

    it('PATCH a non-existent fiscal_year → 404', async () => {
      const res = await patch('/api/v1/fiscal-years/999999', { name: 'x' })
      expect(res.status).toBe(404)
    })
  })

  // ── scope-sensitive reads — VALUE PARITY (R10, four lenses) ──────────────────────
  // #383 Lane A resolved the R10 residual sub-lock: the ACL now forwards the actor's
  // finance read scope over three internal headers (x-finance-is-auditor /
  // x-finance-is-superuser / x-finance-scoped-org-units) and the leaf reproduces the
  // native oracle's per-actor row-scoping (services/read/{expense,bank-account,receipt,
  // fints}.ts). A full HTTP round-trip through the booted server against REAL PG proves
  // VALUE parity — not just verb+path — across four lenses:
  //   (i)   an auditor sees ALL rows;
  //   (ii)  a scoped member sees ONLY its own org-unit rows;
  //   (iii) an out-of-scope-but-EXISTING id → 404 (G-019 anti-probing), incl. the FinTS
  //         config sub-case (WITH + WITHOUT a fints_config row both 404 — no leak);
  //   (iv)  an empty scope → empty list / 404.
  // Plus the THREE-SIGNAL asymmetry that motivates the contract: a superuser-not-auditor
  // with an EMPTY scope sees NO bank accounts (bank/fints gate on isAuditor only) but ALL
  // expenses (expense/receipt honour seesAllFinance = isAuditor||isSuperuser).
  describe('scope-sensitive reads — value parity (R10, four lenses + three-signal asymmetry)', () => {
    // org units — distinct from the saga suite's module-scoped OU_* UUIDs.
    const OU_1 = 'a1111111-aaaa-4aaa-8aaa-a11111111111'
    const OU_2 = 'b2222222-bbbb-4bbb-8bbb-b22222222222'
    // Populated by the fixture seed (BIGINT ids come back as strings from postgres-js).
    let fuA = '', fuB = ''
    let baA = '', baB = '', baB2 = '' // baA: OU_1 + config; baB: OU_2 no config; baB2: OU_2 + config
    let expA = '', expB = ''

    // Scope-header helpers — the leaf's scopeFromHeaders() reconstructs a ScopeContext.
    type Scope = { isAuditor: boolean; isSuperuser: boolean; orgUnits: string[] }
    const AUDITOR: Scope = { isAuditor: true, isSuperuser: false, orgUnits: [] }
    const MEMBER_1: Scope = { isAuditor: false, isSuperuser: false, orgUnits: [OU_1] }
    const EMPTY: Scope = { isAuditor: false, isSuperuser: false, orgUnits: [] }
    const SUPERUSER_EMPTY: Scope = { isAuditor: false, isSuperuser: true, orgUnits: [] }
    const scopeHeaders = (s: Scope): Record<string, string> => ({
      ...CRUD_HEADERS,
      'x-finance-is-auditor': String(s.isAuditor),
      'x-finance-is-superuser': String(s.isSuperuser),
      ...(s.orgUnits.length > 0 ? { 'x-finance-scoped-org-units': s.orgUnits.join(',') } : {}),
    })
    const sget = (path: string, s: Scope) => fetch(`${crudBase}${path}`, { headers: scopeHeaders(s) })

    beforeAll(async () => {
      // Fresh, deterministic fixture: two org units, three bank accounts (2 configured),
      // two expenses (one per org unit), one receipt each. FK-safe insert order.
      await sql`TRUNCATE finance.receipt, finance.expense, finance.fints_config,
                finance.ledger_account, finance.bank_account, finance.finance_unit
                RESTART IDENTITY CASCADE`
      const fu = async (ou: string) => (await sql<{ id: string }[]>`
        INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
        VALUES (${ou}, 'standard', 'own', 'carry_forward') RETURNING id`)[0]!.id
      fuA = await fu(OU_1)
      fuB = await fu(OU_2)
      const ba = async (name: string, iban: string) => (await sql<{ id: string }[]>`
        INSERT INTO finance.bank_account (name, iban) VALUES (${name}, ${iban}) RETURNING id`)[0]!.id
      baA = await ba('Konto OU1', 'DE00000000000000000001')
      baB = await ba('Konto OU2', 'DE00000000000000000002')
      baB2 = await ba('Konto OU2 2', 'DE00000000000000000003')
      const ledger = (fuId: string, baId: string, name: string) => sql`
        INSERT INTO finance.ledger_account (finance_unit_id, bank_account_id, type, name)
        VALUES (${fuId}, ${baId}, 'own_account', ${name})`
      await ledger(fuA, baA, 'LA OU1')
      await ledger(fuB, baB, 'LA OU2')
      await ledger(fuB, baB2, 'LA OU2 2')
      const cfg = (baId: string) => sql`
        INSERT INTO finance.fints_config (bank_account_id, fints_url, bank_code, username, password_encrypted)
        VALUES (${baId}, 'https://fints.example', '37040044', 'stura', 'enc')`
      await cfg(baA)  // in-scope-for-OU1 + configured
      await cfg(baB2) // out-of-scope-for-OU1 + configured (G-019 WITH-config sub-case)
      const expense = async (fuId: string, payee: string) => (await sql<{ id: string }[]>`
        INSERT INTO finance.expense (finance_unit_id, payee_name, payment_method, state)
        VALUES (${fuId}, ${payee}, 'bank_transfer', 'approved') RETURNING id`)[0]!.id
      expA = await expense(fuA, 'Payee OU1')
      expB = await expense(fuB, 'Payee OU2')
      await sql`INSERT INTO finance.receipt (expense_id, beleg_nr, beleg_date) VALUES (${expA}, 'RA-1', '2026-01-05')`
      await sql`INSERT INTO finance.receipt (expense_id, beleg_nr, beleg_date) VALUES (${expB}, 'RB-1', '2026-02-05')`
    })

    // ── Lens (i): auditor sees ALL ────────────────────────────────────────────────
    describe('(i) auditor sees all', () => {
      it('listBankAccounts → all three accounts', async () => {
        const res = await sget('/api/v1/bank-accounts', AUDITOR)
        expect(res.status, await res.clone().text()).toBe(200)
        const ids = (await res.json()).map((b: { id: number }) => b.id).sort((a: number, b: number) => a - b)
        expect(ids).toEqual([Number(baA), Number(baB), Number(baB2)])
      })
      it('listExpenses → both expenses (total 2)', async () => {
        const res = await sget('/api/v1/expenses', AUDITOR)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.meta.total).toBe(2)
        expect(body.data.map((e: { id: number }) => e.id).sort((a: number, b: number) => a - b)).toEqual([Number(expA), Number(expB)])
      })
      it('getExpense(out-of-nothing) + getFintsStatus + listReceipts all resolve for any account', async () => {
        expect((await sget(`/api/v1/expenses/${expB}`, AUDITOR)).status).toBe(200)
        const configured = await sget(`/api/v1/bank-accounts/${baA}/fints`, AUDITOR)
        expect(configured.status).toBe(200)
        expect((await configured.json()).configured).toBe(true)
        const unconfigured = await sget(`/api/v1/bank-accounts/${baB}/fints`, AUDITOR)
        expect(unconfigured.status).toBe(200)
        expect((await unconfigured.json()).configured).toBe(false)
        const receipts = await sget(`/api/v1/expenses/${expB}/receipts`, AUDITOR)
        expect(receipts.status).toBe(200)
        expect((await receipts.json())).toHaveLength(1)
      })
    })

    // ── Lens (ii): scoped member sees ONLY its org-unit rows ──────────────────────
    describe('(ii) scoped member (OU_1) sees only its own org-unit rows', () => {
      it('listBankAccounts → only OU_1 account (baA)', async () => {
        const res = await sget('/api/v1/bank-accounts', MEMBER_1)
        expect(res.status).toBe(200)
        expect((await res.json()).map((b: { id: number }) => b.id)).toEqual([Number(baA)])
      })
      it('listExpenses → only OU_1 expense, total 1', async () => {
        const res = await sget('/api/v1/expenses', MEMBER_1)
        const body = await res.json()
        expect(body.meta.total).toBe(1)
        expect(body.data.map((e: { id: number }) => e.id)).toEqual([Number(expA)])
      })
      it('getExpense / listReceipts / getFintsStatus resolve for the in-scope resources', async () => {
        expect((await sget(`/api/v1/expenses/${expA}`, MEMBER_1)).status).toBe(200)
        expect((await sget(`/api/v1/expenses/${expA}/receipts`, MEMBER_1)).status).toBe(200)
        const fints = await sget(`/api/v1/bank-accounts/${baA}/fints`, MEMBER_1)
        expect(fints.status).toBe(200)
        expect((await fints.json()).configured).toBe(true)
      })
    })

    // ── Lens (iii): out-of-scope-but-EXISTING id → 404 (G-019 anti-probing) ───────
    describe('(iii) out-of-scope-but-existing id → 404 (incl. FinTS config sub-case)', () => {
      it('getExpense(OU_2 expense) → 404', async () => {
        expect((await sget(`/api/v1/expenses/${expB}`, MEMBER_1)).status).toBe(404)
      })
      it('listReceipts(OU_2 expense) → 404 (no receipt leak)', async () => {
        expect((await sget(`/api/v1/expenses/${expB}/receipts`, MEMBER_1)).status).toBe(404)
      })
      it('getFintsStatus(out-of-scope account WITHOUT config) → 404, no {configured:false} leak', async () => {
        const res = await sget(`/api/v1/bank-accounts/${baB}/fints`, MEMBER_1)
        expect(res.status).toBe(404)
        expect(await res.json()).not.toHaveProperty('configured')
      })
      it('getFintsStatus(out-of-scope account WITH config) → 404, no {configured:true} leak', async () => {
        const res = await sget(`/api/v1/bank-accounts/${baB2}/fints`, MEMBER_1)
        expect(res.status).toBe(404)
        expect(await res.json()).not.toHaveProperty('configured')
      })
    })

    // ── Lens (iv): empty scope → empty / 404 ──────────────────────────────────────
    describe('(iv) empty scope (non-auditor) → empty list / 404', () => {
      it('listBankAccounts → []', async () => {
        const res = await sget('/api/v1/bank-accounts', EMPTY)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
      })
      it('listExpenses → empty page, total 0', async () => {
        const body = await (await sget('/api/v1/expenses', EMPTY)).json()
        expect(body.data).toEqual([])
        expect(body.meta.total).toBe(0)
      })
      it('getExpense / listReceipts / getFintsStatus on existing ids → 404', async () => {
        expect((await sget(`/api/v1/expenses/${expA}`, EMPTY)).status).toBe(404)
        expect((await sget(`/api/v1/expenses/${expA}/receipts`, EMPTY)).status).toBe(404)
        expect((await sget(`/api/v1/bank-accounts/${baA}/fints`, EMPTY)).status).toBe(404)
      })
    })

    // ── Three-signal asymmetry: the failure case the collapsed sees-all bool misses ─
    describe('three-signal asymmetry — superuser-not-auditor with EMPTY scope', () => {
      it('sees NO bank accounts (bank/fints gate on isAuditor only)', async () => {
        const res = await sget('/api/v1/bank-accounts', SUPERUSER_EMPTY)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual([])
      })
      it('getFintsStatus → 404 (still org-unit-scoped for fints)', async () => {
        expect((await sget(`/api/v1/bank-accounts/${baA}/fints`, SUPERUSER_EMPTY)).status).toBe(404)
      })
      it('but sees ALL expenses (expense/receipt honour seesAllFinance = auditor||superuser)', async () => {
        const body = await (await sget('/api/v1/expenses', SUPERUSER_EMPTY)).json()
        expect(body.meta.total).toBe(2)
        expect(body.data.map((e: { id: number }) => e.id).sort((a: number, b: number) => a - b)).toEqual([Number(expA), Number(expB)])
      })
      it('and getExpense + listReceipts on any expense resolve (see-all)', async () => {
        expect((await sget(`/api/v1/expenses/${expB}`, SUPERUSER_EMPTY)).status).toBe(200)
        const receipts = await sget(`/api/v1/expenses/${expB}/receipts`, SUPERUSER_EMPTY)
        expect(receipts.status).toBe(200)
        expect(await receipts.json()).toHaveLength(1)
      })
    })
  })

  // ── Lane B read domains — VALUE PARITY (four lenses + superuser-sees-all) ─────────
  // #383 Lane B unlocked getBudget / getBudgetPlan / getBudgetStatement / listBookings.
  // Same three-signal scope-forwarding contract as Lane A, but ALL FOUR ops scope via
  // scopedFinanceUnitIds (which honours seesAllFinance), so — unlike bank_account/fints —
  // a superuser-not-auditor SEES ALL here. A full HTTP round-trip against REAL PG proves
  // VALUE parity (nested budget detail w/ booked actuals, interim statement surplus,
  // paginated bookings) across four lenses:
  //   (i)   auditor sees ALL;
  //   (ii)  a scoped member (OU_1) sees ONLY its org-unit plans/bookings;
  //   (iii) an out-of-scope-but-EXISTING plan → getBudgetPlan + getBudgetStatement 404
  //         (G-019 anti-probing), while getBudget + listBookings simply omit it;
  //   (iv)  an empty scope → empty list / 404;
  // PLUS the superuser-not-auditor-EMPTY-scope case, which SEES ALL for all four ops.
  describe('budget read domains — value parity (Lane B, four lenses + superuser-sees-all)', () => {
    const OU_1 = 'c3333333-cccc-4ccc-8ccc-c33333333333'
    const OU_2 = 'd4444444-dddd-4ddd-8ddd-d44444444444'
    // populated by the fixture seed (BIGINT ids come back as strings from postgres-js)
    let planA = '', planB = ''
    let bkA = '', bkB = ''

    type Scope = { isAuditor: boolean; isSuperuser: boolean; orgUnits: string[] }
    const AUDITOR: Scope = { isAuditor: true, isSuperuser: false, orgUnits: [] }
    const MEMBER_1: Scope = { isAuditor: false, isSuperuser: false, orgUnits: [OU_1] }
    const EMPTY: Scope = { isAuditor: false, isSuperuser: false, orgUnits: [] }
    const SUPERUSER_EMPTY: Scope = { isAuditor: false, isSuperuser: true, orgUnits: [] }
    const scopeHeaders = (s: Scope): Record<string, string> => ({
      ...CRUD_HEADERS,
      'x-finance-is-auditor': String(s.isAuditor),
      'x-finance-is-superuser': String(s.isSuperuser),
      ...(s.orgUnits.length > 0 ? { 'x-finance-scoped-org-units': s.orgUnits.join(',') } : {}),
    })
    const sget = (path: string, s: Scope) => fetch(`${crudBase}${path}`, { headers: scopeHeaders(s) })

    beforeAll(async () => {
      // Two org units, one budget plan + one posted booking each. FK-safe insert order.
      await sql`TRUNCATE finance.booking, finance.bank_transaction, finance.budget_titel,
                finance.budget_group, finance.budget_section, finance.budget_plan,
                finance.fiscal_year, finance.ledger_account, finance.bank_account,
                finance.finance_unit RESTART IDENTITY CASCADE`
      const fu = async (ou: string) => (await sql<{ id: string }[]>`
        INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
        VALUES (${ou}, 'standard', 'own', 'carry_forward') RETURNING id`)[0]!.id
      const fuA = await fu(OU_1)
      const fuB = await fu(OU_2)
      const fy = (await sql<{ id: string }[]>`
        INSERT INTO finance.fiscal_year (name, start_date, end_date)
        VALUES ('HH 2026', '2026-01-01', '2026-12-31') RETURNING id`)[0]!.id
      const ba = async (name: string, iban: string) => (await sql<{ id: string }[]>`
        INSERT INTO finance.bank_account (name, iban) VALUES (${name}, ${iban}) RETURNING id`)[0]!.id
      const baA = await ba('Konto A', 'DE00000000000000000011')
      const baB = await ba('Konto B', 'DE00000000000000000012')
      const ledger = async (fuId: string, baId: string, name: string) => (await sql<{ id: string }[]>`
        INSERT INTO finance.ledger_account (finance_unit_id, bank_account_id, type, name)
        VALUES (${fuId}, ${baId}, 'own_account', ${name}) RETURNING id`)[0]!.id
      const laA = await ledger(fuA, baA, 'Kasse A')
      const laB = await ledger(fuB, baB, 'Kasse B')
      const plan = async (name: string) => (await sql<{ id: string }[]>`
        INSERT INTO finance.budget_plan (fiscal_year_id, name) VALUES (${fy}, ${name}) RETURNING id`)[0]!.id
      planA = await plan('Plan A')
      planB = await plan('Plan B')
      const section = async (planId: string, fuId: string) => (await sql<{ id: string }[]>`
        INSERT INTO finance.budget_section (budget_plan_id, finance_unit_id)
        VALUES (${planId}, ${fuId}) RETURNING id`)[0]!.id
      const secA = await section(planA, fuA)
      const secB = await section(planB, fuB)
      const group = async (secId: string) => (await sql<{ id: string }[]>`
        INSERT INTO finance.budget_group (budget_section_id, name, budget_type)
        VALUES (${secId}, 'Einnahmen', 'income') RETURNING id`)[0]!.id
      const grpA = await group(secA)
      const grpB = await group(secB)
      const titel = async (grpId: string, planned: number) => (await sql<{ id: string }[]>`
        INSERT INTO finance.budget_titel (budget_group_id, titel_nr, titel_name, planned_cents)
        VALUES (${grpId}, '1.1', 'Beiträge', ${planned}) RETURNING id`)[0]!.id
      const titA = await titel(grpA, 10000)
      const titB = await titel(grpB, 20000)
      // bank_transaction backs the belegprinzip CHECK for a POSTED booking.
      const btx = async (baId: string, hash: string, cents: number) => (await sql<{ id: string }[]>`
        INSERT INTO finance.bank_transaction (bank_account_id, booking_date, amount_cents, import_hash)
        VALUES (${baId}, '2026-03-01', ${cents}, ${hash}) RETURNING id`)[0]!.id
      const btxA = await btx(baA, 'hash-a', 3000)
      const btxB = await btx(baB, 'hash-b', 5000)
      const booking = async (laId: string, titId: string, btxId: string, cents: number, date: string, runningNo: number) => (await sql<{ id: string }[]>`
        INSERT INTO finance.booking (ledger_account_id, budget_titel_id, fiscal_year_id, amount_cents,
                                     booking_date, running_no, payment_type, bank_transaction_id, state)
        VALUES (${laId}, ${titId}, ${fy}, ${cents}, ${date}, ${runningNo}, 'bargeldlos', ${btxId}, 'posted')
        RETURNING id`)[0]!.id
      bkA = await booking(laA, titA, btxA, 3000, '2026-03-01', 1)
      bkB = await booking(laB, titB, btxB, 5000, '2026-02-01', 1)
    })

    // ── Lens (i): auditor sees ALL ────────────────────────────────────────────────
    describe('(i) auditor sees all', () => {
      it('getBudget → both plans (id DESC), each a BudgetPlan DTO', async () => {
        const res = await sget('/api/v1/budget', AUDITOR)
        expect(res.status, await res.clone().text()).toBe(200)
        const plans = await res.json()
        expect(plans.map((p: { id: number }) => p.id)).toEqual([Number(planB), Number(planA)])
        expect(plans[0]).toEqual({ id: Number(planB), von: '2026-01-01', bis: '2026-12-31', state: 'draft', groups: [] })
      })
      it('getBudgetPlan(A) → nested detail with booked actuals (value 10000, booked 3000, remaining 7000)', async () => {
        const res = await sget(`/api/v1/budget-plans/${planA}`, AUDITOR)
        expect(res.status).toBe(200)
        const detail = await res.json()
        expect(detail.id).toBe(Number(planA))
        expect(detail.groups).toHaveLength(1)
        expect(detail.groups[0].items[0]).toEqual({
          id: detail.groups[0].items[0].id, titel_nr: '1.1', titel_name: 'Beiträge',
          value: 10000, booked: 3000, remaining: 7000,
        })
      })
      it('getBudgetStatement(A) → interim surplus = planned − ist = 7000', async () => {
        const res = await sget(`/api/v1/budget-plans/${planA}/statement`, AUDITOR)
        expect(res.status).toBe(200)
        const st = await res.json()
        expect(st).toMatchObject({ plan_id: Number(planA), closed_at: null, surplus: 7000 })
      })
      it('listBookings → both bookings (total 2), sorted booking_date DESC', async () => {
        const res = await sget('/api/v1/bookings', AUDITOR)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.meta).toMatchObject({ per_page: 50, total: 2 })
        expect(body.data.map((b: { id: number }) => b.id)).toEqual([Number(bkA), Number(bkB)]) // 03-01 before 02-01
        expect(body.data[0]).toMatchObject({ account_id: body.data[0].account_id, value: 3000, empf_name: 'Beiträge', empf_iban: '', saldo: 0, date: '2026-03-01' })
      })
    })

    // ── Lens (ii): scoped member (OU_1) sees ONLY its rows ────────────────────────
    describe('(ii) scoped member (OU_1) sees only its own org-unit rows', () => {
      it('getBudget → only Plan A', async () => {
        const plans = await (await sget('/api/v1/budget', MEMBER_1)).json()
        expect(plans.map((p: { id: number }) => p.id)).toEqual([Number(planA)])
      })
      it('getBudgetPlan(A) + getBudgetStatement(A) resolve', async () => {
        expect((await sget(`/api/v1/budget-plans/${planA}`, MEMBER_1)).status).toBe(200)
        expect((await sget(`/api/v1/budget-plans/${planA}/statement`, MEMBER_1)).status).toBe(200)
      })
      it('listBookings → only OU_1 booking, total 1', async () => {
        const body = await (await sget('/api/v1/bookings', MEMBER_1)).json()
        expect(body.meta.total).toBe(1)
        expect(body.data.map((b: { id: number }) => b.id)).toEqual([Number(bkA)])
      })
    })

    // ── Lens (iii): out-of-scope-but-EXISTING plan → 404 (G-019 anti-probing) ─────
    describe('(iii) out-of-scope-but-existing plan → 404', () => {
      it('getBudgetPlan(B) → 404', async () => {
        expect((await sget(`/api/v1/budget-plans/${planB}`, MEMBER_1)).status).toBe(404)
      })
      it('getBudgetStatement(B) → 404 (no surplus leak)', async () => {
        const res = await sget(`/api/v1/budget-plans/${planB}/statement`, MEMBER_1)
        expect(res.status).toBe(404)
        expect(await res.json()).not.toHaveProperty('surplus')
      })
    })

    // ── Lens (iv): empty scope → empty / 404 ──────────────────────────────────────
    describe('(iv) empty scope (non-auditor) → empty list / 404', () => {
      it('getBudget → []', async () => {
        expect(await (await sget('/api/v1/budget', EMPTY)).json()).toEqual([])
      })
      it('listBookings → empty page, total 0', async () => {
        const body = await (await sget('/api/v1/bookings', EMPTY)).json()
        expect(body.data).toEqual([])
        expect(body.meta.total).toBe(0)
      })
      it('getBudgetPlan(A) + getBudgetStatement(A) → 404', async () => {
        expect((await sget(`/api/v1/budget-plans/${planA}`, EMPTY)).status).toBe(404)
        expect((await sget(`/api/v1/budget-plans/${planA}/statement`, EMPTY)).status).toBe(404)
      })
    })

    // ── superuser-not-auditor (EMPTY scope) SEES ALL for all four ops ─────────────
    describe('superuser-not-auditor with EMPTY scope sees ALL (all four ops)', () => {
      it('getBudget → both plans', async () => {
        const plans = await (await sget('/api/v1/budget', SUPERUSER_EMPTY)).json()
        expect(plans.map((p: { id: number }) => p.id).sort((a: number, b: number) => a - b)).toEqual([Number(planA), Number(planB)])
      })
      it('getBudgetPlan(B) + getBudgetStatement(B) resolve (see-all, not 404)', async () => {
        expect((await sget(`/api/v1/budget-plans/${planB}`, SUPERUSER_EMPTY)).status).toBe(200)
        const st = await sget(`/api/v1/budget-plans/${planB}/statement`, SUPERUSER_EMPTY)
        expect(st.status).toBe(200)
        expect(await st.json()).toMatchObject({ plan_id: Number(planB), surplus: 15000 }) // 20000 − 5000
      })
      it('listBookings → both bookings (total 2)', async () => {
        const body = await (await sget('/api/v1/bookings', SUPERUSER_EMPTY)).json()
        expect(body.meta.total).toBe(2)
      })
    })
  })
})

// ── #383 Lane C — Vier-Augen approval family + createExpense against REAL PG ──────
// The load-bearing state-machine matrix. A full HTTP round-trip (guard → router →
// store-backed handler → PG → DTO) proving the ported native workflow end-to-end:
//   - createExpense: auditor 403 / superuser + scoped-member write; inserts state
//     'draft'; the returned ExpenseDetail byte-matches a subsequent getExpense.
//   - approval state machine: happy multi-stage (sign each stage; the final stage
//     inserts + authorises a payment_order via the certifies-token signer map and
//     flips the expense to approved); creator-approves-own → SELF_APPROVAL 403;
//     duplicate signer on a later stage → DUPLICATE_SIGNER 403; sign a decided
//     approval → ALREADY_DECIDED 409; helios approval manual-sign →
//     HELIOS_NOT_MANUALLY_SIGNABLE 403; reject with empty note →
//     REJECTION_NOTE_REQUIRED 400; reject voids a pending payment_order + flips the
//     expense to rejected; no active profile → NO_ACTIVE_PROFILE 500; and
//     step_up_loa/step_up_at persist byte-identically to the FORWARDED values (a
//     fixed-clock body value, NOT a leaf-generated timestamp).
//   - listPendingApprovals across the four scope lenses (auditor-all / superuser-all
//     / scoped-member-own-units-only / empty-scope-none), incl. out-of-scope
//     anti-probing, and ORDER BY a.id parity.

const LANEC_TENANT: TenantRef = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', slug: 'lanec' }
const LANEC_BASE_HEADERS = {
  'x-internal-auth': SECRET,
  'x-tenant-id': LANEC_TENANT.id,
  'x-tenant-slug': LANEC_TENANT.slug,
  'content-type': 'application/json',
}
const LC_OU1 = 'c1111111-aaaa-4aaa-8aaa-c11111111111'
const LC_OU2 = 'c2222222-bbbb-4bbb-8bbb-c22222222222'

interface WriteActor {
  userId: string
  isAuditor?: boolean
  isSuperuser?: boolean
  orgUnits?: string[]
  groups?: string[]
}
function actorHeaders(a: WriteActor): Record<string, string> {
  return {
    ...LANEC_BASE_HEADERS,
    'x-finance-user-id': a.userId,
    'x-finance-is-auditor': String(!!a.isAuditor),
    'x-finance-is-superuser': String(!!a.isSuperuser),
    ...(a.orgUnits && a.orgUnits.length > 0 ? { 'x-finance-scoped-org-units': a.orgUnits.join(',') } : {}),
    ...(a.groups && a.groups.length > 0 ? { 'x-finance-groups': a.groups.join(',') } : {}),
  }
}

// creator is a superuser (write-gate bypass for createApproval) that ALSO carries the
// KV group so the self-approval test reaches the self-check (group check passes first).
const CREATOR: WriteActor = { userId: 'creator', isSuperuser: true, groups: ['ref-finanzen-kv'] }
const KV: WriteActor = { userId: 'kv-u', groups: ['ref-finanzen-kv'] }
const HV: WriteActor = { userId: 'hv-u', groups: ['ref-finanzen-hv'] }
const MULTI: WriteActor = { userId: 'multi-u', groups: ['ref-finanzen-kv', 'ref-finanzen-hv'] }
const MEMBER1: WriteActor = { userId: 'm1', orgUnits: [LC_OU1] }
const LC_AUDITOR: WriteActor = { userId: 'aud', isAuditor: true }

describe('finance leaf — Lane C approval family + createExpense (real PG)', () => {
  let laneServer: ReturnType<typeof createServer>
  let laneBase: string
  let sql: Sql
  let p1Id: number

  const req = (method: string, path: string, actor: WriteActor, body?: unknown) =>
    fetch(`${laneBase}${path}`, {
      method,
      headers: actorHeaders(actor),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const post = (path: string, actor: WriteActor, body?: unknown) => req('POST', path, actor, body)
  const get = (path: string, actor: WriteActor) => req('GET', path, actor)

  /** Create a draft expense (via the LIVE createExpense) and return its id. */
  async function makeExpense(actor: WriteActor = CREATOR): Promise<number> {
    const res = await post('/api/v1/expenses', actor, {
      projekt_id: p1Id, name_suffix: 'n', zahlung_name: 'Payee GmbH', zahlung_vwzk: 'Zweck',
    })
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()).id
  }
  /** Open an expense approval and return its approval_id. */
  async function openExpenseApproval(expenseId: number): Promise<number> {
    const res = await post(`/api/v1/expenses/${expenseId}/request-approval`, CREATOR)
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()).approval_id
  }

  beforeAll(async () => {
    await _resetTenantStoreForTests()
    sql = await storeFor(LANEC_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const storeFn = (t: TenantRef) => storeFor(t, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    laneServer = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => laneServer.listen(0, '127.0.0.1', resolve))
    laneBase = `http://127.0.0.1:${(laneServer.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    if (laneServer) await new Promise<void>((resolve) => laneServer.close(() => resolve()))
    await _resetTenantStoreForTests()
  })

  beforeEach(async () => {
    // Clean slate + the default KV→HV profile + a central finance_unit (OU1) + a
    // project (OU1) each test opens expenses against.
    await sql`TRUNCATE finance.payment_order, finance.approval, finance.expense,
              finance.project, finance.finance_unit, finance.finanzordnung_profile,
              finance.finance_helios_settings RESTART IDENTITY CASCADE`
    await sql`INSERT INTO finance.finanzordnung_profile (bundesland) VALUES ('BE')`
    await sql`INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
              VALUES (${LC_OU1}, 'central', 'central', 'carry_forward')`
    const p = await sql<{ id: string }[]>`
      INSERT INTO finance.project (org_unit_id, type, name) VALUES (${LC_OU1}, 'internal', 'Projekt 1') RETURNING id`
    p1Id = Number(p[0]!.id)
  })

  // ── createExpense (R9) ─────────────────────────────────────────────────────────
  describe('createExpense', () => {
    it("a scoped member inserts state='draft'; the DTO byte-matches a subsequent getExpense", async () => {
      const res = await post('/api/v1/expenses', MEMBER1, {
        projekt_id: p1Id, name_suffix: 'n', zahlung_name: 'ACME', zahlung_iban: 'DE42', zahlung_vwzk: 'Catering',
      })
      expect(res.status, await res.clone().text()).toBe(200)
      const created = await res.json()
      expect(created.state).toBe('draft')
      expect(created.zahlung_name).toBe('ACME')
      // Auditor sees all → the detail read of the same row must be byte-identical.
      const fetched = await (await get(`/api/v1/expenses/${created.id}`, LC_AUDITOR)).json()
      expect(created).toEqual(fetched)
      const row = await sql<{ state: string }[]>`SELECT state FROM finance.expense WHERE id = ${created.id}`
      expect(row[0]!.state).toBe('draft')
    })

    it('an auditor is refused (403 ACCESS_DENIED — read-only)', async () => {
      const res = await post('/api/v1/expenses', LC_AUDITOR, { projekt_id: p1Id, name_suffix: 'n', zahlung_name: 'X' })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('ACCESS_DENIED')
    })

    it('a member OUTSIDE the org unit is refused (403)', async () => {
      const outsider: WriteActor = { userId: 'out', orgUnits: [LC_OU2] }
      const res = await post('/api/v1/expenses', outsider, { projekt_id: p1Id, name_suffix: 'n', zahlung_name: 'X' })
      expect(res.status).toBe(403)
    })
  })

  // ── approval state machine ───────────────────────────────────────────────────────
  describe('approval workflow state machine', () => {
    it('happy multi-stage: sign KV then HV → payment_order authorised (certifies-token map) + expense approved', async () => {
      const expenseId = await makeExpense()
      const approvalId = await openExpenseApproval(expenseId)

      // Stage 0 (KV) — advances to stage 1, still pending.
      const s0 = await post(`/api/v1/approvals/${approvalId}/sign`, KV, { note: 'kv ok' })
      expect(s0.status, await s0.clone().text()).toBe(200)
      expect(await s0.json()).toBe('pending')

      // Stage 1 (HV) — final stage → approved.
      const s1 = await post(`/api/v1/approvals/${approvalId}/sign`, HV, { note: 'hv ok' })
      expect(s1.status, await s1.clone().text()).toBe(200)
      expect(await s1.json()).toBe('approved')

      // payment_order: anordnung=HV signer, sachlich+rechnerisch=KV signer (default
      // KV certifies both), state authorised; four-eyes rechnerisch<>anordnung holds.
      const po = await sql<{
        anordnung_by: string; feststellung_sachlich_by: string; feststellung_rechnerisch_by: string; state: string
      }[]>`SELECT anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by, state
           FROM finance.payment_order WHERE expense_id = ${expenseId}`
      expect(po).toHaveLength(1)
      expect(po[0]).toMatchObject({
        anordnung_by: 'hv-u', feststellung_sachlich_by: 'kv-u', feststellung_rechnerisch_by: 'kv-u', state: 'authorised',
      })
      const exp = await sql<{ state: string }[]>`SELECT state FROM finance.expense WHERE id = ${expenseId}`
      expect(exp[0]!.state).toBe('approved')
      const appr = await sql<{ status: string }[]>`SELECT status FROM finance.approval WHERE id = ${approvalId}`
      expect(appr[0]!.status).toBe('approved')
    })

    it('creator-approves-own → SELF_APPROVAL 403', async () => {
      const approvalId = await openExpenseApproval(await makeExpense())
      // CREATOR carries the KV group, so the group check passes and the self-check fires.
      const res = await post(`/api/v1/approvals/${approvalId}/sign`, CREATOR, { note: 'self' })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('SELF_APPROVAL')
    })

    it('second sign by the same actor on a later stage → DUPLICATE_SIGNER 403', async () => {
      const approvalId = await openExpenseApproval(await makeExpense())
      // MULTI carries BOTH groups, so it is eligible for stage 1 and the duplicate
      // check (not the group check) is what refuses the second sign.
      expect((await post(`/api/v1/approvals/${approvalId}/sign`, MULTI, { note: '1' })).status).toBe(200)
      const res = await post(`/api/v1/approvals/${approvalId}/sign`, MULTI, { note: '2' })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('DUPLICATE_SIGNER')
    })

    it('sign an already-decided approval → ALREADY_DECIDED 409', async () => {
      const approvalId = await openExpenseApproval(await makeExpense())
      await post(`/api/v1/approvals/${approvalId}/sign`, KV, { note: '1' })
      await post(`/api/v1/approvals/${approvalId}/sign`, HV, { note: '2' }) // now approved
      const res = await post(`/api/v1/approvals/${approvalId}/sign`, MULTI, { note: '3' })
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('ALREADY_DECIDED')
    })

    it('requestBudgetApproval opens method=helios when Helios is enabled; manual-sign → HELIOS_NOT_MANUALLY_SIGNABLE 403', async () => {
      await sql`INSERT INTO finance.finance_helios_settings (enabled) VALUES (true)`
      // budget_plan approvals resolve to the central finance_unit's org_unit (OU1).
      const opened = await post('/api/v1/budget-plans/1/request-approval', CREATOR)
      expect(opened.status, await opened.clone().text()).toBe(200)
      const approvalId = (await opened.json()).approval_id
      const method = await sql<{ method: string }[]>`SELECT method FROM finance.approval WHERE id = ${approvalId}`
      expect(method[0]!.method).toBe('helios')
      const res = await post(`/api/v1/approvals/${approvalId}/sign`, MULTI, { note: 'x' })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('HELIOS_NOT_MANUALLY_SIGNABLE')
    })

    it('reject with an empty note → REJECTION_NOTE_REQUIRED 400', async () => {
      const approvalId = await openExpenseApproval(await makeExpense())
      const res = await post(`/api/v1/approvals/${approvalId}/reject`, KV, { note: '   ' })
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('REJECTION_NOTE_REQUIRED')
    })

    it('reject voids a pending payment_order + flips the expense to rejected', async () => {
      const expenseId = await makeExpense()
      const approvalId = await openExpenseApproval(expenseId)
      // A nascent pending payment_order the rejection must void (defensive path).
      await sql`INSERT INTO finance.payment_order (expense_id, anordnung_by, feststellung_sachlich_by, feststellung_rechnerisch_by)
                VALUES (${expenseId}, 'hv-u', 'kv-u', 'kv-u')`
      const res = await post(`/api/v1/approvals/${approvalId}/reject`, KV, { note: 'nicht ok' })
      expect(res.status, await res.clone().text()).toBe(200)
      expect(await res.json()).toBe('rejected')
      const po = await sql<{ state: string }[]>`SELECT state FROM finance.payment_order WHERE expense_id = ${expenseId}`
      expect(po[0]!.state).toBe('voided')
      const exp = await sql<{ state: string }[]>`SELECT state FROM finance.expense WHERE id = ${expenseId}`
      expect(exp[0]!.state).toBe('rejected')
      const appr = await sql<{ status: string; rejection_reason: string }[]>`
        SELECT status, rejection_reason FROM finance.approval WHERE id = ${approvalId}`
      expect(appr[0]).toMatchObject({ status: 'rejected', rejection_reason: 'nicht ok' })
    })

    it('no active profile → NO_ACTIVE_PROFILE 500', async () => {
      const expenseId = await makeExpense()
      await sql`TRUNCATE finance.finanzordnung_profile RESTART IDENTITY CASCADE`
      const res = await post(`/api/v1/expenses/${expenseId}/request-approval`, CREATOR)
      expect(res.status).toBe(500)
      expect((await res.json()).code).toBe('NO_ACTIVE_PROFILE')
    })

    it('step_up_loa/step_up_at persist byte-identically to the FORWARDED values (fixed clock, not leaf-generated)', async () => {
      const approvalId = await openExpenseApproval(await makeExpense())
      const ANCHOR = '2026-07-01T12:00:00.000Z'
      // Above the step-up threshold: the client forwards loa + a fixed anchor.
      const s0 = await post(`/api/v1/approvals/${approvalId}/sign`, KV, { note: 'kv', step_up_loa: 2, step_up_at: ANCHOR })
      expect(s0.status).toBe(200)
      const stage0 = await sql<{ step_up_loa: number | null; step_up_at: Date | null }[]>`
        SELECT step_up_loa, step_up_at FROM finance.approval_stage WHERE approval_id = ${approvalId} AND stage_index = 0`
      expect(stage0[0]!.step_up_loa).toBe(2)
      expect(stage0[0]!.step_up_at!.toISOString()).toBe(ANCHOR) // forwarded verbatim
      // Below the threshold: the client forwards null — the leaf persists null.
      await post(`/api/v1/approvals/${approvalId}/sign`, HV, { note: 'hv', step_up_loa: null, step_up_at: null })
      const stage1 = await sql<{ step_up_loa: number | null; step_up_at: Date | null }[]>`
        SELECT step_up_loa, step_up_at FROM finance.approval_stage WHERE approval_id = ${approvalId} AND stage_index = 1`
      expect(stage1[0]!.step_up_loa).toBeNull()
      expect(stage1[0]!.step_up_at).toBeNull()
    })
  })

  // ── listPendingApprovals scope lenses ────────────────────────────────────────────
  describe('listPendingApprovals — four scope lenses + ORDER BY a.id parity', () => {
    let expApprovalId: number
    let projApprovalId: number

    beforeEach(async () => {
      // One EXPENSE approval (FU1/OU1) + one PROJECT approval (a project in OU2).
      expApprovalId = await openExpenseApproval(await makeExpense())
      await sql`INSERT INTO finance.project (org_unit_id, type, name) VALUES (${LC_OU2}, 'internal', 'Projekt OU2')`
      const projRow = await sql<{ id: string }[]>`SELECT id FROM finance.project WHERE org_unit_id = ${LC_OU2}`
      const projId = Number(projRow[0]!.id)
      const opened = await post('/api/v1/approvals', CREATOR, { approvable_type: 'project', approvable_id: projId })
      expect(opened.status, await opened.clone().text()).toBe(200)
      projApprovalId = (await opened.json()).approval_id
    })

    const idsOf = async (actor: WriteActor): Promise<number[]> => {
      const res = await get('/api/v1/approvals/pending', actor)
      expect(res.status, await res.clone().text()).toBe(200)
      return (await res.json()).map((a: { id: number }) => a.id)
    }

    it('auditor sees ALL pending approvals, ORDER BY a.id', async () => {
      const ids = await idsOf(LC_AUDITOR)
      expect(ids).toEqual([expApprovalId, projApprovalId].sort((a, b) => a - b))
    })

    it('superuser (empty scope) sees ALL pending approvals', async () => {
      const ids = await idsOf({ userId: 'su', isSuperuser: true })
      expect(ids).toEqual([expApprovalId, projApprovalId].sort((a, b) => a - b))
    })

    it('a scoped member sees ONLY its own org-unit approvals (OU1 → the expense one; NOT the OU2 project)', async () => {
      const ids = await idsOf(MEMBER1)
      expect(ids).toEqual([expApprovalId])
      expect(ids).not.toContain(projApprovalId) // out-of-scope anti-probing
    })

    it('an empty-scope non-auditor sees NONE', async () => {
      const ids = await idsOf({ userId: 'nobody' })
      expect(ids).toEqual([])
    })

    it('each pending approval carries its ordered per-stage sign-off steps + current_required_group', async () => {
      const res = await get('/api/v1/approvals/pending', LC_AUDITOR)
      const list = await res.json()
      const expApproval = list.find((a: { id: number }) => a.id === expApprovalId)
      expect(expApproval.approvable_type).toBe('expense')
      expect(expApproval.current_stage_index).toBe(0)
      expect(expApproval.current_required_group).toBe('ref-finanzen-kv')
      expect(expApproval.stages.map((s: { role: string }) => s.role)).toEqual(['KV', 'HV'])
    })
  })
})

// ── #383 Lane D — budget CRUD + lifecycle write domain against a REAL disposable PG ──
// A full HTTP round-trip (guard → router → store-backed handler → PG → DTO) proving
// VALUE parity for the 10 budget write ops + the write-scope 403 + the §4.1
// approved→active invalid-transition gate. All leaf-local: NO org_units join.
const LANED_TENANT: TenantRef = { id: 'aaaaaaaa-dddd-4ddd-8ddd-aaaaaaaaaaaa', slug: 'budgetwrite' }
const LD_BASE_HEADERS = {
  'x-internal-auth': SECRET,
  'x-tenant-id': LANED_TENANT.id,
  'x-tenant-slug': LANED_TENANT.slug,
  'content-type': 'application/json',
}
const LD_CENTRAL_OU = 'd0000000-0000-4000-8000-d00000000000'
const LD_OTHER_OU = 'd1111111-1111-4111-8111-d11111111111'

function ldHeaders(a: WriteActor): Record<string, string> {
  return {
    ...LD_BASE_HEADERS,
    'x-finance-user-id': a.userId,
    'x-finance-is-auditor': String(!!a.isAuditor),
    'x-finance-is-superuser': String(!!a.isSuperuser),
    ...(a.orgUnits && a.orgUnits.length > 0 ? { 'x-finance-scoped-org-units': a.orgUnits.join(',') } : {}),
  }
}
const LD_SUPER: WriteActor = { userId: 'pres', isSuperuser: true }
const LD_CENTRAL: WriteActor = { userId: 'pres-scoped', orgUnits: [LD_CENTRAL_OU] }
const LD_OUTSIDER: WriteActor = { userId: 'out', orgUnits: [LD_OTHER_OU] }
const LD_AUDITOR: WriteActor = { userId: 'aud', isAuditor: true }

describe('finance leaf — Lane D budget CRUD + lifecycle write domain (real PG)', () => {
  let ldServer: ReturnType<typeof createServer>
  let ldBase: string
  let sql: Sql
  let fyId: number

  const req = (method: string, path: string, actor: WriteActor, body?: unknown) =>
    fetch(`${ldBase}${path}`, {
      method,
      headers: ldHeaders(actor),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const post = (p: string, a: WriteActor, b?: unknown) => req('POST', p, a, b)
  const patch = (p: string, a: WriteActor, b?: unknown) => req('PATCH', p, a, b)
  const put = (p: string, a: WriteActor, b?: unknown) => req('PUT', p, a, b)
  const del = (p: string, a: WriteActor) => req('DELETE', p, a)
  const get = (p: string, a: WriteActor) => req('GET', p, a)

  beforeAll(async () => {
    await _resetTenantStoreForTests()
    sql = await storeFor(LANED_TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const storeFn = (t: TenantRef) => storeFor(t, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    ldServer = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => ldServer.listen(0, '127.0.0.1', resolve))
    ldBase = `http://127.0.0.1:${(ldServer.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    if (ldServer) await new Promise<void>((resolve) => ldServer.close(() => resolve()))
    await _resetTenantStoreForTests()
  })

  beforeEach(async () => {
    await sql`TRUNCATE finance.budget_titel, finance.budget_group, finance.budget_section,
              finance.budget_plan, finance.fiscal_year, finance.finance_unit RESTART IDENTITY CASCADE`
    await sql`INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
              VALUES (${LD_CENTRAL_OU}, 'central', 'central', 'carry_forward')`
    const fy = await sql<{ id: string }[]>`
      INSERT INTO finance.fiscal_year (name, start_date, end_date)
      VALUES ('HH 2026', '2026-01-01', '2026-12-31') RETURNING id`
    fyId = Number(fy[0]!.id)
  })

  /** Create a plan (as the central-scoped president) and return its id. */
  async function makePlan(actor: WriteActor = LD_CENTRAL): Promise<number> {
    const res = await post('/api/v1/budget-plans', actor, { fiscal_year_id: fyId })
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()).id
  }

  it('createBudgetPlan: a central-scoped president gets the BudgetPlanDetail (name HH<fy>, von/bis, groups:[])', async () => {
    const res = await post('/api/v1/budget-plans', LD_CENTRAL, { fiscal_year_id: fyId })
    expect(res.status, await res.clone().text()).toBe(200)
    const plan = await res.json()
    expect(plan).toEqual({
      id: plan.id, name: `HH ${fyId}`, von: '2026-01-01', bis: '2026-12-31', state: 'draft',
      fiscal_year_id: fyId, approved_by: null, approved_at: null, groups: [],
    })
    const row = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM finance.budget_plan WHERE id = ${plan.id}`
    expect(row[0]!.c).toBe(1)
  })

  it('createBudgetPlan write-scope: an auditor and an out-of-scope member are both refused (403)', async () => {
    expect((await post('/api/v1/budget-plans', LD_AUDITOR, { fiscal_year_id: fyId })).status).toBe(403)
    expect((await post('/api/v1/budget-plans', LD_OUTSIDER, { fiscal_year_id: fyId })).status).toBe(403)
    // A superuser bypasses the scope gate.
    expect((await post('/api/v1/budget-plans', LD_SUPER, { fiscal_year_id: fyId })).status).toBe(200)
  })

  it('group + item flow: create → getBudgetPlan shows the nested tree (booked=0, remaining=value)', async () => {
    const planId = await makePlan()
    const g = await (await post(`/api/v1/budget-plans/${planId}/groups`, LD_CENTRAL, { name: 'Einnahmen', budget_type: 'income' })).json()
    expect(g).toEqual({ id: g.id, name: 'Einnahmen', budget_type: 'income', items: [] })
    const item = await (await post(`/api/v1/budget-plans/${planId}/groups/${g.id}/items`, LD_CENTRAL, { titel_nr: '1.1', titel_name: 'Beiträge', value: 10000 })).json()
    expect(item).toEqual({ id: item.id, titel_nr: '1.1', titel_name: 'Beiträge', value: 10000, booked: 0, remaining: 10000 })
    // Round-trip through the LIVE getBudgetPlan read (auditor sees all).
    const detail = await (await get(`/api/v1/budget-plans/${planId}`, LD_AUDITOR)).json()
    expect(detail.groups).toEqual([
      { id: g.id, name: 'Einnahmen', budget_type: 'income', items: [{ id: item.id, titel_nr: '1.1', titel_name: 'Beiträge', value: 10000, booked: 0, remaining: 10000 }] },
    ])
  })

  it('updateBudgetGroup / updateBudgetItem patch in place; deletes remove the rows', async () => {
    const planId = await makePlan()
    const g = await (await post(`/api/v1/budget-plans/${planId}/groups`, LD_CENTRAL, { name: 'A', budget_type: 'income' })).json()
    const patchedG = await (await patch(`/api/v1/budget-plans/${planId}/groups/${g.id}`, LD_CENTRAL, { name: 'B', budget_type: 'expense' })).json()
    expect(patchedG).toEqual({ id: g.id, name: 'B', budget_type: 'expense', items: [] })
    const item = await (await post(`/api/v1/budget-plans/${planId}/groups/${g.id}/items`, LD_CENTRAL, { titel_nr: '2', titel_name: 'X', value: 500 })).json()
    const patchedI = await (await patch(`/api/v1/budget-plans/${planId}/groups/${g.id}/items/${item.id}`, LD_CENTRAL, { value: 900 })).json()
    expect(patchedI.value).toBe(900)
    expect((await del(`/api/v1/budget-plans/${planId}/groups/${g.id}/items/${item.id}`, LD_CENTRAL)).status).toBe(200)
    expect((await del(`/api/v1/budget-plans/${planId}/groups/${g.id}`, LD_CENTRAL)).status).toBe(200)
    const cnt = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM finance.budget_group WHERE id = ${g.id}`
    expect(cnt[0]!.c).toBe(0)
  })

  it('activateBudget: a draft plan → 409 (illegal transition); an approved plan → 200 active', async () => {
    const planId = await makePlan()
    const bad = await post(`/api/v1/budget-plans/${planId}/activate`, LD_CENTRAL)
    expect(bad.status).toBe(409)
    expect((await bad.json()).code).toBe('ILLEGAL_TRANSITION')
    await sql`UPDATE finance.budget_plan SET state = 'approved' WHERE id = ${planId}`
    const ok = await post(`/api/v1/budget-plans/${planId}/activate`, LD_CENTRAL)
    expect(ok.status, await ok.clone().text()).toBe(200)
    expect((await ok.json()).state).toBe('active')
    const row = await sql<{ state: string; activated_by: string | null }[]>`
      SELECT state, activated_by FROM finance.budget_plan WHERE id = ${planId}`
    expect(row[0]!.state).toBe('active')
    expect(row[0]!.activated_by).toBe('pres-scoped')
  })

  it('assignBudgetFiscalYear: null → 400; a valid id re-points the plan', async () => {
    const planId = await makePlan()
    expect((await put(`/api/v1/budget-plans/${planId}/fiscal-year`, LD_CENTRAL, { fiscal_year_id: null })).status).toBe(400)
    const fy2 = await sql<{ id: string }[]>`
      INSERT INTO finance.fiscal_year (name, start_date, end_date) VALUES ('HH 2027', '2027-01-01', '2027-12-31') RETURNING id`
    const res = await put(`/api/v1/budget-plans/${planId}/fiscal-year`, LD_CENTRAL, { fiscal_year_id: Number(fy2[0]!.id) })
    expect(res.status, await res.clone().text()).toBe(200)
    const plan = await res.json()
    expect(plan.fiscal_year_id).toBe(Number(fy2[0]!.id))
    expect(plan.von).toBe('2027-01-01')
  })

  it('updateBudgetPlan renames the plan (von/bis unchanged); missing plan → 404', async () => {
    const planId = await makePlan()
    const res = await patch(`/api/v1/budget-plans/${planId}`, LD_CENTRAL, { name: 'Nachtragshaushalt' })
    expect(res.status, await res.clone().text()).toBe(200)
    const plan = await res.json()
    expect(plan.name).toBe('Nachtragshaushalt')
    expect(plan.von).toBe('2026-01-01')
    expect((await patch('/api/v1/budget-plans/999999', LD_CENTRAL, { name: 'x' })).status).toBe(404)
  })
})
