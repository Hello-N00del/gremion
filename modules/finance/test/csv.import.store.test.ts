// test/csv.import.store.test.ts — mocked-PG unit test for the CSV import service
// (#383 Lane E3, R11). Mirrors the native pipeline (dto-adapter.csvImport →
// BankServiceImpl.importCsv → csv-import.ts): bank-account existence gate (404),
// Papa header-parse → unparse ';' → parseCsv, per-row insert inside ONE transaction,
// ON CONFLICT DO NOTHING dedup (insert returns [] → skipped), error aggregation.

import { describe, it, expect } from 'vitest'
import { importCsv, BankAccountNotFoundError } from '../src/csv/import.ts'
import { computeImportHash } from '../src/bank/import-hash.ts'
import type { CsvMapping } from '../src/csv/parser.ts'
import type { Sql } from '../src/tenant-store.ts'

const MAPPING: CsvMapping = {
  bookingDate: 0, valutaDate: null, counterpartyName: 1, counterpartyIban: null,
  amountCents: 2, saldoCents: null, purpose: 3, bankReference: 4,
}

const CSV = [
  'Buchungstag;Name;Betrag;Zweck;Referenz',
  '01.05.2026;Acme GmbH;-123,45;Beitrag Mai;REF-1',
  '02.05.2026;Uni Kasse;500,00;Zuschuss;REF-2',
].join('\n')

/** Query-aware fake: routes the existence check + the INSERT..ON CONFLICT to a
 *  scripted fixture; sql.begin runs the callback with the same fake (transaction
 *  passthrough). Records every issued query + bound values. */
function fakeSql(opts: { accountExists: boolean; duplicateRefs?: Set<string> }) {
  const calls: Array<{ q: string; values: unknown[] }> = []
  const inserts: unknown[][] = []
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim()
    calls.push({ q, values })
    if (/FROM finance\.bank_account WHERE id/.test(q)) {
      return Promise.resolve(opts.accountExists ? [{ id: String(values[0]) }] : [])
    }
    if (/INSERT INTO finance\.bank_transaction/.test(q)) {
      const bankReference = values[8] as string | null
      if (bankReference !== null && opts.duplicateRefs?.has(bankReference)) {
        return Promise.resolve([]) // ON CONFLICT DO NOTHING → no row returned
      }
      inserts.push(values)
      return Promise.resolve([{ id: String(inserts.length) }])
    }
    return Promise.resolve([])
  }) as unknown as Sql & { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }
  fn.begin = (async (cb: (tx: unknown) => unknown) => cb(fn)) as never
  return { fn: fn as Sql, calls, inserts }
}

describe('csv import service — importCsv', () => {
  it('throws BankAccountNotFoundError (→ route 404) when the account is absent', async () => {
    const { fn } = fakeSql({ accountExists: false })
    await expect(importCsv(fn, 999, CSV, MAPPING, false)).rejects.toBeInstanceOf(BankAccountNotFoundError)
    await expect(importCsv(fn, 999, CSV, MAPPING, false)).rejects.toThrow('bank_account#999 not found')
  })

  it('imports every parsed row with the FULL canonical column set + computed import_hash', async () => {
    const { fn, inserts } = fakeSql({ accountExists: true })
    const res = await importCsv(fn, 5, CSV, MAPPING, false)
    expect(res).toEqual({ imported: 2, skipped: 0, errors: [] })
    expect(inserts).toHaveLength(2)
    // INSERT bind order: account, bookingDate, valuta, name, iban, amount, saldo, purpose, ref, hash
    const first = inserts[0]!
    expect(first[0]).toBe(5)
    expect(first[1]).toBe('2026-05-01')
    expect(first[3]).toBe('Acme GmbH')
    expect(first[5]).toBe(-12345)
    expect(first[7]).toBe('Beitrag Mai')
    expect(first[8]).toBe('REF-1')
    expect(first[9]).toBe(
      computeImportHash({
        bookingDate: '2026-05-01', valutaDate: null, counterpartyName: 'Acme GmbH',
        counterpartyIban: null, amountCents: -12345, saldoCents: null,
        purpose: 'Beitrag Mai', bankReference: 'REF-1',
      }),
    )
  })

  it('counts an ON CONFLICT no-op as skipped (dedup — not an error)', async () => {
    const { fn } = fakeSql({ accountExists: true, duplicateRefs: new Set(['REF-1']) })
    const res = await importCsv(fn, 5, CSV, MAPPING, false)
    expect(res).toEqual({ imported: 1, skipped: 1, errors: [] })
  })

  it('collects per-row parse errors while importing the valid rows', async () => {
    const broken = [
      'Buchungstag;Name;Betrag;Zweck;Referenz',
      '01.05.2026;Acme;-123,45;ok;R1',
      'NODATE;Bad;-1,00;broken;R2',
    ].join('\n')
    const { fn } = fakeSql({ accountExists: true })
    const res = await importCsv(fn, 5, broken, MAPPING, false)
    expect(res.imported).toBe(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toMatch(/unparseable bookingDate/)
  })

  it('runs all inserts inside ONE sql.begin transaction', async () => {
    const { fn, calls } = fakeSql({ accountExists: true })
    let beginCount = 0
    const origBegin = (fn as Sql & { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }).begin
    ;(fn as Sql & { begin: typeof origBegin }).begin = (async (cb: (tx: unknown) => unknown) => {
      beginCount++
      return cb(fn)
    }) as never
    await importCsv(fn, 5, CSV, MAPPING, false)
    expect(beginCount).toBe(1)
    expect(calls.filter((c) => /INSERT INTO finance\.bank_transaction/.test(c.q))).toHaveLength(2)
  })

  it('csvOrderReversed=true inserts the oldest row first', async () => {
    const { fn, inserts } = fakeSql({ accountExists: true })
    await importCsv(fn, 5, CSV, MAPPING, true)
    expect(inserts[0]![1]).toBe('2026-05-02') // last CSV row first
    expect(inserts[1]![1]).toBe('2026-05-01')
  })
})
