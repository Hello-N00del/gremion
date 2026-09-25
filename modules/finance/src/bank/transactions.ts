// services/finance/src/bank/transactions.ts
// #383 Lane E3 — insert one canonical bank_transaction row, shared by the CSV import
// (csv/import.ts) and the FinTS sync (fints/sync.ts). Ported from the native oracle
// gremion-ui/.../services/money/csv-import.ts#insertBankTransaction.
//
// Routes ingestion through a SINGLE INSERT ... ON CONFLICT DO NOTHING per row, so the
// two UNIQUE branches — bank_transaction(bank_reference) and the partial
// bank_transaction_import_hash_per_account_idx (WHERE bank_reference IS NULL) — both
// dedup at the schema level and concurrent importers can't race past each other.
import type { Sql } from '../tenant-store.js'
import type { BankStatementRow } from './types.js'
import { computeImportHash } from './import-hash.js'

/** A postgres-js query runner — the pool OR a transaction handle (both are callable
 *  tagged templates). insertBankTransaction is called inside sql.begin() so the whole
 *  import loop is one transaction (native withTransaction parity). */
export type Runner = Sql

/** Insert one canonical statement row; returns true on insert, false on dedup-skip. */
export async function insertBankTransaction(
  runner: Runner,
  bankAccountId: number,
  row: BankStatementRow,
): Promise<boolean> {
  const importHash = computeImportHash(row)
  const inserted = await runner<{ id: string }[]>`
    INSERT INTO finance.bank_transaction (
      bank_account_id, booking_date, valuta_date,
      counterparty_name, counterparty_iban,
      amount_cents, saldo_cents, purpose,
      bank_reference, import_hash
    ) VALUES (
      ${bankAccountId}, ${row.bookingDate}, ${row.valutaDate},
      ${row.counterpartyName}, ${row.counterpartyIban},
      ${row.amountCents}, ${row.saldoCents}, ${row.purpose},
      ${row.bankReference}, ${importHash}
    )
    ON CONFLICT DO NOTHING
    RETURNING id`
  return inserted.length === 1
}
