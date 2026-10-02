// test/lane-e3.integration.test.ts — #383 Lane E3 value-parity suite against a REAL
// disposable Postgres: full HTTP round-trips (guard → router → handler → PG → bytes/
// JSON) for the 5 newly-LIVE ops:
//   - getBudgetStatementPdf / exportBudget — raw-byte envelope (exact content-length),
//     native content (German headers, euro strings / parse-back cell matrix), G-019
//     scope 404s via the SAME forwarded-scope visibility gate as getBudgetStatement.
//   - csvImport — real multipart/form-data round-trip (the exact FormData the ACL
//     client sends), ON CONFLICT dedup on re-import, per-row error collection,
//     bad-mapping 400, unknown-account 404.
//   - configureFints — upsert + AES-256-GCM at-rest (DB holds a decryptable envelope,
//     NEVER the plaintext; the DTO never carries a password field); cross-op
//     consistency with the Lane A getFintsStatus read; http:// → 400.
//   - syncFints — G-019b ZKA posture END-TO-END: with FINTS_PRODUCT_ID unset the op
//     answers 200 { imported:0, skipped:0, errors:[native message] } and records the
//     failed attempt (IDENTICAL to native-unconfigured); missing config → 404.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import ExcelJS from 'exceljs'
import { createServer } from '../src/http/server.ts'
import { buildApiRoutes } from '../src/http/routes.ts'
import { storeFor, _resetTenantStoreForTests, type TenantRef, type Sql } from '../src/tenant-store.ts'
import { decryptFintsPassword } from '../src/fints/crypto.ts'

// ── fail-closed ephemeral-PG guard (mirrors api.integration.test.ts) ────────────
const TEST_DB_PREFIX = 'finance_test_'
const TEST_PG_URL = (() => {
  const url = process.env.FINANCE_TEST_PG_URL
  if (!url) {
    throw new Error(
      '[fin-test-guard] FINANCE_TEST_PG_URL is REQUIRED — refusing to default to localhost:5432 ' +
        '(the LIVE staging Postgres). Start a throwaway container on a NON-5432 port, e.g. :55435.',
    )
  }
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(host)) {
    throw new Error(`[fin-test-guard] SAFETY VIOLATION: non-localhost host "${host}" — refusing.`)
  }
  if (parsed.port === '' || parsed.port === '5432') {
    throw new Error('[fin-test-guard] SAFETY VIOLATION: port 5432 (or implicit default) is the live Postgres — refusing.')
  }
  return url
})()

