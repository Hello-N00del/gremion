// services/finance/src/csv/import.ts
// #383 Lane E3 — CSV bank-statement import service (leaf side of the csvImport op).
//
// Faithful port of the native two-step pipeline:
//   native dto-adapter.csvImport(file, mapping, reversed):
//     fileToRows: Papa.parse(text, { header:true, skipEmptyLines:true, delimiter:'' })
//       → Record<string,string>[]   (auto-delimiter; first row = header keys)
//   native csv-import.importCsv(rows, mapping, reversed):
//     Papa.unparse(records, { delimiter:';' }) → parseCsv(csv, mapping, reversed)
//       → BankStatementRow[]         (column mapping is by ORIGINAL column INDEX,
//                                     preserved through the object-key round-trip)
//     for each row: insertBankTransaction (ON CONFLICT DO NOTHING dedup)
//
// The ACL client posts the raw CSV File (multipart) + the mapping (JSON) +
// csv_order_reversed — the leaf reads the file part's UTF-8 text and runs the SAME
// two steps, so imported/skipped/errors match the native oracle byte-for-byte.
import Papa from 'papaparse'
import type { Sql } from '../tenant-store.js'
import type { BankStatementRow, ImportResult } from '../bank/types.js'
import { insertBankTransaction } from '../bank/transactions.js'
import { parseCsv, type CsvMapping } from './parser.js'

/** Thrown when the target bank account does not exist (route → 404). Mirrors the
 *  native `bank_account#<id> not found` throw. */
export class BankAccountNotFoundError extends Error {
  constructor(bankAccountId: number) {
    super(`bank_account#${bankAccountId} not found`)
    this.name = 'BankAccountNotFoundError'
  }
}

/** Step 1 (native fileToRows): CSV text → Record<string,string>[] via Papa's
 *  header-mode auto-delimiter parse. */
function textToRecords(csvText: string): Record<string, string>[] {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    delimiter: '',
  })
  return parsed.data
}

/** Step 2 (native recordsToStatementRows): re-serialise with `;` then hand to the
 *  single source of truth (parseCsv) for date/number/IBAN normalisation. */
function recordsToStatementRows(
  records: ReadonlyArray<Record<string, string>>,
  mapping: CsvMapping,
  csvOrderReversed: boolean,
): { rows: BankStatementRow[]; errors: string[] } {
  const csv = Papa.unparse(records as Record<string, string>[], { delimiter: ';' })
  return parseCsv(csv, mapping, csvOrderReversed)
}

async function bankAccountExists(sql: Sql, bankAccountId: number): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM finance.bank_account WHERE id = ${bankAccountId}`
  return rows.length === 1
}

/**
 * Import a bank-statement CSV (raw text) into finance.bank_transaction. Structural
 * failures (missing bookingDate/amountCents mapping, malformed CSV) throw from
 * parseCsv; per-row failures are collected into errors[]. Duplicate rows are skipped
 * at the schema level (ON CONFLICT DO NOTHING).
 */
export async function importCsv(
  sql: Sql,
  bankAccountId: number,
  csvText: string,
  mapping: CsvMapping,
  csvOrderReversed: boolean,
): Promise<ImportResult> {
  if (!(await bankAccountExists(sql, bankAccountId))) {
    throw new BankAccountNotFoundError(bankAccountId)
  }
  const records = textToRecords(csvText)
  const { rows, errors } = recordsToStatementRows(records, mapping, csvOrderReversed)
  let imported = 0
  let skipped = 0
  await sql.begin(async (tx) => {
    for (const row of rows) {
      const ok = await insertBankTransaction(tx as unknown as Sql, bankAccountId, row)
      if (ok) imported++
      else skipped++
    }
  })
  return { imported, skipped, errors }
}
