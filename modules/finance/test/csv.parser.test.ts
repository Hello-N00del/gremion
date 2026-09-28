// test/csv.parser.test.ts — unit tests for the ported CSV parser + import-hash
// (#383 Lane E3, R11). Mirrors the native oracle's csv-parser.test.ts +
// import-hash.test.ts: separator detection, German/ISO dates, German/dot-decimal
// amounts, mod-97 IBAN gate, per-row error collection vs structural throws, reverse
// order, and hash stability (whitespace-tolerant, null ≠ empty, 1-cent sensitivity).

import { describe, it, expect } from 'vitest'
import { parseCsv, detectSeparator, type CsvMapping } from '../src/csv/parser.ts'
import { CsvMappingError, CsvParseError } from '../src/csv/errors.ts'
import { normaliseIban, validateIban } from '../src/csv/iban.ts'
import { computeImportHash } from '../src/bank/import-hash.ts'
import type { BankStatementRow } from '../src/bank/types.ts'

const EMPTY_MAPPING: CsvMapping = {
  bookingDate: null, valutaDate: null, counterpartyName: null, counterpartyIban: null,
  amountCents: null, saldoCents: null, purpose: null, bankReference: null,
}

describe('csv parser — detectSeparator', () => {
  it('returns ";" when semicolons dominate the header', () => {
    expect(detectSeparator('a;b;c\n1;2;3')).toBe(';')
  })
  it('returns "," for comma-delimited exports', () => {
    expect(detectSeparator('a,b,c\n1,2,3')).toBe(',')
  })
  it('returns tab when tabs dominate', () => {
    expect(detectSeparator('a\tb\tc\n1\t2\t3')).toBe('\t')
  })
})

describe('csv parser — Sparkasse-style (German dates, ; separator, comma decimals)', () => {
  const csv = [
    'Buchungstag;Valuta;Name;IBAN;Betrag;Zweck;Referenz',
    '01.05.2026;02.05.2026;Acme GmbH;DE12500105170648489890;-123,45;Mitgliedsbeitrag Mai;NOTPROVIDED',
    '02.05.2026;02.05.2026;Uni Kasse;DE12500105170648489890;500,00;Zuschuss;E2E-ABCD-1234',
    '03.05.2026;;Kiosk;;-3,90;;',
  ].join('\n')
  const mapping: CsvMapping = {
    bookingDate: 0, valutaDate: 1, counterpartyName: 2, counterpartyIban: 3,
    amountCents: 4, purpose: 5, bankReference: 6, saldoCents: null,
  }

  it('parses 3 rows with German date + amount normalisation', () => {
    const { rows, errors } = parseCsv(csv, mapping, false)
    expect(errors).toHaveLength(0)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      bookingDate: '2026-05-01',
      valutaDate: '2026-05-02',
      counterpartyName: 'Acme GmbH',
      counterpartyIban: 'DE12500105170648489890',
      amountCents: -12345,
      saldoCents: null,
      purpose: 'Mitgliedsbeitrag Mai',
      bankReference: 'NOTPROVIDED',
    })
    expect(rows[1]!.amountCents).toBe(50000)
    expect(rows[2]!.amountCents).toBe(-390)
    expect(rows[2]!.valutaDate).toBeNull() // empty valuta cell → null
    expect(rows[2]!.counterpartyIban).toBeNull() // empty IBAN cell → null (not an error)
  })

  it('csvOrderReversed=true reverses output order (oldest first)', () => {
    const normal = parseCsv(csv, mapping, false)
    const reversed = parseCsv(csv, mapping, true)
    expect(reversed.rows[0]).toEqual(normal.rows[2])
    expect(reversed.rows[2]).toEqual(normal.rows[0])
  })

  it('parses German thousands separators (-1.234,56 → -123456)', () => {
    const one = 'Datum;Betrag\n01.05.2026;-1.234,56'
    const m: CsvMapping = { ...EMPTY_MAPPING, bookingDate: 0, amountCents: 1 }
    expect(parseCsv(one, m, false).rows[0]!.amountCents).toBe(-123456)
  })
})

describe('csv parser — GLS-style (ISO dates, comma separator, dot decimals)', () => {
  it('parses dot-decimal amounts under a comma separator', () => {
    const csv = ['Date,Amount,Reference', '2026-05-01,-123.45,E2E-1', '2026-05-02,1250.00,E2E-2'].join('\n')
    const m: CsvMapping = { ...EMPTY_MAPPING, bookingDate: 0, amountCents: 1, bankReference: 2 }
    const { rows, errors } = parseCsv(csv, m, false)
    expect(errors).toHaveLength(0)
    expect(rows.map((r) => r.amountCents)).toEqual([-12345, 125000])
    expect(rows[0]!.bookingDate).toBe('2026-05-01')
  })

  it('parses English thousands separators (1,234.56 → 123456)', () => {
    const csv = 'Date\tAmount\n2026-05-01\t1,234.56'
    const m: CsvMapping = { ...EMPTY_MAPPING, bookingDate: 0, amountCents: 1 }
    expect(parseCsv(csv, m, false).rows[0]!.amountCents).toBe(123456)
  })
})

