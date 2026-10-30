// test/leaf-write-scope.integration.test.ts -- F1-FIX-05-K (H15: S1b#27; H14 leaf
// twin: K4#34).
//
// The leaf's sub-org create / update / delete handlers and its configureFints /
// syncFints / csvImport handlers ran with no actor and no org-unit scope check: any
// Finance user could create, rename or delete any sub-org, reconfigure any bank
// account's FinTS credentials, trigger its sync, or inject CSV bank transactions into
// it. Real Postgres, full HTTP round trips; the write actor rides the ACL headers.

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

const SECRET = 'leaf-write-scope-secret'
const TENANT: TenantRef = { id: 'f105f105-5c09-4000-8000-f105f105f105', slug: 'f105scope' }
const OU_CENTRAL = 'f1050000-cccc-4ccc-8ccc-f10500000000'
const OU_FS = 'f1050000-aaaa-4aaa-8aaa-f10500000001' // a Fachschaft with its own bank account
const OU_OTHER = 'f1050000-bbbb-4bbb-8bbb-f10500000002'

interface Actor { userId: string; isSuperuser?: boolean; isAuditor?: boolean; orgUnits?: string[]; groups?: string[] }
const CENTRAL_FINANCE: Actor = { userId: 'central-fin', orgUnits: [OU_CENTRAL] }
const FS_FINANCE: Actor = { userId: 'fs-fin', orgUnits: [OU_FS] }
const OUTSIDER: Actor = { userId: 'other-fin', orgUnits: [OU_OTHER] }
const SUPER: Actor = { userId: 'su', isSuperuser: true }
const CONFIG_ADMIN: Actor = { userId: 'it-adm', groups: ['it-admin'] }
const CENTRAL_AUDITOR: Actor = { userId: 'aud', isAuditor: true, orgUnits: [OU_CENTRAL] }

const headers = (a: Actor, json = true): Record<string, string> => ({
  'x-internal-auth': SECRET,
  'x-tenant-id': TENANT.id,
  'x-tenant-slug': TENANT.slug,
  ...(json ? { 'content-type': 'application/json' } : {}),
  'x-finance-user-id': a.userId,
  'x-finance-is-auditor': String(!!a.isAuditor),
  'x-finance-is-superuser': String(!!a.isSuperuser),
  ...(a.orgUnits && a.orgUnits.length > 0 ? { 'x-finance-scoped-org-units': a.orgUnits.join(',') } : {}),
  ...(a.groups && a.groups.length > 0 ? { 'x-finance-groups-json': Buffer.from(JSON.stringify(a.groups), 'utf8').toString('base64url') } : {}),
})

