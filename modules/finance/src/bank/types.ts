// services/finance/src/bank/types.ts
// #383 Lane E3 — canonical pre-insert bank-statement row + import result. Ported
// verbatim from the native oracle gremion-ui/.../services/money/types.ts. Both the CSV
// parser (csv/parser.ts) and the FinTS sync (fints/sync.ts) produce BankStatementRow.
//
// Money is integer euro-cents end-to-end (BIGINT in PG; `number` here after the
// boundary cast). Dates are ISO strings — never Date objects — so the dedup hash is
// stable across timezones.

export interface BankStatementRow {
  /** ISO 'YYYY-MM-DD'. The day the bank booked the line. */
  readonly bookingDate: string
  /** ISO 'YYYY-MM-DD' or null. Settlement day (Valuta). */
  readonly valutaDate: string | null
  /** Counterparty display name; null for some Sparkasse exports. */
  readonly counterpartyName: string | null
  /** Pre-validated (mod-97) IBAN of the counterparty; null when absent. */
  readonly counterpartyIban: string | null
  /** Signed euro-cents (-debit / +credit). Bigint-compatible. */
  readonly amountCents: number
  /** Saldo after this transaction, in euro-cents. null when not provided. */
  readonly saldoCents: number | null
  /** Verwendungszweck / remittance text. null when absent. */
  readonly purpose: string | null
  /** Bank's End-to-End / customer reference. Primary dedup key when present. */
  readonly bankReference: string | null
}

export interface ImportResult {
  imported: number
  skipped: number
  errors: readonly string[]
}