describe('csv parser — error paths (native error-shape parity)', () => {
  it('reports a per-row error for an unparseable amount, keeps the rest', () => {
    const broken = [
      'Buchungstag;Valuta;Betrag',
      '01.05.2026;01.05.2026;-123,45',
      '02.05.2026;02.05.2026;NOTANUMBER',
      '03.05.2026;03.05.2026;500,00',
    ].join('\n')
    const m: CsvMapping = { ...EMPTY_MAPPING, bookingDate: 0, valutaDate: 1, amountCents: 2 }
    const { rows, errors } = parseCsv(broken, m, false)
    expect(rows).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('row 3: unparseable amount "NOTANUMBER"') // exact native shape
  })

  it('reports a per-row error for an unparseable bookingDate', () => {
    const broken = 'Datum;Betrag\nNODATE;-1,00'
    const m: CsvMapping = { ...EMPTY_MAPPING, bookingDate: 0, amountCents: 1 }
    const { rows, errors } = parseCsv(broken, m, false)
    expect(rows).toHaveLength(0)
    expect(errors[0]).toBe('row 2: unparseable bookingDate "NODATE"')
  })

  it('throws CsvMappingError when bookingDate is unmapped (structural)', () => {
    const m: CsvMapping = { ...EMPTY_MAPPING, amountCents: 0 }
    expect(() => parseCsv('Betrag\n-1,00\n', m, false)).toThrow(CsvMappingError)
    expect(() => parseCsv('Betrag\n-1,00\n', m, false)).toThrow(/bookingDate column must be mapped/)
  })

  it('throws CsvMappingError when amountCents is unmapped (structural)', () => {
    const m: CsvMapping = { ...EMPTY_MAPPING, bookingDate: 0 }
    expect(() => parseCsv('Datum\n01.05.2026\n', m, false)).toThrow(CsvMappingError)
  })

  it('reports a per-row error when the IBAN fails mod-97, keeps other rows', () => {
    const broken = [
      'Buchungstag;IBAN;Betrag',
      '01.05.2026;DE12500105170648489890;-100,00',
      '02.05.2026;DE00000000000000000001;-200,00',
    ].join('\n')
    const m: CsvMapping = { ...EMPTY_MAPPING, bookingDate: 0, counterpartyIban: 1, amountCents: 2 }
    const { rows, errors } = parseCsv(broken, m, false)
    expect(rows).toHaveLength(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/invalid IBAN/)
  })

  it('CsvParseError carries the native message prefix', () => {
    expect(new CsvParseError('boom').message).toBe('CSV parse error: boom')
    expect(new CsvMappingError('boom').message).toBe('CSV mapping error: boom')
  })
})

describe('csv iban — mod-97', () => {
  it('accepts a valid DE IBAN (with spaces, via normalise)', () => {
    expect(validateIban(normaliseIban('DE12 5001 0517 0648 4898 90'))).toBe(true)
  })
  it('rejects a checksum-broken IBAN', () => {
    expect(validateIban('DE00000000000000000001')).toBe(false)
  })
})

const HASH_ROW: BankStatementRow = {
  bookingDate: '2026-05-01', valutaDate: '2026-05-02', counterpartyName: 'Acme GmbH',
  counterpartyIban: 'DE12500105170648489890', amountCents: -12345, saldoCents: 100000,
  purpose: 'Mitgliedsbeitrag  Mai', bankReference: null,
}

describe('bank import-hash — dedup stability (native parity)', () => {
  it('is deterministic and returns 64-char hex', () => {
    const h = computeImportHash(HASH_ROW)
    expect(h).toBe(computeImportHash({ ...HASH_ROW }))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })
  it('is whitespace-tolerant on purpose (collapse + trim)', () => {
    expect(computeImportHash({ ...HASH_ROW, purpose: ' Mitgliedsbeitrag Mai ' })).toBe(computeImportHash(HASH_ROW))
  })
  it('differs by 1 cent', () => {
    expect(computeImportHash({ ...HASH_ROW, amountCents: -12346 })).not.toBe(computeImportHash(HASH_ROW))
  })
  it('null vs empty-string purpose do NOT collide', () => {
    expect(computeImportHash({ ...HASH_ROW, purpose: null })).not.toBe(computeImportHash({ ...HASH_ROW, purpose: '' }))
  })
  it('differs when saldoCents differs (null vs value)', () => {
    expect(computeImportHash({ ...HASH_ROW, saldoCents: null })).not.toBe(computeImportHash(HASH_ROW))
  })
})
