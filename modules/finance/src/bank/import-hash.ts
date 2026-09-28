// services/finance/src/bank/import-hash.ts
// #383 Lane E3 — content-hash dedup fallback for reference-less bank rows. Ported
// verbatim (byte-identical hash join) from the native oracle
// gremion-ui/.../services/money/import-hash.ts so a row imported by either the native
// path or the leaf produces the SAME import_hash — the partial UNIQUE index
// bank_transaction_import_hash_per_account_idx (migration 001, folded from 021)
// covers this branch at the schema level.
//
// Stability requirements:
//   - Determinism across processes: SHA-256 of the canonical join.
//   - Whitespace-tolerant on the purpose / counterparty fields.
//   - Null vs empty string must NOT collide (omitted column vs explicit blank).
import { createHash } from 'node:crypto'
import type { BankStatementRow } from './types.js'

/** Canonical normaliser for nullable string fields used in the hash join. Returns
 *  '\0' as the null sentinel so NULL and the string 'null' don't collide. Empty
 *  string normalises to '' (distinct from the null marker). */
function norm(s: string | null): string {
  if (s === null) return '\0'
  return s.replace(/\s+/g, ' ').trim()
}

export function computeImportHash(row: BankStatementRow): string {
  const parts = [
    row.bookingDate,
    norm(row.valutaDate),
    norm(row.counterpartyName),
    norm(row.counterpartyIban),
    row.amountCents.toString(),
    row.saldoCents === null ? '\0' : row.saldoCents.toString(),
    norm(row.purpose),
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}