describe('finance leaf -- write scope on sub-org sagas and bank-account ops (H15, K4#34)', () => {
  let server: ReturnType<typeof createServer>
  let base: string
  let sql: Sql
  let fsBankAccountId = ''
  let fsFinanceUnitId = ''
  const keyBackup = process.env.FINANCE_FINTS_PASSWORD_KEY

  const call = (method: string, path: string, a: Actor, body?: unknown) =>
    fetch(`${base}${path}`, {
      method, headers: headers(a), ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const count = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]!.n

  beforeAll(async () => {
    process.env.FINANCE_FINTS_PASSWORD_KEY = 'f1'.repeat(32)
    await _resetTenantStoreForTests()
    sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const storeFn = (t: TenantRef) => storeFor(t, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    server = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    if (keyBackup === undefined) delete process.env.FINANCE_FINTS_PASSWORD_KEY
    else process.env.FINANCE_FINTS_PASSWORD_KEY = keyBackup
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await _resetTenantStoreForTests()
  })

  beforeEach(async () => {
    await sql`TRUNCATE finance.bank_transaction, finance.fints_config, finance.ledger_account,
              finance.bank_account, finance.project, finance.expense, finance.finance_unit,
              finance.fiscal_year, finance.sub_org_type, finance.org_unit_mirror
              RESTART IDENTITY CASCADE`
    await sql`INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
              VALUES (${OU_CENTRAL}, 'central', 'central', 'carry_forward')`
    fsFinanceUnitId = (await sql<{ id: string }[]>`
      INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
      VALUES (${OU_FS}, 'standard', 'own', 'carry_forward') RETURNING id`)[0]!.id
    fsBankAccountId = (await sql<{ id: string }[]>`
      INSERT INTO finance.bank_account (name, iban) VALUES ('FS Konto', 'DE12500105170648489890') RETURNING id`)[0]!.id
    await sql`INSERT INTO finance.ledger_account (finance_unit_id, bank_account_id, type, name)
              VALUES (${fsFinanceUnitId}, ${fsBankAccountId}, 'own_account', 'FS Kasse')`
  })

  describe('sub-org sagas (H15)', () => {
    const NEW_OU = 'f1050000-dddd-4ddd-8ddd-f10500000009'

    it('create by a Finance user outside the parent (central) scope -> 403, no finance_unit row', async () => {
      const before = await count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM finance.finance_unit`)
      const res = await call('POST', '/api/v1/sub-orgs', OUTSIDER, { org_unit_id: NEW_OU })
      expect(res.status, await res.clone().text()).toBe(403)
      expect(await count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM finance.finance_unit`)).toBe(before)
    })

    it('create by a Finance user scoped to the central parent -> 200', async () => {
      const res = await call('POST', '/api/v1/sub-orgs', CENTRAL_FINANCE, { org_unit_id: NEW_OU })
      expect(res.status, await res.clone().text()).toBe(200)
    })

    it('update (rename phase) by an outsider -> 403', async () => {
      const res = await call('PATCH', `/api/v1/sub-orgs/${fsFinanceUnitId}`, OUTSIDER, {})
      expect(res.status, await res.clone().text()).toBe(403)
      expect((await call('PATCH', `/api/v1/sub-orgs/${fsFinanceUnitId}`, FS_FINANCE, {})).status).toBe(200)
    })

    it('delete by an outsider -> 403 and the finance_unit survives', async () => {
      const res = await call('DELETE', `/api/v1/sub-orgs/${fsFinanceUnitId}`, OUTSIDER)
      expect(res.status, await res.clone().text()).toBe(403)
      expect(await count(sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM finance.finance_unit WHERE id = ${fsFinanceUnitId}`)).toBe(1)
    })

    it('a request without any actor headers is refused (fail closed)', async () => {
      const res = await fetch(`${base}/api/v1/sub-orgs`, {
        method: 'POST',
        headers: { 'x-internal-auth': SECRET, 'x-tenant-id': TENANT.id, 'x-tenant-slug': TENANT.slug, 'content-type': 'application/json' },
        body: JSON.stringify({ org_unit_id: NEW_OU }),
      })
      expect(res.status).toBe(403)
    })

    // r2 (verifier LOW): the body's parent_org_unit_id was trusted as-is, so a caller
    // could name any parent it can write. It now counts only when the leaf's org-unit
    // mirror confirms it IS the new unit's parent; otherwise the central gate applies.
    it('a claimed parent that the org-unit mirror does not confirm does not open the gate -> 403', async () => {
      await sql`INSERT INTO finance.org_unit_mirror (id, name, kind, parent_id)
                VALUES (${NEW_OU}, 'Neu', 'fachschaft', ${OU_OTHER})`
      const before = await count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM finance.finance_unit`)
      const res = await call('POST', '/api/v1/sub-orgs', FS_FINANCE, { org_unit_id: NEW_OU, parent_org_unit_id: OU_FS })
      expect(res.status, await res.clone().text()).toBe(403)
      // No mirror row at all: the claim is unverifiable, the central gate applies.
      const other = 'f1050000-eeee-4eee-8eee-f1050000000e'
      const res2 = await call('POST', '/api/v1/sub-orgs', FS_FINANCE, { org_unit_id: other, parent_org_unit_id: OU_FS })
      expect(res2.status, await res2.clone().text()).toBe(403)
      expect(await count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM finance.finance_unit`)).toBe(before)
    })

    it('a parent the org-unit mirror confirms lets its scoped Finance user create the child -> 200', async () => {
      await sql`INSERT INTO finance.org_unit_mirror (id, name, kind, parent_id)
                VALUES (${NEW_OU}, 'Neu', 'fachschaft', ${OU_FS})`
      const res = await call('POST', '/api/v1/sub-orgs', FS_FINANCE, { org_unit_id: NEW_OU, parent_org_unit_id: OU_FS })
      expect(res.status, await res.clone().text()).toBe(200)
    })
  })

  // r2 (K4#34 remainder): fiscal-year and sub-org-type mutations ran with no actor.
  // They now need the central/admin scope, as the ledger fix asks: the central
  // finance_unit's org unit (auditor refused), the admin / it-admin config groups
  // (the updateSignerConfig gate), or a runtime superuser.
  describe('fiscal-year and sub-org-type mutations need the central/admin scope (K4#34)', () => {
    const FY = { name: 'HH 2026', start_date: '2026-01-01', end_date: '2026-12-31' }
    const fyCount = () => count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM finance.fiscal_year`)
    const typeCount = () => count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM finance.sub_org_type`)

    it('createFiscalYear outside the central scope -> 403 and no row; central, admin group and superuser -> 200', async () => {
      for (const a of [OUTSIDER, FS_FINANCE, CENTRAL_AUDITOR]) {
        const res = await call('POST', '/api/v1/fiscal-years', a, FY)
        expect(res.status, `${a.userId}: ${await res.clone().text()}`).toBe(403)
      }
      expect(await fyCount()).toBe(0)
      for (const a of [CENTRAL_FINANCE, CONFIG_ADMIN, SUPER]) {
        const res = await call('POST', '/api/v1/fiscal-years', a, { ...FY, name: `HH ${a.userId}` })
        expect(res.status, `${a.userId}: ${await res.clone().text()}`).toBe(200)
      }
      expect(await fyCount()).toBe(3)
    })

    it('updateFiscalYear outside the central scope -> 403 and the row is unchanged', async () => {
      const id = (await sql<{ id: string }[]>`
        INSERT INTO finance.fiscal_year (name, start_date, end_date)
        VALUES ('Alt', '2026-01-01', '2026-12-31') RETURNING id`)[0]!.id
      const res = await call('PATCH', `/api/v1/fiscal-years/${id}`, OUTSIDER, { name: 'Gekapert' })
      expect(res.status, await res.clone().text()).toBe(403)
      expect((await sql<{ name: string }[]>`SELECT name FROM finance.fiscal_year WHERE id = ${id}`)[0]!.name).toBe('Alt')
      const ok = await call('PATCH', `/api/v1/fiscal-years/${id}`, CENTRAL_FINANCE, { name: 'Neu' })
      expect(ok.status, await ok.clone().text()).toBe(200)
    })

    it('createSubOrgType outside the central scope -> 403 and no row; central -> 200', async () => {
      const res = await call('POST', '/api/v1/sub-org-types', OUTSIDER, { name: 'Referat' })
      expect(res.status, await res.clone().text()).toBe(403)
      expect(await typeCount()).toBe(0)
      const ok = await call('POST', '/api/v1/sub-org-types', CENTRAL_FINANCE, { name: 'Referat' })
      expect(ok.status, await ok.clone().text()).toBe(200)
      expect(await typeCount()).toBe(1)
    })

    it('deleteSubOrgType outside the central scope -> 403 and the row survives; superuser -> 200', async () => {
      const id = (await sql<{ id: string }[]>`
        INSERT INTO finance.sub_org_type (name) VALUES ('Referat') RETURNING id`)[0]!.id
      const res = await call('DELETE', `/api/v1/sub-org-types/${id}`, FS_FINANCE)
      expect(res.status, await res.clone().text()).toBe(403)
      expect(await typeCount()).toBe(1)
      const ok = await call('DELETE', `/api/v1/sub-org-types/${id}`, SUPER)
      expect(ok.status, await ok.clone().text()).toBe(200)
      expect(await typeCount()).toBe(0)
    })

    it('no central finance_unit: only the admin groups or a superuser may mutate', async () => {
      await sql`DELETE FROM finance.finance_unit WHERE kind = 'central'`
      expect((await call('POST', '/api/v1/fiscal-years', CENTRAL_FINANCE, FY)).status).toBe(403)
      expect((await call('POST', '/api/v1/fiscal-years', CONFIG_ADMIN, FY)).status).toBe(200)
    })
  })

  describe('bank-account ops (H14 leaf twin, K4#34)', () => {
    const FINTS = { fints_url: 'https://fints.example/api', bank_code: '37040044', username: 'u', password: 'p' }

    it('configureFints on an account outside scope -> 403 and no config is written', async () => {
      const res = await call('PUT', `/api/v1/bank-accounts/${fsBankAccountId}/fints`, OUTSIDER, FINTS)
      expect(res.status, await res.clone().text()).toBe(403)
      expect(await count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM finance.fints_config`)).toBe(0)
      const ok = await call('PUT', `/api/v1/bank-accounts/${fsBankAccountId}/fints`, FS_FINANCE, FINTS)
      expect(ok.status, await ok.clone().text()).toBe(200)
    })

    it('syncFints on an account outside scope -> 403 and the sync state is untouched', async () => {
      expect((await call('PUT', `/api/v1/bank-accounts/${fsBankAccountId}/fints`, FS_FINANCE, FINTS)).status).toBe(200)
      const res = await call('POST', `/api/v1/bank-accounts/${fsBankAccountId}/fints/sync`, OUTSIDER)
      expect(res.status, await res.clone().text()).toBe(403)
      const row = await sql<{ last_sync_status: string | null }[]>`
        SELECT last_sync_status FROM finance.fints_config WHERE bank_account_id = ${fsBankAccountId}`
      expect(row[0]!.last_sync_status).toBeNull()
    })

    it('csvImport into an account outside scope -> 403 and no transaction is written', async () => {
      const form = new FormData()
      form.append('file', new File(['Buchungstag;Name;Betrag;Zweck;Referenz\n01.05.2026;X;-1,00;y;F105-REF'], 'b.csv', { type: 'text/csv' }))
      form.append('mapping', JSON.stringify({ bookingDate: 0, counterpartyName: 1, amountCents: 2, purpose: 3, bankReference: 4 }))
      form.append('csv_order_reversed', 'false')
      const post = (a: Actor) => fetch(`${base}/api/v1/bank-accounts/${fsBankAccountId}/csv-import`, {
        method: 'POST', headers: headers(a, false), body: form,
      })
      const res = await post(OUTSIDER)
      expect(res.status, await res.clone().text()).toBe(403)
      expect(await count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM finance.bank_transaction`)).toBe(0)
      const ok = await post(FS_FINANCE)
      expect(ok.status, await ok.clone().text()).toBe(200)
      expect(await count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM finance.bank_transaction`)).toBe(1)
    })

    it('a superuser passes the scope gate (runtime see-all)', async () => {
      const res = await call('PUT', `/api/v1/bank-accounts/${fsBankAccountId}/fints`, SUPER, FINTS)
      expect(res.status, await res.clone().text()).toBe(200)
    })
  })
})
