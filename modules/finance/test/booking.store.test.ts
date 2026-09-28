// test/booking.store.test.ts — mocked-PG unit test for the booking READ domain
// (#383 Lane B). Mirrors read/booking.ts + dto-map.ts#toBookingDto:
//   Booking DTO = { id, account_id = ledger_account_id, date/valuta = booking_date
//   YYYY-MM-DD, type = payment_type, empf_name = titel_name, empf_iban = '',
//   value = amount_cents, saldo = 0, zweck = la_name }, paginated per_page=50,
//   last_page = ceil(total/50), sort booking_date DESC then id DESC.
//
// listBookings builds its dynamic WHERE (finance-unit scope + account_id + date range)
// with $N placeholders and runs it via sql.unsafe(sql, args) — so the fake exposes BOTH
// the tagged-template call (scopedFinanceUnitIds) AND .unsafe (list + count). Each filter
// combo must drive the expected bound-arg vector; a non-numeric/absent page must clamp to
// page 1 (offset 0 — never `OFFSET NaN`). Row-scoping mirrors read/booking.ts: auditor →
// no finance-unit filter; non-auditor → WHERE la.finance_unit_id = ANY(scope) (empty → empty);
// DIVERGENCE: a superuser-not-auditor sees ALL (scopedFinanceUnitIds see-all branch).

import { describe, it, expect } from 'vitest'
import { listBookings, type ScopeContext } from '../src/store/index.ts'
import type { Sql } from '../src/tenant-store.ts'

const AUDITOR: ScopeContext = { isAuditor: true, isSuperuser: false, scopedOrgUnitIds: [] }
const OU_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OU_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const BK_ROW = {
  id: '5', ledger_account_id: '10', budget_titel_id: '100', amount_cents: '4200',
  booking_date: new Date('2026-03-01T00:00:00.000Z'), payment_type: 'bargeldlos', state: 'posted',
  la_name: 'Hauptkasse', titel_name: 'Beiträge',
}

/** Auditor-path fake: tagged template is unused (auditor short-circuits before
 *  scopedFinanceUnitIds), so only .unsafe fires (list + count). Records every
 *  unsafe call so a test can assert the exact bound-arg vector. */
function unsafeFake(listRows: Array<Record<string, unknown>>, total: number) {
  const calls: Array<{ q: string; params: unknown[] }> = []
  const fn = (() => Promise.resolve([])) as unknown as Sql & {
    unsafe: (q: string, p: unknown[]) => Promise<unknown[]>
  }
  fn.unsafe = (q: string, params: unknown[]) => {
    const norm = q.replace(/\s+/g, ' ').trim()
    calls.push({ q: norm, params })
    return Promise.resolve(/COUNT/.test(norm) ? [{ c: total }] : listRows)
  }
  return { fn: fn as unknown as Sql, calls }
}
const listCall = (calls: Array<{ q: string; params: unknown[] }>) => calls.find((c) => !/COUNT/.test(c.q))!

describe('booking store — listBookings DTO + pagination meta (auditor path)', () => {
  it('maps a row to the Booking DTO (account_id=ledger, date=YYYY-MM-DD, empf_name=titel, zweck=ledger, saldo 0, empf_iban "")', async () => {
    const { fn } = unsafeFake([BK_ROW], 1)
    const res = await listBookings(fn, {}, AUDITOR)
    expect(res.data[0]).toEqual({
      id: 5, account_id: 10, date: '2026-03-01', valuta: '2026-03-01', type: 'bargeldlos',
      empf_name: 'Beiträge', empf_iban: '', value: 4200, saldo: 0, zweck: 'Hauptkasse',
    })
  })

  it('computes meta (per_page=50, last_page=ceil(total/50))', async () => {
    const { fn } = unsafeFake([BK_ROW], 120)
    const res = await listBookings(fn, {}, AUDITOR)
    expect(res.meta).toEqual({ current_page: 1, last_page: 3, per_page: 50, total: 120 })
  })

  it('a non-numeric/absent page clamps to page 1 (offset 0 — never OFFSET NaN)', async () => {
    for (const page of [undefined, Number('abc')]) {
      const { fn, calls } = unsafeFake([], 0)
      const res = await listBookings(fn, { page }, AUDITOR)
      expect(res.meta.current_page).toBe(1)
      // LIMIT/OFFSET are the last two bound args; offset must be 0, not NaN.
      expect(listCall(calls).params).toEqual([50, 0])
    }
  })
})

describe('booking store — listBookings filter combos drive the bound-arg vector (auditor path)', () => {
  it('no filters → args [50, 0], empty WHERE', async () => {
    const { fn, calls } = unsafeFake([], 0)
    await listBookings(fn, {}, AUDITOR)
    const c = listCall(calls)
    expect(c.params).toEqual([50, 0])
    expect(/WHERE/.test(c.q)).toBe(false)
  })

  it('account_id → args [7, 50, 0] with a ledger_account_id predicate', async () => {
    const { fn, calls } = unsafeFake([], 0)
    await listBookings(fn, { account_id: 7 }, AUDITOR)
    const c = listCall(calls)
    expect(c.params).toEqual([7, 50, 0])
    expect(c.q).toMatch(/b\.ledger_account_id = \$1/)
    expect(c.q).toMatch(/LIMIT \$2 OFFSET \$3/)
  })

  it('date range → args [from, to, 50, 0] with >= / <= predicates', async () => {
    const { fn, calls } = unsafeFake([], 0)
    await listBookings(fn, { date_from: '2026-01-01', date_to: '2026-12-31' }, AUDITOR)
    const c = listCall(calls)
    expect(c.params).toEqual(['2026-01-01', '2026-12-31', 50, 0])
    expect(c.q).toMatch(/b\.booking_date >= \$1/)
    expect(c.q).toMatch(/b\.booking_date <= \$2/)
  })

  it('account_id + date range → args [account, from, to, 50, 0]', async () => {
    const { fn, calls } = unsafeFake([], 0)
    await listBookings(fn, { account_id: 7, date_from: '2026-01-01', date_to: '2026-12-31' }, AUDITOR)
    expect(listCall(calls).params).toEqual([7, '2026-01-01', '2026-12-31', 50, 0])
  })
})