const SECRET = 'lane-e3-secret'
const TENANT: TenantRef = { id: 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3', slug: 'lanee3' }
const BASE_HEADERS = {
  'x-internal-auth': SECRET,
  'x-tenant-id': TENANT.id,
  'x-tenant-slug': TENANT.slug,
}
const OU_1 = 'e1111111-aaaa-4aaa-8aaa-e11111111111'
// F1-FIX-05-K (K4#34): csvImport / configureFints / syncFints carry the write actor.
// WRITER_1 may write OU_1, whose ledger the bank account backs; SUPER is the runtime
// see-all (used where a test targets an account no ledger backs, to reach the 404).
const WRITER_1 = {
  'x-finance-user-id': 'fin-1', 'x-finance-is-auditor': 'false', 'x-finance-is-superuser': 'false',
  'x-finance-scoped-org-units': OU_1,
}
const SUPER = { 'x-finance-user-id': 'su', 'x-finance-is-auditor': 'false', 'x-finance-is-superuser': 'true' }
const WRITER_HEADERS = { ...BASE_HEADERS, ...WRITER_1 }
const JSON_HEADERS = { ...BASE_HEADERS, 'content-type': 'application/json', ...WRITER_1 }
const SUPER_JSON_HEADERS = { ...BASE_HEADERS, 'content-type': 'application/json', ...SUPER }
const OU_2 = 'e2222222-bbbb-4bbb-8bbb-e22222222222'

type Scope = { isAuditor: boolean; isSuperuser: boolean; orgUnits: string[] }
const AUDITOR: Scope = { isAuditor: true, isSuperuser: false, orgUnits: [] }
const MEMBER_2: Scope = { isAuditor: false, isSuperuser: false, orgUnits: [OU_2] }
const scopeHeaders = (s: Scope): Record<string, string> => ({
  ...BASE_HEADERS,
  'x-finance-is-auditor': String(s.isAuditor),
  'x-finance-is-superuser': String(s.isSuperuser),
  ...(s.orgUnits.length > 0 ? { 'x-finance-scoped-org-units': s.orgUnits.join(',') } : {}),
})

const TEST_KEY = 'e3'.repeat(32) // 64 hex chars = 32 bytes

describe('finance leaf — Lane E3 byte exports + CSV + FinTS (real PG)', () => {
  let server: ReturnType<typeof createServer>
  let base: string
  let sql: Sql
  let planId = ''
  let bankAccountId = ''
  let keyBackup: string | undefined
  let productBackup: string | undefined

  beforeAll(async () => {
    keyBackup = process.env.FINANCE_FINTS_PASSWORD_KEY
    productBackup = process.env.FINTS_PRODUCT_ID
    process.env.FINANCE_FINTS_PASSWORD_KEY = TEST_KEY
    delete process.env.FINTS_PRODUCT_ID // G-019b: the ZKA-unregistered posture

    await _resetTenantStoreForTests()
    sql = await storeFor(TENANT, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    const storeFn = (t: TenantRef) => storeFor(t, { pgUrl: TEST_PG_URL, dbPrefix: TEST_DB_PREFIX })
    server = createServer({ secret: SECRET, routes: buildApiRoutes(storeFn) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    // Seed: one org unit (OU_1) with a plan (2 Titel, one posted booking) + a bank
    // account for CSV/FinTS. OU_2 exists but owns NO section of the plan (G-019 lens).
    await sql`TRUNCATE finance.booking, finance.bank_transaction, finance.fints_config,
              finance.budget_titel, finance.budget_group, finance.budget_section,
              finance.budget_plan, finance.fiscal_year, finance.ledger_account,
              finance.bank_account, finance.finance_unit RESTART IDENTITY CASCADE`
    const fu = async (ou: string) => (await sql<{ id: string }[]>`
      INSERT INTO finance.finance_unit (org_unit_id, kind, bookkeeping_mode, carry_over_rule)
      VALUES (${ou}, 'standard', 'own', 'carry_forward') RETURNING id`)[0]!.id
    const fuA = await fu(OU_1)
    await fu(OU_2)
    const fy = (await sql<{ id: string }[]>`
      INSERT INTO finance.fiscal_year (name, start_date, end_date)
      VALUES ('HH 2026', '2026-01-01', '2026-12-31') RETURNING id`)[0]!.id
    bankAccountId = (await sql<{ id: string }[]>`
      INSERT INTO finance.bank_account (name, iban) VALUES ('Hauptkonto', 'DE12500105170648489890') RETURNING id`)[0]!.id
    const la = (await sql<{ id: string }[]>`
      INSERT INTO finance.ledger_account (finance_unit_id, bank_account_id, type, name)
      VALUES (${fuA}, ${bankAccountId}, 'own_account', 'Kasse') RETURNING id`)[0]!.id
    planId = (await sql<{ id: string }[]>`
      INSERT INTO finance.budget_plan (fiscal_year_id, name) VALUES (${fy}, 'Haushalt 2026') RETURNING id`)[0]!.id
    const sec = (await sql<{ id: string }[]>`
      INSERT INTO finance.budget_section (budget_plan_id, finance_unit_id)
      VALUES (${planId}, ${fuA}) RETURNING id`)[0]!.id
    const grp = (await sql<{ id: string }[]>`
      INSERT INTO finance.budget_group (budget_section_id, name, budget_type)
      VALUES (${sec}, 'Ausgaben', 'expense') RETURNING id`)[0]!.id
    const titel = async (nr: string, name: string, planned: number) => (await sql<{ id: string }[]>`
      INSERT INTO finance.budget_titel (budget_group_id, titel_nr, titel_name, planned_cents)
      VALUES (${grp}, ${nr}, ${name}, ${planned}) RETURNING id`)[0]!.id
    const tit1 = await titel('1.1', 'Personal', 12000)
    await titel('1.2', 'Sachmittel', 5000)
    // R29-FIN-SIGN-K: booking.amount_cents is BANK-SIGNED (#410 FIN-3; the split-allocation
    // write path copies the bank transaction's sign onto every part): a 110 EUR expense paid
    // out of the account is a DEBIT, -11000. The old seed (+11000) was a 110 EUR refund INTO
    // an expense Titel, which every view correctly renders as Ist -110 / Diff 230.
    const btx = (await sql<{ id: string }[]>`
      INSERT INTO finance.bank_transaction (bank_account_id, booking_date, amount_cents, import_hash)
      VALUES (${bankAccountId}, '2026-03-01', -11000, 'seed-hash-e3') RETURNING id`)[0]!.id
    await sql`
      INSERT INTO finance.booking (ledger_account_id, budget_titel_id, fiscal_year_id, amount_cents,
                                   booking_date, running_no, payment_type, bank_transaction_id, state)
      VALUES (${la}, ${tit1}, ${fy}, -11000, '2026-03-01', 1, 'bargeldlos', ${btx}, 'posted')`
  })

  afterAll(async () => {
    if (keyBackup === undefined) delete process.env.FINANCE_FINTS_PASSWORD_KEY
    else process.env.FINANCE_FINTS_PASSWORD_KEY = keyBackup
    if (productBackup === undefined) delete process.env.FINTS_PRODUCT_ID
    else process.env.FINTS_PRODUCT_ID = productBackup
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    await _resetTenantStoreForTests()
  })

  // ── getBudgetStatementPdf ───────────────────────────────────────────────────
  describe('getBudgetStatementPdf (raw bytes)', () => {
    it('auditor → 200 application/pdf with the native HTML contract + exact content-length', async () => {
      const res = await fetch(`${base}/api/v1/budget-plans/${planId}/statement/pdf`, { headers: scopeHeaders(AUDITOR) })
      expect(res.status, await res.clone().text()).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/pdf')
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="statement-${planId}.pdf"`)
      const declared = Number(res.headers.get('content-length'))
      const body = Buffer.from(await res.arrayBuffer())
      expect(body.byteLength).toBe(declared) // exact-size envelope
      const html = body.toString('utf8')
      expect(html).toMatch(/<html/i)
      expect(html).toContain('Haushalt 2026')
      expect(html).toContain('Titel-Nr.')
      // Row-anchored (R29-FIN-SIGN-K): a bare toContain('110.00') / ('10.00') also matched the
      // sign-flipped '-110.00' / '230.00' row, so the PDF never caught the inverted Ist.
      // 12000 cents Ansatz | posted expense Ist (positive = consumed) | Diff = Ansatz - Ist
      expect(html).toMatch(/<td class="num">120\.00<\/td>\s*<td class="num">110\.00<\/td>\s*<td class="num">10\.00<\/td>/)
      expect(html).not.toContain('-110.00')
      expect(html).toContain('Sachmittel')
    })

    it('out-of-scope member → 404 (G-019, same gate as the statement read)', async () => {
      const res = await fetch(`${base}/api/v1/budget-plans/${planId}/statement/pdf`, { headers: scopeHeaders(MEMBER_2) })
      expect(res.status).toBe(404)
    })

    it('unknown plan → 404', async () => {
      const res = await fetch(`${base}/api/v1/budget-plans/999999/statement/pdf`, { headers: scopeHeaders(AUDITOR) })
      expect(res.status).toBe(404)
    })
  })

  // ── exportBudget ────────────────────────────────────────────────────────────
  describe('exportBudget (xlsx / ods bytes)', () => {
    it('xlsx: 200 with the xlsx MIME; the parse-back cell matrix matches the seeded plan', async () => {
      const res = await fetch(`${base}/api/v1/budget-plans/${planId}/export?format=xlsx`, { headers: scopeHeaders(AUDITOR) })
      expect(res.status, await res.clone().text()).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="haushalt-${planId}.xlsx"`)
      const body = Buffer.from(await res.arrayBuffer())
      expect(body.byteLength).toBe(Number(res.headers.get('content-length')))
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
      const sheet = wb.worksheets[0]!
      expect(sheet.name).toBe('Haushalt')
      const matrix: unknown[][] = []
      sheet.eachRow((row) => matrix.push((row.values as unknown[]).slice(1)))
      expect(matrix).toEqual([
        ['Titel-Nr.', 'Bezeichnung', 'Ansatz', 'Ist', 'Diff'],
        ['1.1', 'Personal', 120, 110, 10],
        ['1.2', 'Sachmittel', 50, 0, 50],
      ])
      // On-screen parity (R29-FIN-SIGN-K): the budget detail view (getBudgetPlan) shows the
      // SAME Ist (booked) and Diff (remaining) for the seeded expense Titel, in cents.
      type DetailItem = { titel_nr: string; value: number; booked: number; remaining: number }
      const detail: { groups: Array<{ items: DetailItem[] }> } =
        await (await fetch(`${base}/api/v1/budget-plans/${planId}`, { headers: scopeHeaders(AUDITOR) })).json()
      const items = detail.groups
        .flatMap((g) => g.items)
        .map((i) => [i.titel_nr, i.value, i.booked, i.remaining])
      expect(items).toEqual([['1.1', 12000, 11000, 1000], ['1.2', 5000, 0, 5000]])
    })

    it('ods: 200 with CSV bytes under the ODS MIME (native parity)', async () => {
      const res = await fetch(`${base}/api/v1/budget-plans/${planId}/export?format=ods`, { headers: scopeHeaders(AUDITOR) })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/vnd.oasis.opendocument.spreadsheet')
      const csv = await res.text()
      expect(csv).toContain('Titel-Nr.,Bezeichnung,Ansatz,Ist,Diff')
      // Same rows as the xlsx matrix (R29-FIN-SIGN-K): ods and xlsx render one projection.
      expect(csv).toContain('1.1,Personal,120,110,10')
      expect(csv).toContain('1.2,Sachmittel,50,0,50')
    })

    it('missing/invalid ?format → 400', async () => {
      expect((await fetch(`${base}/api/v1/budget-plans/${planId}/export`, { headers: scopeHeaders(AUDITOR) })).status).toBe(400)
      expect((await fetch(`${base}/api/v1/budget-plans/${planId}/export?format=exe`, { headers: scopeHeaders(AUDITOR) })).status).toBe(400)
    })

    it('out-of-scope member → 404 (G-019)', async () => {
      const res = await fetch(`${base}/api/v1/budget-plans/${planId}/export?format=xlsx`, { headers: scopeHeaders(MEMBER_2) })
      expect(res.status).toBe(404)
    })
  })

  // ── csvImport ───────────────────────────────────────────────────────────────
  describe('csvImport (multipart round-trip)', () => {
    const CSV = [
      'Buchungstag;Name;Betrag;Zweck;Referenz',
      '01.05.2026;Acme GmbH;-123,45;Beitrag Mai;E3-REF-1',
      '02.05.2026;Uni Kasse;500,00;Zuschuss;E3-REF-2',
    ].join('\n')
    const MAPPING = {
      bookingDate: 0, counterpartyName: 1, amountCents: 2, purpose: 3, bankReference: 4,
      valutaDate: null, counterpartyIban: null, saldoCents: null,
    }
    /** The EXACT FormData shape the ACL client's csvImport sends. */
    function form(csv: string, mapping: unknown, reversed: boolean): FormData {
      const f = new FormData()
      f.append('file', new File([csv], 'bank.csv', { type: 'text/csv' }))
      f.append('mapping', JSON.stringify(mapping))
      f.append('csv_order_reversed', String(reversed))
      return f
    }
    const post = (accountId: string | number, body: FormData, headers: Record<string, string> = WRITER_HEADERS) =>
      fetch(`${base}/api/v1/bank-accounts/${accountId}/csv-import`, { method: 'POST', headers, body })

    it('imports both rows and persists the canonical columns', async () => {
      const res = await post(bankAccountId, form(CSV, MAPPING, false))
      expect(res.status, await res.clone().text()).toBe(200)
      expect(await res.json()).toEqual({ imported: 2, skipped: 0, errors: [] })
      const rows = await sql<{ booking_date: Date; amount_cents: string; counterparty_name: string; bank_reference: string }[]>`
        SELECT booking_date, amount_cents, counterparty_name, bank_reference
        FROM finance.bank_transaction WHERE bank_reference LIKE 'E3-REF-%' ORDER BY bank_reference`
      expect(rows).toHaveLength(2)
      expect(Number(rows[0]!.amount_cents)).toBe(-12345)
      expect(rows[0]!.counterparty_name).toBe('Acme GmbH')
    })

    it('re-importing the SAME file skips every row (ON CONFLICT dedup, not errors)', async () => {
      const res = await post(bankAccountId, form(CSV, MAPPING, false))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ imported: 0, skipped: 2, errors: [] })
    })

    it('collects per-row errors while importing valid rows', async () => {
      const broken = 'Buchungstag;Name;Betrag;Zweck;Referenz\nNODATE;X;-1,00;bad;E3-REF-BAD\n03.05.2026;Ok GmbH;-2,00;fine;E3-REF-3'
      const res = await post(bankAccountId, form(broken, MAPPING, false))
      const body = await res.json()
      expect(body.imported).toBe(1)
      expect(body.errors).toHaveLength(1)
      expect(body.errors[0]).toMatch(/unparseable bookingDate/)
    })

    it('structurally bad mapping (bookingDate unmapped) → 400 with the native message', async () => {
      const res = await post(bankAccountId, form(CSV, { ...MAPPING, bookingDate: null }, false))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/bookingDate column must be mapped/)
    })

    it('unknown bank account → 404', async () => {
      const res = await post(999999, form(CSV, MAPPING, false), { ...BASE_HEADERS, ...SUPER })
      expect(res.status).toBe(404)
    })

    it('a non-multipart body → 400', async () => {
      const res = await fetch(`${base}/api/v1/bank-accounts/${bankAccountId}/csv-import`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ nope: true }),
      })
      expect(res.status).toBe(400)
    })
  })

  // ── configureFints ──────────────────────────────────────────────────────────
  describe('configureFints (at-rest crypto + upsert)', () => {
    const put = (accountId: string | number, body: unknown) =>
      fetch(`${base}/api/v1/bank-accounts/${accountId}/fints`, {
        method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body),
      })

    it('creates the config; DB stores a decryptable AES-GCM envelope, NEVER the plaintext', async () => {
      const res = await put(bankAccountId, {
        fints_url: 'https://fints.example/api', bank_code: '37040044', username: 'stura', password: 'super-geheim',
      })
      expect(res.status, await res.clone().text()).toBe(200)
      const dto = await res.json()
      expect(dto).toEqual({
        id: dto.id, bank_account_id: Number(bankAccountId), fints_url: 'https://fints.example/api',
        bank_code: '37040044', username: 'stura', last_sync_at: null, last_sync_status: null, last_sync_error: null,
      })
      expect(JSON.stringify(dto)).not.toMatch(/password/)
      const row = await sql<{ password_encrypted: string }[]>`
        SELECT password_encrypted FROM finance.fints_config WHERE bank_account_id = ${bankAccountId}`
      expect(row[0]!.password_encrypted).not.toContain('super-geheim')
      expect(decryptFintsPassword(row[0]!.password_encrypted, TEST_KEY)).toBe('super-geheim')
    })

    it('cross-op consistency: the Lane A getFintsStatus read now reports configured:true', async () => {
      const res = await fetch(`${base}/api/v1/bank-accounts/${bankAccountId}/fints`, { headers: scopeHeaders(AUDITOR) })
      expect(res.status).toBe(200)
      const status = await res.json()
      expect(status.configured).toBe(true)
      expect(status.bank_code).toBe('37040044')
    })

    it('a second PUT upserts (UNIQUE bank_account_id — no duplicate row)', async () => {
      const res = await put(bankAccountId, {
        fints_url: 'https://fints.example/api', bank_code: '37040044', username: 'stura-neu', password: 'p2',
      })
      expect(res.status).toBe(200)
      expect((await res.json()).username).toBe('stura-neu')
      const count = await sql<{ c: number }[]>`
        SELECT count(*)::int AS c FROM finance.fints_config WHERE bank_account_id = ${bankAccountId}`
      expect(count[0]!.c).toBe(1)
    })

    it('non-https fints_url → 400 (native message)', async () => {
      const res = await put(bankAccountId, { fints_url: 'http://x', bank_code: 'b', username: 'u', password: 'p' })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/fints_url must be https/)
    })

    it('missing fields → 400', async () => {
      expect((await put(bankAccountId, { fints_url: 'https://x' })).status).toBe(400)
    })
  })

  // ── syncFints ───────────────────────────────────────────────────────────────
  describe('syncFints (G-019b ZKA posture end-to-end)', () => {
    it('answers 200 with the NATIVE unconfigured FINTS_PRODUCT_ID result and records the failed attempt', async () => {
      const res = await fetch(`${base}/api/v1/bank-accounts/${bankAccountId}/fints/sync`, {
        method: 'POST', headers: JSON_HEADERS,
      })
      expect(res.status, await res.clone().text()).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        imported: 0,
        skipped: 0,
        errors: [
          'FinTS transport error: FINTS_PRODUCT_ID env var is not set — register at ' +
            'fints.org/de/hersteller/produktregistrierung before enabling FinTS sync',
        ],
      })
      const row = await sql<{ last_sync_status: string; last_sync_error: string; last_sync_at: Date | null }[]>`
        SELECT last_sync_status, last_sync_error, last_sync_at FROM finance.fints_config WHERE bank_account_id = ${bankAccountId}`
      expect(row[0]!.last_sync_status).toBe('failed')
      expect(row[0]!.last_sync_error).toMatch(/FINTS_PRODUCT_ID/)
      // F1-FIX-05-K (K4#13): a failed sync leaves last_sync_at unchanged (it was never synced).
      expect(row[0]!.last_sync_at).toBeNull()
      // and the Lane A status read reflects it
      const status = await (await fetch(`${base}/api/v1/bank-accounts/${bankAccountId}/fints`, { headers: scopeHeaders(AUDITOR) })).json()
      expect(status.last_sync_status).toBe('failed')
    })

    it('an account without a fints_config → 404 (native missing-config throw)', async () => {
      const bare = (await sql<{ id: string }[]>`
        INSERT INTO finance.bank_account (name, iban) VALUES ('Ohne FinTS', 'DE02100100100006820101') RETURNING id`)[0]!.id
      const res = await fetch(`${base}/api/v1/bank-accounts/${bare}/fints/sync`, { method: 'POST', headers: SUPER_JSON_HEADERS })
      expect(res.status).toBe(404)
    })
  })
})
