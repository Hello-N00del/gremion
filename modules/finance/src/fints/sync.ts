// services/finance/src/fints/sync.ts
// #383 Lane E3 — syncFints (leaf side). Ported from the native oracle
// gremion-ui/.../services/money/fints-sync.ts. Pulls statements from the bank via the
// FintsClient seam, decrypts the stored password at sync time, persists rows via the
// shared insertBankTransaction helper, and records fints_config.last_sync_status.
//
// G-019b ZKA POSTURE: with FINTS_PRODUCT_ID unset, ProdFintsClient.getStatements()
// throws inside the try below — caught, recorded (last_sync_status='failed',
// last_sync_error=<msg>), and the op returns { imported:0, skipped:0, errors:[msg] }.
// This is IDENTICAL to the native oracle's unconfigured behaviour, so syncFints is
// LIVE (answers identically to native-unconfigured) while live FinTS sync stays ZKA-
// gated in both modes.
//
// Structure vs native: the config/bank existence checks throw typed NotFound errors
// (route → 404) exactly like native; the credential decrypt + fetch + persist run
// INSIDE the try/catch so ANY sync-attempt failure is recorded as a failed sync
// (rather than an unhandled 500) — a superset of the native's recorded-failure path.
import type { Sql } from '../tenant-store.js'
import type { ImportResult } from '../bank/types.js'
import { insertBankTransaction } from '../bank/transactions.js'
import { decryptFintsPassword } from './crypto.js'
import { ProdFintsClient, type FintsClient } from './client.js'

const DEFAULT_BACKFILL_DAYS = 90

/** Thrown when the fints_config / bank_account is missing (route → 404). */
export class FintsSyncNotFoundError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'FintsSyncNotFoundError'
  }
}

interface FintsConfigSyncRow {
  id: string
  fints_url: string
  bank_code: string
  username: string
  password_encrypted: string
  last_sync_at: Date | null
}

export async function syncFints(
  sql: Sql,
  bankAccountId: number,
  fints: FintsClient = new ProdFintsClient(),
): Promise<ImportResult> {
  const cfgRows = await sql<FintsConfigSyncRow[]>`
    SELECT id, fints_url, bank_code, username, password_encrypted, last_sync_at
    FROM finance.fints_config WHERE bank_account_id = ${bankAccountId}`
  if (cfgRows.length === 0) {
    throw new FintsSyncNotFoundError(`fints_config for bank_account#${bankAccountId} missing`)
  }
  const cfg = cfgRows[0]!

  const bankRows = await sql<{ iban: string }[]>`
    SELECT iban FROM finance.bank_account WHERE id = ${bankAccountId}`
  if (bankRows.length === 0) {
    throw new FintsSyncNotFoundError(`bank_account#${bankAccountId} not found`)
  }
  const bank = bankRows[0]!

  const today = new Date().toISOString().slice(0, 10)
  const lastSync = cfg.last_sync_at
    ? new Date(cfg.last_sync_at).toISOString().slice(0, 10)
    : new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 86400_000).toISOString().slice(0, 10)

  let imported = 0
  let skipped = 0
  const errors: string[] = []
  try {
    const password = decryptFintsPassword(cfg.password_encrypted)
    const { statements } = await fints.getStatements({
      fintsUrl: cfg.fints_url,
      bankCode: cfg.bank_code,
      username: cfg.username,
      password,
      iban: bank.iban,
      fromDate: lastSync,
      toDate: today,
    })
    await sql.begin(async (tx) => {
      for (const row of statements) {
        const ok = await insertBankTransaction(tx as unknown as Sql, bankAccountId, row)
        if (ok) imported++
        else skipped++
      }
    })
    await sql`
      UPDATE finance.fints_config
      SET last_sync_at = now(), last_sync_status = 'ok', last_sync_error = NULL
      WHERE id = ${cfg.id}`
  } catch (e) {
    const msg = (e as Error).message
    errors.push(msg)
    // F1-FIX-05-K (K4#13): a failed attempt must NOT advance last_sync_at -- the next
    // sync computes fromDate from it, so advancing it skipped the unfetched window for
    // good. Only the status and the error are recorded; dedup is by import hash, so
    // re-fetching the window on the next success is safe.
    await sql`
      UPDATE finance.fints_config
      SET last_sync_status = 'failed', last_sync_error = ${msg}
      WHERE id = ${cfg.id}`
  }
  return { imported, skipped, errors }
}
