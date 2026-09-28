// test/bank-account.store.test.ts — mocked-PG unit test for the bank_account
// read domain (#383 R10 scope-forwarding). Mirrors read/dto-map.ts#toBankAccountDto:
// id→number, short = name.slice(0,8), current_balance = Number(cents), last_sync =
// ISO-Z or '', fints_state passthrough, and the env-derived fintsRegistrationPending
// (true iff FINTS_PRODUCT_ID is unset — mirror of money/bank-account.ts).
//
// R10: listBankAccounts now takes a ScopeContext and reproduces the native oracle's
// per-actor row-scoping (read/bank-account.ts): an auditor sees ALL; a non-auditor
// sees only accounts backing one of THEIR ledgers (ledger_account → finance_unit →
// org_unit ∈ scope); empty scope → []. DIVERGENCE (native quirk): bank accounts gate
// on isAuditor ONLY, so a superuser-not-auditor is STILL org-unit-scoped here (unlike
// expense/receipt, which honour seesAllFinance = auditor||superuser).

import { describe, it, expect, afterEach } from 'vitest'
import { listBankAccounts, type ScopeContext } from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

// ── two org units, each owning ONE bank account via ledger_account → finance_unit ──
const OU_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OU_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ACC_A = { id: '1', name: 'A Konto', iban: 'DE_A', current_balance_cents: '1000', last_sync_at: null, fints_state: 'connected' }
const ACC_B = { id: '2', name: 'B Konto', iban: 'DE_B', current_balance_cents: '2000', last_sync_at: null, fints_state: 'connected' }
const OWNER: Record<string, string> = { '1': OU_A, '2': OU_B }

/** A query-aware fake postgres-js: the auditor query (no JOIN) returns ALL accounts;
 *  the scoped query (JOIN finance.ledger_account … WHERE fu.org_unit_id = ANY($1))
 *  returns only the accounts whose owning org unit is in the forwarded scope. Records
 *  every issued query so a test can prove which code path (and scope values) ran. */
function fakeSql() {
  const calls: Array<{ q: string; values: unknown[] }> = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ q, values })
    const all = [ACC_A, ACC_B]
    if (!/JOIN finance\.ledger_account/.test(q)) return Promise.resolve(all) // auditor path
    const scope = (values[values.length - 1] ?? []) as string[]
    return Promise.resolve(all.filter((a) => scope.includes(OWNER[a.id]!)))
  }) as unknown as Sql
  return { fn, calls }
}

/** Simple auditor-path fake for the DTO-mapping assertions (single all-accounts query). */
function queueSql(rows: Array<Record<string, unknown>>) {
  return (() => Promise.resolve(rows)) as unknown as Sql
}

const AUDITOR: ScopeContext = { isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [] }

const origProductId = process.env.FINTS_PRODUCT_ID
afterEach(() => {
  if (origProductId === undefined) delete process.env.FINTS_PRODUCT_ID
  else process.env.FINTS_PRODUCT_ID = origProductId
})

describe('bank_account store — listBankAccounts DTO mapping (auditor path)', () => {
  it('maps a row to the exact BankAccount DTO (id→number, short, cents→number, ISO last_sync)', async () => {
    delete process.env.FINTS_PRODUCT_ID // → fintsRegistrationPending: true
    const sql = queueSql([
      {
        id: '12',
        name: 'Hauptkonto Sparkasse',
        iban: 'DE89370400440532013000',
        current_balance_cents: '150000',
        last_sync_at: new Date('2026-02-01T09:30:00.000Z'),
        fints_state: 'connected',
      },
    ])
    const rows = await listBankAccounts(sql, AUDITOR)
    expect(rows[0]).toEqual({
      id: 12,
      name: 'Hauptkonto Sparkasse',
      short: 'Hauptkon', // first 8 chars
      iban: 'DE89370400440532013000',
      last_sync: '2026-02-01T09:30:00.000Z',
      current_balance: 150000,
      fintsRegistrationPending: true,
      fints_state: 'connected',
    })
    expect(typeof rows[0]!.id).toBe('number')
    expect(typeof rows[0]!.current_balance).toBe('number')
  })

  it('emits last_sync = "" when last_sync_at is null', async () => {
    const sql = queueSql([{ id: 1, name: 'X', iban: 'DE1', current_balance_cents: '0', last_sync_at: null, fints_state: 'pending_registration' }])
    const rows = await listBankAccounts(sql, AUDITOR)
    expect(rows[0]!.last_sync).toBe('')
  })

  it('fintsRegistrationPending is false when FINTS_PRODUCT_ID is set', async () => {
    process.env.FINTS_PRODUCT_ID = 'PROD-123'
    const sql = queueSql([{ id: 1, name: 'X', iban: 'DE1', current_balance_cents: '0', last_sync_at: null, fints_state: 'connected' }])
    const rows = await listBankAccounts(sql, AUDITOR)
    expect(rows[0]!.fintsRegistrationPending).toBe(false)
  })
})

describe('bank_account store — listBankAccounts row-scoping (R10, four lenses + divergence)', () => {
  it('auditor (see-all) returns ALL bank accounts', async () => {
    const { fn } = fakeSql()
    const list = await listBankAccounts(fn, AUDITOR)
    expect(list.map((b) => b.id).sort()).toEqual([1, 2])
  })

  it('scoped non-auditor sees ONLY accounts whose ledger→finance_unit→org_unit is in scope', async () => {
    const { fn, calls } = fakeSql()
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    const list = await listBankAccounts(fn, scoped)
    expect(list.map((b) => b.id)).toEqual([1]) // only OU_A's account, NOT OU_B's
    // proves the scoped JOIN query ran with the forwarded org units (not the all query)
    expect(calls.some((c) => /JOIN finance\.ledger_account/.test(c.q))).toBe(true)
    expect(calls.at(-1)!.values.at(-1)).toEqual([OU_A])
  })

  it('DIVERGENCE: superuser-not-auditor is STILL org-unit-scoped for bank accounts (isAuditor gate, not seesAll)', async () => {
    const { fn, calls } = fakeSql()
    const superuser: ScopeContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [OU_B] }
    const list = await listBankAccounts(fn, superuser)
    expect(list.map((b) => b.id)).toEqual([2]) // ONLY OU_B — a superuser does NOT see all here
    expect(calls.some((c) => /JOIN finance\.ledger_account/.test(c.q))).toBe(true) // scoped path taken
  })

  it('empty scope + not see-all → [] WITHOUT issuing a query (short-circuit)', async () => {
    const { fn, calls } = fakeSql()
    const empty: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [] }
    expect(await listBankAccounts(fn, empty)).toEqual([])
    expect(calls.length).toBe(0)
  })

  it('empty scope + superuser (not auditor) → [] (superuser is NOT see-all for bank accounts)', async () => {
    const { fn } = fakeSql()
    const su: ScopeContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [] }
    expect(await listBankAccounts(fn, su)).toEqual([])
  })
})
