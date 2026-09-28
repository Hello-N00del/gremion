// services/finance/src/csv/parser.ts
// #383 Lane E3 — column-mapping CSV parser. Ported verbatim from the native oracle
// gremion-ui/.../services/money/csv-parser.ts so the leaf and the native oracle produce
// identical BankStatementRow[] + per-row error strings for the same input.
//
// Bank-export idiosyncrasies handled:
//   - Sparkasse `;` separator vs GLS `,` (auto-detected via the header line).
//   - German `DD.MM.YYYY` dates vs ISO `YYYY-MM-DD`.
//   - German `-1.234,56` amounts vs dot-decimal `-1234.56`.
//   - Trailing whitespace stripped at the canonical-row construction step.
//   - Per-row errors are collected + returned; only structural failures throw.
import Papa from 'papaparse'
import type { BankStatementRow } from '../bank/types.js'
import { CsvMappingError, CsvParseError } from './errors.js'
import { normaliseIban, validateIban } from './iban.js'

export interface CsvMapping {
  bookingDate: number | null
  valutaDate: number | null
  counterpartyName: number | null
  counterpartyIban: number | null
  amountCents: number | null
  saldoCents: number | null
  purpose: number | null
  bankReference: number | null
}

/** Choose the delimiter that dominates the header line. Tabs win over semis and
 *  commas when present; otherwise prefer `;` (Sparkasse / GLS German) over `,`. */
export function detectSeparator(csv: string): ';' | ',' | '\t' {
  const header = csv.split(/\r?\n/, 1)[0] ?? ''
  const semis = (header.match(/;/g) ?? []).length
  const commas = (header.match(/,/g) ?? []).length
  const tabs = (header.match(/\t/g) ?? []).length
  if (tabs > semis && tabs > commas) return '\t'
  return semis >= commas ? ';' : ','
}

/** Accept ISO `YYYY-MM-DD` and German `DD.MM.YYYY`. Returns null on unrecognised
 *  input so the caller reports a per-row error. */
function parseGermanOrIsoDate(raw: string): string | null {
  const t = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t)
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  return null
}

/** Parse a German or dot-decimal amount string to integer euro-cents. Returns null
 *  on unparseable input. */
function parseAmountCents(raw: string): number | null {
  const t = raw.trim().replace(/ /g, '')
  if (t.length === 0) return null
  const lastComma = t.lastIndexOf(',')
  const lastDot = t.lastIndexOf('.')
  let normalised: string
  if (lastComma > lastDot) {
    // German: '.' = thousands separator, ',' = decimal point.
    normalised = t.replace(/\./g, '').replace(',', '.')
  } else if (lastDot > lastComma) {
    // English: ',' = thousands separator, '.' = decimal point.
    normalised = t.replace(/,/g, '')
  } else {
    normalised = t
  }
  const num = Number(normalised)
  if (!Number.isFinite(num)) return null
  return Math.round(num * 100)
}

export function parseCsv(
  csv: string,
  mapping: CsvMapping,
  csvOrderReversed: boolean,
): { rows: BankStatementRow[]; errors: string[] } {
  if (mapping.bookingDate === null) {
    throw new CsvMappingError('bookingDate column must be mapped')
  }
  if (mapping.amountCents === null) {
    throw new CsvMappingError('amountCents column must be mapped')
  }
  const sep = detectSeparator(csv)
  const parsed = Papa.parse<string[]>(csv, {
    delimiter: sep,
    skipEmptyLines: true,
    header: false,
  })
  if (parsed.errors.length > 0) {
    throw new CsvParseError(parsed.errors.map((e) => e.message).join('; '))
  }
  const rows: BankStatementRow[] = []
  const errors: string[] = []
  for (let i = 1; i < parsed.data.length; i++) {
    const cols = parsed.data[i]!
    // 1-based row number for human-friendly error messages (header = row 1).
    const rowLabel = i + 1
    const rawBookingDate = cols[mapping.bookingDate] ?? ''
    const bookingDate = parseGermanOrIsoDate(rawBookingDate)
    if (bookingDate === null) {
      errors.push(`row ${rowLabel}: unparseable bookingDate "${rawBookingDate}"`)
      continue
    }
    const rawAmount = cols[mapping.amountCents] ?? ''
    const amountCents = parseAmountCents(rawAmount)
    if (amountCents === null) {
      errors.push(`row ${rowLabel}: unparseable amount "${rawAmount}"`)
      continue
    }
    const valutaDate =
      mapping.valutaDate === null ? null : parseGermanOrIsoDate(cols[mapping.valutaDate] ?? '')
    const rawIban =
      mapping.counterpartyIban === null ? null : cols[mapping.counterpartyIban]?.trim() || null
    let counterpartyIban: string | null = null
    if (rawIban !== null) {
      const normalised = normaliseIban(rawIban)
      if (!validateIban(normalised)) {
        errors.push(`row ${rowLabel}: invalid IBAN "${rawIban}"`)
        continue
      }
      counterpartyIban = normalised
    }
    rows.push({
      bookingDate,
      valutaDate,
      counterpartyName:
        mapping.counterpartyName === null ? null : cols[mapping.counterpartyName]?.trim() || null,
      counterpartyIban,
      amountCents,
      saldoCents: mapping.saldoCents === null ? null : parseAmountCents(cols[mapping.saldoCents] ?? ''),
      purpose: mapping.purpose === null ? null : cols[mapping.purpose]?.trim() || null,
      bankReference:
        mapping.bankReference === null ? null : cols[mapping.bankReference]?.trim() || null,
    })
  }
  if (csvOrderReversed) rows.reverse()
  return { rows, errors }
}