// ── scope fixtures: two org units, one booking each (via ledger→finance_unit) ──
const OU_BY_FU: Record<string, string> = { '10': OU_A, '20': OU_B }
const BK_A = { ...BK_ROW, id: '1', ledger_account_id: '10', booking_date: new Date('2026-03-01T00:00:00.000Z'), la_name: 'LA A', titel_name: 'Titel A', _fu: '10' }
const BK_B = { ...BK_ROW, id: '2', ledger_account_id: '20', booking_date: new Date('2026-02-01T00:00:00.000Z'), la_name: 'LA B', titel_name: 'Titel B', _fu: '20' }
const ALL_BK = [BK_A, BK_B]

/** Scope-aware fake exposing BOTH the tagged-template (scopedFinanceUnitIds resolves
 *  the actor's finance_unit ids) AND .unsafe (list/count honouring the forwarded fu
 *  scope in params[0]). Records both channels. */
function scopeFakeSql() {
  const tagged: Array<{ q: string; values: unknown[] }> = []
  const unsafe: Array<{ q: string; params: unknown[] }> = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    tagged.push({ q, values })
    if (/FROM finance\.finance_unit/.test(q)) {
      if (/WHERE org_unit_id = ANY/.test(q)) {
        const scope = (values[values.length - 1] ?? []) as string[]
        return Promise.resolve(Object.entries(OU_BY_FU).filter(([, ou]) => scope.includes(ou)).map(([fu]) => ({ id: fu })))
      }
      return Promise.resolve(Object.keys(OU_BY_FU).map((fu) => ({ id: fu }))) // see-all → all fu ids
    }
    return Promise.resolve([])
  }) as unknown as Sql & { unsafe: (q: string, p: unknown[]) => Promise<unknown[]> }
  fn.unsafe = (q: string, params: unknown[]) => {
    const norm = q.replace(/\s+/g, ' ').trim()
    unsafe.push({ q: norm, params })
    const scopeArg = Array.isArray(params[0]) ? (params[0] as number[]) : null
    const filtered = scopeArg ? ALL_BK.filter((b) => scopeArg.includes(Number(b._fu))) : ALL_BK
    if (/COUNT/.test(norm)) return Promise.resolve([{ c: filtered.length }])
    const sorted = [...filtered].sort((a, b) => (b.booking_date.getTime() - a.booking_date.getTime()) || (Number(b.id) - Number(a.id)))
    return Promise.resolve(sorted)
  }
  return { fn: fn as unknown as Sql, tagged, unsafe }
}

describe('booking store — listBookings row-scoping (Lane B, four lenses + divergence)', () => {
  it('auditor sees ALL bookings (no finance-unit scope arg), sorted booking_date DESC', async () => {
    const { fn, tagged, unsafe } = scopeFakeSql()
    const res = await listBookings(fn, {}, AUDITOR)
    expect(res.data.map((b) => b.id)).toEqual([1, 2]) // 03-01 before 02-01
    expect(res.meta.total).toBe(2)
    expect(tagged.length).toBe(0) // auditor short-circuits scopedFinanceUnitIds
    expect(Array.isArray(unsafe[0]!.params[0])).toBe(false) // no leading scope array
  })

  it('scoped non-auditor sees ONLY its org-unit bookings (WHERE la.finance_unit_id = ANY(scope))', async () => {
    const { fn, unsafe } = scopeFakeSql()
    const scoped: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [OU_A] }
    const res = await listBookings(fn, {}, scoped)
    expect(res.data.map((b) => b.id)).toEqual([1]) // only OU_A's booking
    expect(res.meta.total).toBe(1)
    expect(unsafe[0]!.params[0]).toEqual([10]) // the forwarded fu-id scope
  })

  it('empty scope + not see-all → empty page WITHOUT any query (short-circuit)', async () => {
    const { fn, tagged, unsafe } = scopeFakeSql()
    const empty: ScopeContext = { isAuditor: false, isSuperuser: false, scopedOrgUnitIds: [] }
    const res = await listBookings(fn, {}, empty)
    expect(res.data).toEqual([])
    expect(res.meta).toEqual({ current_page: 1, last_page: 1, per_page: 50, total: 0 })
    expect(tagged.length).toBe(0)
    expect(unsafe.length).toBe(0)
  })

  it('DIVERGENCE: superuser-not-auditor SEES ALL bookings (see-all finance_unit branch)', async () => {
    const { fn, tagged, unsafe } = scopeFakeSql()
    const superuser: ScopeContext = { isAuditor: false, isSuperuser: true, scopedOrgUnitIds: [OU_A] }
    const res = await listBookings(fn, {}, superuser)
    expect(res.data.map((b) => b.id)).toEqual([1, 2]) // both, not just OU_A
    expect(res.meta.total).toBe(2)
    const fuCall = tagged.find((c) => /FROM finance\.finance_unit/.test(c.q))!
    expect(/WHERE org_unit_id = ANY/.test(fuCall.q)).toBe(false) // see-all branch
    expect(unsafe[0]!.params[0]).toEqual([10, 20]) // all fu ids forwarded to the filter
  })
})
